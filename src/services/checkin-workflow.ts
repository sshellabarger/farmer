import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import type { Env } from '../config/env.js';
import { nextAllowedInstant } from '../utils/quiet-hours.js';
import { wallClock, parseDate, weekdayOf, DAYS_OF_WEEK } from '../utils/tz.js';
import { toDate } from '../utils/dates.js';
import { marketDateFromData, reminderStateKey } from './market-dates.js';
import type { MarketDateDoc, MarketDateActions, ReminderSent } from './market-dates.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from './markets.js';
import type { FarmersMarket } from './markets.js';
import { mintCheckinToken, tokensForDate } from './link-tokens.js';
import type { LinkTokenDoc } from './link-tokens.js';
import { checkinUrl, staffForMarket } from './open-checkin.js';
import { trySendSms, isAlreadyExists, SendsDisabledError } from './sms.js';
import { sendEmail } from './email.js';

/**
 * The Phase 3 workflow engine (contract §3): check-in texts, reminders,
 * deadline flagging and the staff summary, all quiet-hours aware and
 * idempotent across overlapping 5-minute scheduler ticks.
 *
 * Concurrency (Phase 3 fix, rounds 1 and 2). Three things make overlapping
 * runs safe, and none is a read-then-write:
 *   1. every step takes an atomic lock — `workflow_locks/<date_id>__<key>`
 *      written with `DocumentReference.create()`, which fails with
 *      ALREADY_EXISTS when the doc is there (`claim()` below);
 *   2. every engine send carries a deterministic `dedupe_key`, so `sendSms`
 *      creates its `messages` row atomically and a second attempt is refused
 *      before the provider is called (`DuplicateSendError`);
 *   3. THE ENGINE NEVER WRITES THE `actions` MAP, ONLY FIELDS INSIDE IT
 *      (round 2). Every write names Firestore field paths —
 *      `'actions.checkin_sent_at'`, `'actions.claims.<key>'`,
 *      `'actions.reminder_state.offset_<n>'`, … — so two runs holding
 *      DIFFERENT step locks in the same tick, or the admin close (which takes
 *      no lock), write disjoint paths and the last writer cannot drop the
 *      other's outcome. Round 1 rewrote the whole map from the snapshot taken
 *      in `claim()`; that lost a concurrent run's "superseded" decision (and
 *      re-sent the reminder a tick later) and cleared a concurrent close's
 *      flags (and re-emailed the summary at the deadline). `claim()` no
 *      longer even hands a snapshot back, so no step can spread one.
 * The `actions.claims[key]` map on the market_date is still written for the
 * status page, but it is informational only — it is no longer the guard.
 */

export const SCAN_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * A lock older than this is presumed to belong to a run that died (the
 * function's own timeout is 300 s, so no live run can hold one this long)
 * and is taken over by the next tick.
 */
export const CLAIM_TTL_MS = 10 * 60_000;

/**
 * Deterministic at-most-once keys for every engine send (contract §2.4's
 * per-recipient dedupe, made atomic). ':' is the separator, so the keys are
 * injective only because no part can contain it: market slugs match
 * /^[a-z0-9][a-z0-9-]{1,31}$/ (src/services/markets.ts), a market_date id is
 * `<slug>_<YYYY-MM-DD>`, producer and user ids are uuid v4 (short
 * alphanumerics in tests) and an offset is an integer. `keyPart` makes that
 * guarantee explicit rather than assumed: a part containing ':' throws
 * instead of minting a key that another recipient's key could equal.
 */
function keyPart(value: string | number, what: string): string {
  const s = String(value);
  if (s.length === 0 || s.includes(':')) {
    throw new Error(`dedupe key part ${what} must be non-empty and contain no ':' (got ${JSON.stringify(s)})`);
  }
  return s;
}
export const DEDUPE_KEYS = {
  checkin_link: (marketDateId: string, producerId: string) =>
    `checkin_link:${keyPart(marketDateId, 'market_date_id')}:${keyPart(producerId, 'producer_id')}`,
  checkin_reminder: (marketDateId: string, producerId: string, offsetMin: number) =>
    `checkin_reminder:${keyPart(marketDateId, 'market_date_id')}:${keyPart(producerId, 'producer_id')}:${keyPart(offsetMin, 'offset_min')}`,
  deadline_summary: (marketDateId: string, userId: string) =>
    `deadline_summary:${keyPart(marketDateId, 'market_date_id')}:${keyPart(userId, 'user_id')}`,
} as const;

export interface EngineResult {
  scanned: number;
  considered: number;
  checkin_sent: number;
  reminders_sent: number;
  deadlines_processed: number;
  summaries_sent: number;
  skipped_claimed: number;
  errors: string[];
}

export interface DateSchedule {
  checkin_at: Date;
  checkin_effective_at: Date;
  reminders: { offset_min: number; at: Date; effective_at: Date; reachable: boolean }[];
  deadline_at: Date;
  summary_effective_at: Date;
  drafts_at: Date;
}

export interface Recipient {
  producer_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
}

export interface ExcludedProducer {
  producer_id: string;
  business_name: string;
  reason: 'no_phone' | 'invalid_phone' | 'opted_out' | 'inactive_producer';
}

const E164_RE = /^\+[1-9]\d{6,14}$/;
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Pure: the full set of instants this date's workflow revolves around (contract §3.3). */
export function computeSchedule(market: FarmersMarket, date: MarketDateDoc): DateSchedule {
  const workflow = market.workflow ?? DEFAULT_WORKFLOW;
  const quietHours = market.quiet_hours ?? DEFAULT_QUIET_HOURS;
  const tz = market.timezone;
  const end = date.end_at;

  const checkin_at = new Date(end.getTime() + workflow.checkin_offset_min * 60_000);
  const deadline_at = new Date(end.getTime() + workflow.deadline_offset_min * 60_000);
  const drafts_at = new Date(end.getTime() + workflow.drafts_offset_min * 60_000);

  const offsets = [...new Set(workflow.reminder_offsets_min)].sort((a, b) => a - b);
  const reminders = offsets.map((offset_min) => {
    const at = new Date(end.getTime() + offset_min * 60_000);
    return {
      offset_min,
      at,
      effective_at: nextAllowedInstant(at, quietHours, tz),
      reachable: at.getTime() < deadline_at.getTime(),
    };
  });

  return {
    checkin_at,
    checkin_effective_at: nextAllowedInstant(checkin_at, quietHours, tz),
    reminders,
    deadline_at,
    // Deadline processing itself is never deferred; only the staff text is.
    summary_effective_at: nextAllowedInstant(deadline_at, quietHours, tz),
    drafts_at,
  };
}

/** 'Tue Sep 22, 12:00 PM' — weekday/month abbreviated, 12-hour clock, market-local. */
export function formatLocalStamp(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  const idx = DAYS_OF_WEEK.indexOf(w.weekday);
  let hour12 = w.hh % 12;
  if (hour12 === 0) hour12 = 12;
  const ampm = w.hh < 12 ? 'AM' : 'PM';
  const mm = String(w.mm).padStart(2, '0');
  return `${WEEKDAY_ABBR[idx]} ${MONTH_ABBR[w.m - 1]} ${w.d}, ${hour12}:${mm} ${ampm}`;
}

/** 'Sat Sep 19' — calendar-date only, zone-independent (a market_dates 'date' string). */
function dateShort(date: string): string {
  const { m, d } = parseDate(date);
  const idx = DAYS_OF_WEEK.indexOf(weekdayOf(date));
  return `${WEEKDAY_ABBR[idx]} ${MONTH_ABBR[m - 1]} ${d}`;
}

/** First whitespace token of a contact name, max 20 chars; '' when absent. */
function firstNameOf(contactName: string | undefined): string {
  const first = (contactName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.slice(0, 20);
}

export const TEMPLATES = {
  checkin_link(args: { market_name: string; first_name: string; deadline_label: string; link: string }): string {
    const greeting = args.first_name ? `${args.market_name}, ${args.first_name}` : args.market_name;
    return `SJCA Markets: thanks for selling at ${greeting}! Please complete your weekly check-in by ${args.deadline_label}: ${args.link}\nReply STOP to opt out.`;
  },
  checkin_reminder(args: { market_name: string; deadline_label: string; link: string }): string {
    return `SJCA Markets reminder: your ${args.market_name} check-in is due by ${args.deadline_label}. Spots are not held without a check-in: ${args.link}\nReply STOP to opt out.`;
  },
  deadline_summary(args: {
    market_name: string;
    date_short: string;
    responded: number;
    recipients: number;
    non_responder_names: string[];
    admin_link: string;
  }): string {
    const prefix = `SJCA Markets: ${args.market_name} check-in deadline passed for ${args.date_short}. ${args.responded} of ${args.recipients} responded.`;
    if (args.non_responder_names.length === 0) {
      return `${prefix} Everyone responded. Details: ${args.admin_link}`;
    }
    // Greedily include names while the whole body stays within one segment pair.
    let included: string[] = [];
    for (let i = 0; i < args.non_responder_names.length; i++) {
      const candidate = [...included, args.non_responder_names[i]!];
      const more = args.non_responder_names.length - candidate.length;
      const namesText = candidate.join(', ') + (more > 0 ? `, +${more} more` : '');
      const candidateBody = `${prefix} No response: ${namesText}. Details: ${args.admin_link}`;
      if (candidateBody.length <= 300) included = candidate;
      else break;
    }
    const more = args.non_responder_names.length - included.length;
    const namesText = included.join(', ') + (more > 0 ? `, +${more} more` : '');
    return `${prefix} No response: ${namesText}. Details: ${args.admin_link}`;
  },
};

/**
 * A market's recipients (contract §3.5): active memberships whose producer
 * has a valid, non-opted-out E.164 phone. Everything else is `excluded`
 * with a reason. Sorted by business_name.
 */
export async function listRecipients(db: Firestore, marketId: string): Promise<{ recipients: Recipient[]; excluded: ExcludedProducer[] }> {
  const membershipsSnap = await db.collection('producer_memberships').where('market_id', '==', marketId).get();
  const activeProducerIds = membershipsSnap.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((m) => m.status === 'active')
    .map((m) => String(m.producer_id));

  const producersSnap = await db.collection('producers').get();
  const producersById = new Map<string, Record<string, unknown>>();
  for (const doc of producersSnap.docs) producersById.set(doc.id, doc.data() as Record<string, unknown>);

  const recipients: Recipient[] = [];
  const excluded: ExcludedProducer[] = [];

  for (const producerId of activeProducerIds) {
    const p = producersById.get(producerId);
    const business_name = p ? String(p.business_name ?? '') : '';
    if (!p) {
      excluded.push({ producer_id: producerId, business_name, reason: 'no_phone' });
      continue;
    }
    if (p.active === false) {
      excluded.push({ producer_id: producerId, business_name, reason: 'inactive_producer' });
      continue;
    }
    const phone = typeof p.phone === 'string' ? p.phone.trim() : '';
    if (!phone) {
      excluded.push({ producer_id: producerId, business_name, reason: 'no_phone' });
      continue;
    }
    if (!E164_RE.test(phone)) {
      excluded.push({ producer_id: producerId, business_name, reason: 'invalid_phone' });
      continue;
    }
    if (p.sms_opt_out_at) {
      excluded.push({ producer_id: producerId, business_name, reason: 'opted_out' });
      continue;
    }
    recipients.push({ producer_id: producerId, business_name, contact_name: String(p.contact_name ?? ''), phone });
  }

  recipients.sort((a, b) => a.business_name.localeCompare(b.business_name));
  return { recipients, excluded };
}

/**
 * Sends a check-in text (initial or reminder) and logs it (contract §3.2).
 * `checkin_link` always mints a fresh token; `checkin_reminder` reuses the
 * producer's newest unexpired token for the date, minting only if none is
 * valid. Never throws — provider failures come back as `status: 'failed'`.
 *
 * `dedupe_key` (Phase 3 fix): the engine passes one of `DEDUPE_KEYS` so the
 * send is at-most-once across overlapping runs; a collision comes back as
 * `status: 'duplicate'` with the existing row's id and the freshly minted
 * token is left unsent (`sent_message_id: null`, harmless — it is as valid
 * as the one that went out). The staff resend route passes none: a resend
 * is an intentional second text.
 */
export async function sendCheckinLink(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  recipient: Recipient,
  opts: {
    now: Date;
    kind: 'checkin_link' | 'checkin_reminder';
    offset_min?: number;
    created_by: string;
    sent_by?: string | null;
    dedupe_key?: string;
  },
): Promise<{ token: string; message_id: string | null; status: 'sent' | 'simulated' | 'failed' | 'duplicate'; error?: string }> {
  const schedule = computeSchedule(market, date);

  let tokenDoc: LinkTokenDoc;
  if (opts.kind === 'checkin_reminder') {
    const existing = await tokensForDate(db, recipient.producer_id, date.id);
    const valid = existing.find((t) => t.expires_at.getTime() > opts.now.getTime());
    tokenDoc =
      valid ??
      (await mintCheckinToken(db, {
        producer_id: recipient.producer_id,
        market_id: market.id,
        market_date_id: date.id,
        deadline_at: schedule.deadline_at,
        now: opts.now,
        created_by: opts.created_by,
      }));
  } else {
    tokenDoc = await mintCheckinToken(db, {
      producer_id: recipient.producer_id,
      market_id: market.id,
      market_date_id: date.id,
      deadline_at: schedule.deadline_at,
      now: opts.now,
      created_by: opts.created_by,
    });
  }

  const link = checkinUrl(env.APP_URL, tokenDoc.token);
  const deadline_label = formatLocalStamp(schedule.deadline_at, market.timezone);
  const body =
    opts.kind === 'checkin_link'
      ? TEMPLATES.checkin_link({ market_name: market.name, first_name: firstNameOf(recipient.contact_name), deadline_label, link })
      : TEMPLATES.checkin_reminder({ market_name: market.name, deadline_label, link });

  const extra: Record<string, unknown> =
    opts.kind === 'checkin_reminder' ? { token: tokenDoc.token, offset_min: opts.offset_min } : { token: tokenDoc.token };

  const result = await trySendSms({
    env,
    db,
    to: recipient.phone,
    body,
    kind: opts.kind,
    producer_id: recipient.producer_id,
    market_date_id: date.id,
    sent_by: opts.sent_by ?? null,
    extra,
    ...(opts.dedupe_key !== undefined ? { dedupe_key: opts.dedupe_key } : {}),
  });

  if (!result.ok && result.duplicate) {
    // Another run already sent this exact text; this token was never sent.
    return { token: tokenDoc.token, message_id: result.message_id, status: 'duplicate', error: result.error };
  }

  const message_id = result.message_id;
  await db.collection('link_tokens').doc(tokenDoc.token).update({ sent_message_id: message_id });

  return {
    token: tokenDoc.token,
    message_id,
    status: result.ok ? result.status : 'failed',
    error: result.ok ? undefined : result.error,
  };
}

async function businessNamesFor(db: Firestore, producerIds: string[]): Promise<string[]> {
  if (producerIds.length === 0) return [];
  const snap = await db.collection('producers').get();
  const byId = new Map<string, string>();
  for (const doc of snap.docs) byId.set(doc.id, String((doc.data() as Record<string, unknown>).business_name ?? ''));
  return producerIds.map((id) => byId.get(id) ?? id);
}

function reasonLabel(reason: ExcludedProducer['reason']): string {
  switch (reason) {
    case 'no_phone':
      return 'no phone number';
    case 'invalid_phone':
      return 'invalid phone';
    case 'opted_out':
      return 'opted out';
    case 'inactive_producer':
      return 'inactive producer';
    default:
      return reason;
  }
}

async function buildDeadlineSummaryEmail(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  args: { dateShort: string; deadlineLabel: string; adminLink: string },
): Promise<string> {
  const { recipients, excluded } = await listRecipients(db, market.id);
  const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', date.id).get();
  const byProducer = new Map<string, Record<string, unknown>>();
  for (const d of checkinsSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    byProducer.set(String(data.producer_id ?? ''), data);
  }
  const responded = recipients.filter((r) => byProducer.has(r.producer_id));
  const noResponse = recipients.filter((r) => !byProducer.has(r.producer_id));

  const respondedLines = responded.map((r) => {
    const c = byProducer.get(r.producer_id);
    const attending = c?.attending_next === true ? 'Yes' : c?.attending_next === false ? 'No' : 'unknown';
    return `${r.business_name} - attending next: ${attending}`;
  });
  const noResponseLines = noResponse.map((r) => r.business_name);
  const excludedLines = excluded.map((e) => `${e.business_name} (${reasonLabel(e.reason)})`);

  const lines = [
    `Market: ${market.name}`,
    `Date: ${date.date}`,
    `Deadline: ${args.deadlineLabel}`,
    '',
    'Responded:',
    ...(respondedLines.length ? respondedLines : ['(none)']),
    '',
    'No response:',
    ...(noResponseLines.length ? noResponseLines : ['(none)']),
    '',
    'Excluded:',
    ...(excludedLines.length ? excludedLines : ['(none)']),
    '',
    `Details: ${args.adminLink}`,
  ];
  return lines.join('\n');
}

/**
 * Sends the staff deadline-summary text (to every `staffForMarket` phone)
 * and, when `env.ALERT_EMAIL` is set, one email.
 *
 * Every text carries `DEDUPE_KEYS.deadline_summary(date, user)`, so a staff
 * member gets at most one summary per date however many runs (or an admin
 * "close" racing the engine) attempt it; collisions are counted in
 * `duplicates`, not `sms`. The email has no log row and therefore no atomic
 * guard: `opts.email` lets the engine send it only from the run that created
 * the summary lock (see the summary step) — a stale-lock takeover skips it.
 *
 * The email never throws (round 2): a disabled provider (SendsDisabledError)
 * is silent, and any other failure — Resend down, a bad key, a read that
 * failed while building the body — is logged with console.error and comes
 * back as `email: false`, so the caller still completes its step. The texts
 * are the authoritative channel and are atomic; a lost email is a logged
 * degradation, whereas round 1 let it propagate, which left `summary_sent_at`
 * unset with the summary lock held and, because a takeover never emails,
 * meant the email was never sent at all.
 */
export async function sendDeadlineSummary(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  stats: { recipients: number; responded: number; non_responders: string[] },
  opts: { now: Date; email?: boolean },
): Promise<{ sms: number; email: boolean; duplicates: number }> {
  const schedule = computeSchedule(market, date);
  const staff = await staffForMarket(db, market.id);
  const names = await businessNamesFor(db, stats.non_responders);
  const dateShortStr = dateShort(date.date);
  const adminLink = `${env.APP_URL.replace(/\/+$/, '')}/admin/market-dates?id=${date.id}`;
  const body = TEMPLATES.deadline_summary({
    market_name: market.name,
    date_short: dateShortStr,
    responded: stats.responded,
    recipients: stats.recipients,
    non_responder_names: names,
    admin_link: adminLink,
  });

  let smsCount = 0;
  let duplicates = 0;
  for (const s of staff) {
    const result = await trySendSms({
      env,
      db,
      to: s.phone,
      body,
      kind: 'deadline_summary',
      user_id: s.user_id,
      market_date_id: date.id,
      dedupe_key: DEDUPE_KEYS.deadline_summary(date.id, s.user_id),
    });
    if (result.ok) smsCount++;
    else if (result.duplicate) duplicates++;
  }

  let emailSent = false;
  if (env.ALERT_EMAIL && opts.email !== false) {
    try {
      const subject = `[SJCA Markets] ${market.name} check-in deadline: ${stats.responded}/${stats.recipients} responded (${dateShortStr})`;
      const deadlineLabel = formatLocalStamp(schedule.deadline_at, market.timezone);
      const message = await buildDeadlineSummaryEmail(db, market, date, { dateShort: dateShortStr, deadlineLabel, adminLink });
      await sendEmail({ env, to: env.ALERT_EMAIL, subject, message });
      emailSent = true;
    } catch (err) {
      if (!(err instanceof SendsDisabledError)) {
        console.error(`Deadline summary email not sent for ${date.id} (${market.id}); the ${smsCount + duplicates} staff texts are the record`, err);
      }
    }
  }

  return { sms: smsCount, email: emailSent, duplicates };
}

async function computeDeadlineStats(
  db: Firestore,
  marketId: string,
  marketDateId: string,
): Promise<{ recipients: Recipient[]; responded: Recipient[]; nonResponderIds: string[] }> {
  const { recipients } = await listRecipients(db, marketId);
  const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', marketDateId).get();
  const respondedIds = new Set(checkinsSnap.docs.map((d) => String((d.data() as Record<string, unknown>).producer_id ?? '')));
  const responded = recipients.filter((r) => respondedIds.has(r.producer_id));
  const nonResponderIds = recipients
    .filter((r) => !respondedIds.has(r.producer_id))
    .map((r) => r.producer_id)
    .sort();
  return { recipients, responded, nonResponderIds };
}

/**
 * Runs a date's deadline processing (contract §4.2, the `/close` route):
 * always writes the non-responder flags and counts; sends the staff summary
 * immediately (no quiet-hours deferral — a manual admin act) only when
 * `notify`. Zero recipients always skips the summary regardless of `notify`.
 *
 * Writes field paths only, never the `actions` map: the engine may be inside
 * a check-in or reminder loop on this very date, and its own field-path
 * writes and these commute (round 2 — see the file comment).
 */
export type CloseOutcome =
  | 'sent'
  | 'skipped_no_recipients'
  | 'skipped_notify_false'
  | 'failed'
  /** The deadline was already processed (by the engine or an earlier close) — nothing was written or sent. */
  | 'already_processed'
  /** The engine holds the step lock right now — nothing was written or sent; try again shortly. */
  | 'in_progress';

export async function processDeadline(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; notify: boolean; actor: string },
): Promise<{ recipients: number; responded: number; non_responders: string[]; summary: CloseOutcome }> {
  const ref = db.collection('market_dates').doc(date.id);
  const asLoaded = {
    recipients: date.deadline_recipient_count ?? 0,
    responded: date.deadline_responded_count ?? 0,
    non_responders: date.non_responders ?? [],
  };

  // Round 3: the manual close takes the same step locks as the engine, so a
  // close overlapping the engine's deadline tick — or a second close — can
  // neither process the deadline twice nor send the staff summary email twice.
  const deadline = await claim(db, date.id, 'deadline', opts.now, (a) => !!a.deadline_processed_at);
  if (deadline.status !== 'proceed') return { ...asLoaded, summary: deadline.status === 'claimed' ? 'in_progress' : 'already_processed' };

  const { recipients, responded, nonResponderIds } = await computeDeadlineStats(db, market.id, date.id);

  const baseUpdate: Record<string, unknown> = {
    non_responders: nonResponderIds,
    spot_not_held: nonResponderIds,
    deadline_recipient_count: recipients.length,
    deadline_responded_count: responded.length,
    'actions.deadline_processed_at': opts.now,
    updated_at: opts.now,
  };

  if (recipients.length === 0) {
    await ref.update({ ...baseUpdate, 'actions.summary_sent_at': null, 'actions.summary_skipped': 'no_recipients' });
    return { recipients: 0, responded: 0, non_responders: nonResponderIds, summary: 'skipped_no_recipients' };
  }

  if (!opts.notify) {
    await ref.update({ ...baseUpdate, 'actions.summary_skipped': 'notify_false' });
    return { recipients: recipients.length, responded: responded.length, non_responders: nonResponderIds, summary: 'skipped_notify_false' };
  }

  await ref.update(baseUpdate);

  const stats = { recipients: recipients.length, responded: responded.length, non_responders: nonResponderIds };
  const summary = await claim(db, date.id, 'summary', opts.now, (a) => a.summary_sent_at != null || a.summary_skipped != null);
  if (summary.status !== 'proceed') return { ...stats, summary: summary.status === 'claimed' ? 'in_progress' : 'already_processed' };
  try {
    // Texts are keyed per staff member; the email goes out only from the run
    // that created the summary lock (same rule as the engine's summary step).
    await sendDeadlineSummary(db, env, market, date, stats, { now: opts.now, email: summary.created });
    await ref.update({ 'actions.summary_sent_at': opts.now, updated_at: opts.now });
    return { ...stats, summary: 'sent' };
  } catch {
    return { ...stats, summary: 'failed' };
  }
}

// ─── The engine ──────────────────────────────────────────────────────────

type ClaimResult =
  | { status: 'done' }
  | { status: 'claimed' }
  | {
      status: 'proceed';
      /** True when this run created the lock; false when it took over a stale one. */
      created: boolean;
    };

/** `workflow_locks` doc id: one lock per market date per step. */
export function workflowLockId(dateId: string, key: string): string {
  return `${dateId}__${key}`;
}

/**
 * Idempotency across overlapping runs (contract §3.4, made atomic).
 *
 * 1. Fresh read of the market_date (never the scan snapshot); `isDone` on its
 *    flags short-circuits a step another run has already finished.
 * 2. Atomic step lock: `workflow_locks/<date_id>__<key>` via `create()`. The
 *    admin SDK rejects a create on an existing doc with ALREADY_EXISTS, so of
 *    any number of concurrent runs exactly one gets `created: true`. A loser
 *    reads the lock: younger than CLAIM_TTL_MS → `claimed` (skip the step);
 *    older → the owner died (the function times out at 300 s) and this run
 *    takes the lock over with `set()`.
 * 3. The informational `actions.claims[key]` on the market_date is written
 *    as a field path for the status page. It is no longer the guard, and the
 *    snapshot read in (1) is deliberately NOT returned: a step must never
 *    write from it (round 2).
 *
 * Residual race, documented: the takeover in (2) is itself read-then-write,
 * so two runs arriving together at a lock that is already stale can both
 * proceed. That is harmless — every send under the lock is atomic on its
 * own `dedupe_key` (a duplicate never reaches the provider) and every flag
 * write is a field path carrying the same value — except for the summary
 * *email*, which has no log row; the summary step therefore emails only from
 * the run that created the lock (`created: true`), never from a takeover.
 * Locks are never cleared.
 */
async function claim(
  db: Firestore,
  dateId: string,
  key: string,
  now: Date,
  isDone: (actions: MarketDateActions) => boolean,
): Promise<ClaimResult> {
  const ref = db.collection('market_dates').doc(dateId);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'done' };
  const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
  if (isDone(fresh.actions)) return { status: 'done' };

  const lockRef = db.collection('workflow_locks').doc(workflowLockId(dateId, key));
  const run_id = uuid();
  let created = true;
  try {
    await lockRef.create({ market_date_id: dateId, key, claimed_at: now, run_id, created_at: now });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    created = false;
    const lockSnap = await lockRef.get();
    const lock = (lockSnap.data() ?? {}) as Record<string, unknown>;
    const claimedAt = toDate(lock.claimed_at);
    if (claimedAt && now.getTime() - claimedAt.getTime() < CLAIM_TTL_MS) return { status: 'claimed' };
    // Stale: the owner died mid-step. Take it over (see the residual race above).
    await lockRef.set({
      market_date_id: dateId,
      key,
      claimed_at: now,
      run_id,
      taken_over_from: typeof lock.run_id === 'string' ? lock.run_id : null,
      created_at: toDate(lock.created_at) ?? now,
    });
  }

  await ref.update({ [`actions.claims.${key}`]: now, updated_at: now });
  return { status: 'proceed', created };
}

/**
 * Sends (or marks superseded) a single reminder offset, under its own claim.
 * `claimed` is true when another live run holds this offset's lock (counted
 * in `skipped_claimed`); a step another run has already finished is `done`
 * and counts as nothing.
 */
async function processReminderOffset(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  offsetMin: number,
  mode: 'superseded' | 'send',
  now: Date,
): Promise<{ sent: number; claimed: boolean }> {
  const key = `reminder_${offsetMin}`;
  const c = await claim(db, date.id, key, now, (a) => a.reminders_sent.some((r) => r.offset_min === offsetMin));
  if (c.status !== 'proceed') return { sent: 0, claimed: c.status === 'claimed' };

  let entry: ReminderSent;
  if (mode === 'superseded') {
    entry = { offset_min: offsetMin, sent_at: now, recipients: 0, failed: 0, skipped: 'superseded' };
  } else {
    const { recipients: allRecipients } = await listRecipients(db, market.id);
    const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', date.id).get();
    const respondedIds = new Set(checkinsSnap.docs.map((d) => String((d.data() as Record<string, unknown>).producer_id ?? '')));
    // A producer who already answered (even a partial SMS check-in) already holds their spot.
    const targets = allRecipients.filter((r) => !respondedIds.has(r.producer_id));

    const msgSnap = await db.collection('messages').where('market_date_id', '==', date.id).get();
    const alreadyTexted = new Set(
      msgSnap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((m) => m.kind === 'checkin_reminder' && m.offset_min === offsetMin && ['queued', 'sent', 'simulated'].includes(String(m.status)))
        .map((m) => String(m.producer_id)),
    );

    let sent = 0;
    let failed = 0;
    for (const r of targets) {
      if (alreadyTexted.has(r.producer_id)) continue;
      const result = await sendCheckinLink(db, env, market, date, r, {
        now,
        kind: 'checkin_reminder',
        offset_min: offsetMin,
        created_by: 'engine',
        dedupe_key: DEDUPE_KEYS.checkin_reminder(date.id, r.producer_id, offsetMin),
      });
      if (result.status === 'failed') failed++;
      else if (result.status === 'duplicate') continue; // another run already sent it: skipped, not failed
      else sent++;
    }
    entry = { offset_min: offsetMin, sent_at: now, recipients: sent, failed, skipped: null };
  }

  // This offset's outcome on its own field path: a run holding a different
  // reminder lock writes a different path, so neither can drop the other's
  // decision. Readers see the offset-sorted `reminders_sent` array that
  // marketDateFromData derives from this map.
  await db.collection('market_dates').doc(date.id).update({
    [`actions.reminder_state.${reminderStateKey(offsetMin)}`]: entry,
    updated_at: now,
  });
  return { sent: mode === 'send' ? entry.recipients : 0, claimed: false };
}

/**
 * Reminders step (contract §3.3): a reminder whose slot the check-in text
 * has already passed is superseded without sending; when several offsets
 * are simultaneously due, only the latest is sent and the earlier ones are
 * superseded too. Each offset is claimed independently (`reminder_<offset>`).
 */
async function processRemindersStep(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  schedule: DateSchedule,
  now: Date,
): Promise<{ sent: number; claimed: number }> {
  if (!date.actions.checkin_sent_at) return { sent: 0, claimed: 0 };
  if (schedule.deadline_at.getTime() <= now.getTime()) return { sent: 0, claimed: 0 };

  const sentOffsets = new Set(date.actions.reminders_sent.map((r) => r.offset_min));
  const checkinSentAt = date.actions.checkin_sent_at;

  const dueOffsets: number[] = [];
  const lateSuperseded: number[] = [];

  for (const r of schedule.reminders) {
    if (sentOffsets.has(r.offset_min) || !r.reachable) continue;
    if (r.at.getTime() <= checkinSentAt.getTime()) {
      lateSuperseded.push(r.offset_min);
    } else if (r.effective_at.getTime() <= now.getTime()) {
      dueOffsets.push(r.offset_min);
    }
  }

  dueOffsets.sort((a, b) => a - b);
  const winner = dueOffsets.length > 0 ? dueOffsets[dueOffsets.length - 1] : undefined;
  const multiSuperseded = dueOffsets.slice(0, -1);

  let sentTotal = 0;
  let claimedTotal = 0;
  for (const offset of [...lateSuperseded, ...multiSuperseded].sort((a, b) => a - b)) {
    const r = await processReminderOffset(db, env, market, date, offset, 'superseded', now);
    if (r.claimed) claimedTotal++;
  }
  if (winner !== undefined) {
    const r = await processReminderOffset(db, env, market, date, winner, 'send', now);
    sentTotal += r.sent;
    if (r.claimed) claimedTotal++;
  }
  return { sent: sentTotal, claimed: claimedTotal };
}

/** contract §3.2/§3.1 — one scan of every `collecting` date within the 7-day window. */
export async function processMarketDates(db: Firestore, env: Env, opts?: { now?: Date }): Promise<EngineResult> {
  const now = opts?.now ?? new Date();
  const result: EngineResult = {
    scanned: 0,
    considered: 0,
    checkin_sent: 0,
    reminders_sent: 0,
    deadlines_processed: 0,
    summaries_sent: 0,
    skipped_claimed: 0,
    errors: [],
  };

  const marketsSnap = await db.collection('farmers_markets').get();
  const marketsById = new Map<string, FarmersMarket>();
  for (const doc of marketsSnap.docs) {
    marketsById.set(doc.id, { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket);
  }

  const datesSnap = await db.collection('market_dates').where('status', '==', 'collecting').get();
  result.scanned = datesSnap.size;

  const kept: MarketDateDoc[] = [];
  for (const doc of datesSnap.docs) {
    const date = marketDateFromData(doc.id, doc.data() as Record<string, unknown>);
    const market = marketsById.get(date.market_id);
    if (!market || !market.active) continue;
    const age = now.getTime() - date.end_at.getTime();
    if (age > SCAN_WINDOW_MS) continue; // older than the automatic window — ignored forever
    if (date.end_at.getTime() > now.getTime()) continue; // future — wait
    kept.push(date);
  }
  result.considered = kept.length;

  for (const date of kept) {
    const market = marketsById.get(date.market_id)!;
    try {
      const schedule = computeSchedule(market, date);

      // ── Check-in ──────────────────────────────────────────────────────
      const deadlinePassed = schedule.deadline_at.getTime() <= now.getTime();
      if (!date.actions.checkin_sent_at && schedule.checkin_effective_at.getTime() <= now.getTime() && !deadlinePassed) {
        const c = await claim(db, date.id, 'checkin', now, (a) => !!a.checkin_sent_at);
        if (c.status === 'claimed') result.skipped_claimed++;
        if (c.status === 'proceed') {
          const { recipients } = await listRecipients(db, market.id);
          const msgSnap = await db.collection('messages').where('market_date_id', '==', date.id).get();
          const alreadySent = new Set(
            msgSnap.docs
              .map((d) => d.data() as Record<string, unknown>)
              .filter((m) => m.kind === 'checkin_link' && ['queued', 'sent', 'simulated'].includes(String(m.status)))
              .map((m) => String(m.producer_id)),
          );
          let sentCount = 0;
          let failedCount = 0;
          for (const r of recipients) {
            if (alreadySent.has(r.producer_id)) continue;
            const send = await sendCheckinLink(db, env, market, date, r, {
              now,
              kind: 'checkin_link',
              created_by: 'engine',
              dedupe_key: DEDUPE_KEYS.checkin_link(date.id, r.producer_id),
            });
            if (send.status === 'failed') failedCount++;
            else if (send.status === 'duplicate') continue; // another run already sent it: skipped, not failed
            else sentCount++;
          }
          await db.collection('market_dates').doc(date.id).update({
            'actions.checkin_sent_at': now,
            'actions.checkin_recipients': recipients.length,
            'actions.checkin_failed': failedCount,
            updated_at: now,
          });
          result.checkin_sent += sentCount;
        }
      }

      // ── Reminders (fresh read — the check-in step above may have just run) ──
      {
        const snap = await db.collection('market_dates').doc(date.id).get();
        const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
        const { sent, claimed } = await processRemindersStep(db, env, market, fresh, schedule, now);
        result.reminders_sent += sent;
        result.skipped_claimed += claimed;
      }

      // ── Deadline ─────────────────────────────────────────────────────
      {
        const snap = await db.collection('market_dates').doc(date.id).get();
        const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
        if (!fresh.actions.deadline_processed_at && schedule.deadline_at.getTime() <= now.getTime()) {
          const c = await claim(db, date.id, 'deadline', now, (a) => !!a.deadline_processed_at);
          if (c.status === 'claimed') result.skipped_claimed++;
          if (c.status === 'proceed') {
            const { recipients, responded, nonResponderIds } = await computeDeadlineStats(db, market.id, date.id);
            const update: Record<string, unknown> = {
              non_responders: nonResponderIds,
              spot_not_held: nonResponderIds,
              deadline_recipient_count: recipients.length,
              deadline_responded_count: responded.length,
              'actions.deadline_processed_at': now,
              updated_at: now,
            };
            if (recipients.length === 0) {
              update['actions.summary_sent_at'] = null;
              update['actions.summary_skipped'] = 'no_recipients';
            }
            await db.collection('market_dates').doc(date.id).update(update);
            result.deadlines_processed += 1;
          }
        }
      }

      // ── Summary (fresh read — the deadline step above may have just run) ──
      {
        const snap = await db.collection('market_dates').doc(date.id).get();
        const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
        const due =
          fresh.actions.deadline_processed_at != null &&
          fresh.actions.summary_sent_at == null &&
          fresh.actions.summary_skipped == null &&
          schedule.summary_effective_at.getTime() <= now.getTime();
        if (due) {
          const c = await claim(db, date.id, 'summary', now, (a) => a.summary_sent_at != null || a.summary_skipped != null);
          if (c.status === 'claimed') result.skipped_claimed++;
          if (c.status === 'proceed') {
            const recipientsCount = fresh.deadline_recipient_count ?? 0;
            const respondedCount = fresh.deadline_responded_count ?? 0;
            const nonResponders = fresh.non_responders ?? [];
            // The texts are atomic per staff user (dedupe_key). The email is
            // not logged, so only the run that CREATED the summary lock sends
            // it; a stale-lock takeover (the creator died after claiming)
            // re-sends the texts (all refused as duplicates if they went out)
            // but never the email — a possibly missing email beats a double
            // one. An email failure is logged inside sendDeadlineSummary and
            // does not stop this step: summary_sent_at is still written, so
            // the lock is not held open over a lost email. Residual window: a
            // creator that died after emailing but before writing
            // summary_sent_at leaves the email sent once and the flag written
            // by the takeover; a creator that died before emailing leaves no
            // email at all (the texts still go out).
            await sendDeadlineSummary(
              db,
              env,
              market,
              fresh,
              { recipients: recipientsCount, responded: respondedCount, non_responders: nonResponders },
              { now, email: c.created },
            );
            await db.collection('market_dates').doc(date.id).update({ 'actions.summary_sent_at': now, updated_at: now });
            result.summaries_sent += 1;
          }
        }
      }

      // ── Drafts hook (Phase 6 stub) ──────────────────────────────────────
      if (schedule.drafts_at.getTime() <= now.getTime() && !date.actions.drafts_generated_at) {
        await generateDrafts();
      }
    } catch (err) {
      result.errors.push(`${date.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/** Phase 6 stub (contract §3.3): never sets `drafts_generated_at`. */
async function generateDrafts(): Promise<'not_implemented'> {
  return 'not_implemented';
}
