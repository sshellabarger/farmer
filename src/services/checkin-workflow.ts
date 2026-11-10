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
import { trySendSms, isAlreadyExists, SendsDisabledError, splitMessage } from './sms.js';
import type { TrySendSmsResult } from './sms.js';
import { sendEmail } from './email.js';
import { currentSeason, isVendorOfRecord, listMembershipsForMarket, ofSeason } from './seasons.js';
import type { SeasonSource } from './seasons.js';
import { listBooths } from './booths.js';
import {
  CYCLE_MODES,
  QUEUED_STALE_MS,
  boothTextsAllowedAt,
  boothTextsHold,
  boothTextsSettled,
  changeInFlight,
  computeBoothSummary,
  conflictedBoothIds,
  currentAssignments,
  cycleOf,
  cycleStateOf,
  draftAssignments,
  findSeasonOpener,
  loadAttendance,
  loadBoothTextLog,
  loadCycleTarget,
  nextDateAfter,
  openerSeasonMatches,
  planBoothTexts,
  prepareDraft,
  seatedVendors,
} from './booth-assignments.js';
import type { BoothTextItem, CycleMode, DraftResult } from './booth-assignments.js';
import type { BoothTextsBlocked } from './market-dates.js';
import type { DraftSkipReason } from '../types/schema.js';

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
  /**
   * Phase 4: keyed by the TARGET date (the one the booth is for, not the
   * collecting date), the producer AND the producer's newest current
   * assignment row (Phase 4 fix). A changed assignment is a new row, hence a
   * new key and one corrective text; an unchanged one can never be texted
   * twice, whatever overlaps. Assignment ids are uuid v4.
   */
  booth: (targetDateId: string, producerId: string, assignmentId: string) =>
    `booth:${keyPart(targetDateId, 'target_date_id')}:${keyPart(producerId, 'producer_id')}:${keyPart(assignmentId, 'assignment_id')}`,
  /** The release notice to a vendor removed from the date: at most one per assignment that was told and taken away. */
  booth_release: (targetDateId: string, producerId: string, assignmentId: string) =>
    `booth_release:${keyPart(targetDateId, 'target_date_id')}:${keyPart(producerId, 'producer_id')}:${keyPart(assignmentId, 'assignment_id')}`,
} as const;

export interface EngineResult {
  scanned: number;
  considered: number;
  checkin_sent: number;
  reminders_sent: number;
  deadlines_processed: number;
  summaries_sent: number;
  /** Phase 4: dates whose booth assignments this run drafted (a skipped draft does not count). */
  drafts_generated: number;
  /** Phase 4: booth texts this run sent (first texts, corrective texts and release notices). */
  booth_texts_sent: number;
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

/** The first candidate that fits one SMS segment as `splitMessage` measures it; the last (shortest) one when none does. */
function firstSingleSegment(candidates: string[]): string {
  return candidates.find((c) => splitMessage(c).length === 1) ?? candidates[candidates.length - 1]!;
}

export const TEMPLATES = {
  checkin_link(args: { market_name: string; first_name: string; deadline_label: string; link: string }): string {
    const greeting = args.first_name ? `${args.market_name}, ${args.first_name}` : args.market_name;
    return `SJCA Markets: thanks for selling at ${greeting}! Please complete your weekly check-in by ${args.deadline_label}: ${args.link}\nReply STOP to opt out.`;
  },
  checkin_reminder(args: { market_name: string; deadline_label: string; link: string }): string {
    return `SJCA Markets reminder: your ${args.market_name} check-in is due by ${args.deadline_label}. Spots are not held without a check-in: ${args.link}\nReply STOP to opt out.`;
  },
  /**
   * Phase 4 (contract §3.5): the vendor's booth for the market named. Labels are
   * the booths' own labels, e.g. `V7 and V8` or `Food truck`. `changed` is the
   * corrective text after a staff change ("is now").
   *
   * ONE SEGMENT (Phase 4 fix). This template carries no "Reply STOP to opt out."
   * line: with it every booth text for the real market name ran past one
   * segment and the vendor received a second SMS that said only that. STOP and
   * HELP are honoured on every inbound text regardless (src/services/inbound.ts),
   * and the weekly check-in text, which every vendor who gets a booth text has
   * already received, carries the wording. With a market name of up to 31
   * characters, a first name of up to 12 and two short booth labels the text is
   * at most 153 characters - one segment as `splitMessage` measures it. Longer
   * inputs drop the greeting name, then the closing sentence, before they split.
   */
  booth(args: { market_name: string; date_short: string; labels: string[]; first_name: string; changed?: boolean }): string {
    const labels = args.labels;
    const where = labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    const fact = `booth at ${args.market_name} on ${args.date_short} is ${args.changed ? 'now ' : ''}${where}.`;
    const tail = ' Please check in at the table when you arrive.';
    return firstSingleSegment([
      ...(args.first_name ? [`SJCA Markets: ${args.first_name}, your ${fact}${tail}`] : []),
      `SJCA Markets: your ${fact}${tail}`,
      `SJCA Markets: your ${fact}`,
    ]);
  },
  /** Phase 4 fix: the short notice to a vendor who was told a booth and has been taken off the date. One segment, no STOP line (see `booth`). */
  booth_release(args: { market_name: string; date_short: string; first_name: string }): string {
    const fact = `no longer assigned a booth at ${args.market_name} on ${args.date_short}.`;
    const tail = ' Questions? Reply to this text.';
    return firstSingleSegment([
      ...(args.first_name ? [`SJCA Markets: ${args.first_name}, you are ${fact}${tail}`] : []),
      `SJCA Markets: you are ${fact}${tail}`,
      `SJCA Markets: you are ${fact}`,
    ]);
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
 * A market's recipients (contract §3.5): memberships of the market's CURRENT
 * season (decision D33; `seasons.ts`) that are `active`, whose producer has a
 * valid, non-opted-out E.164 phone. Everything else is `excluded` with a
 * reason. Sorted by business_name. Memberships of other seasons never count.
 * `opts.now` fixes "current" for the caller (the engine passes its own clock).
 */
export async function listRecipients(
  db: Firestore,
  marketId: string,
  opts?: { now?: Date },
): Promise<{ recipients: Recipient[]; excluded: ExcludedProducer[] }> {
  const marketDoc = await db.collection('farmers_markets').doc(marketId).get();
  const marketData = marketDoc.exists ? (marketDoc.data() as Record<string, unknown>) : {};
  const source = { id: marketId, ...marketData, timezone: typeof marketData.timezone === 'string' ? marketData.timezone : 'UTC' } as SeasonSource & { id: string };
  const season = currentSeason(source, opts?.now ?? new Date());
  const memberships = ofSeason(await listMembershipsForMarket(db, marketId), season);
  const activeProducerIds = [...new Set(memberships.filter(isVendorOfRecord).map((m) => m.producer_id))];

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
  args: { dateShort: string; deadlineLabel: string; adminLink: string; now: Date },
): Promise<string> {
  const { recipients, excluded } = await listRecipients(db, market.id, { now: args.now });
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
      const message = await buildDeadlineSummaryEmail(db, market, date, { dateShort: dateShortStr, deadlineLabel, adminLink, now: opts.now });
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
  now: Date,
): Promise<{ recipients: Recipient[]; responded: Recipient[]; nonResponderIds: string[] }> {
  const { recipients } = await listRecipients(db, marketId, { now });
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
  /** This call processed the deadline, but the engine's summary step had already sent the summary. */
  | 'sent_by_engine'
  /** The engine holds the step lock right now — refresh the status page rather than retrying. */
  | 'in_progress'
  /** The deadline was already processed (by the engine or an earlier close) — nothing was written or sent. */
  | 'already_processed';

export interface CloseResult {
  /** True when THIS call wrote the deadline flags; the route answers 200 and audits only then. */
  processed: boolean;
  recipients: number;
  responded: number;
  non_responders: string[];
  summary: CloseOutcome;
}

export async function processDeadline(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; notify: boolean; actor: string },
): Promise<CloseResult> {
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
  if (deadline.status !== 'proceed') {
    return { processed: false, ...asLoaded, summary: deadline.status === 'claimed' ? 'in_progress' : 'already_processed' };
  }

  const { recipients, responded, nonResponderIds } = await computeDeadlineStats(db, market.id, date.id, opts.now);

  const baseUpdate: Record<string, unknown> = {
    non_responders: nonResponderIds,
    spot_not_held: nonResponderIds,
    deadline_recipient_count: recipients.length,
    deadline_responded_count: responded.length,
    'actions.deadline_processed_at': opts.now,
    updated_at: opts.now,
  };
  const stats = { recipients: recipients.length, responded: responded.length, non_responders: nonResponderIds };

  if (recipients.length === 0) {
    await ref.update({ ...baseUpdate, 'actions.summary_sent_at': null, 'actions.summary_skipped': 'no_recipients' });
    return { processed: true, ...stats, summary: 'skipped_no_recipients' };
  }

  if (!opts.notify) {
    await ref.update({ ...baseUpdate, 'actions.summary_skipped': 'notify_false' });
    return { processed: true, ...stats, summary: 'skipped_notify_false' };
  }

  await ref.update(baseUpdate);

  const summary = await claim(db, date.id, 'summary', opts.now, (a) => a.summary_sent_at != null || a.summary_skipped != null);
  if (summary.status !== 'proceed') {
    // We processed the deadline; the engine's summary step got there first.
    return { processed: true, ...stats, summary: summary.status === 'claimed' ? 'in_progress' : 'sent_by_engine' };
  }
  try {
    // Texts are keyed per staff member; the email goes out only from the run
    // that created the summary lock (same rule as the engine's summary step).
    await sendDeadlineSummary(db, env, market, date, stats, { now: opts.now, email: summary.created });
    await ref.update({ 'actions.summary_sent_at': opts.now, updated_at: opts.now });
    return { processed: true, ...stats, summary: 'sent' };
  } catch {
    return { processed: true, ...stats, summary: 'failed' };
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
    const { recipients: allRecipients } = await listRecipients(db, market.id, { now });
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
  // The deadline has passed, or an admin closed the date early: no more producer texts.
  if (schedule.deadline_at.getTime() <= now.getTime() || date.actions.deadline_processed_at) return { sent: 0, claimed: 0 };

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

/**
 * contract §3.2/§3.1 — one scan of every `collecting` date: the check-in,
 * reminder, deadline, summary and drafts steps for the dates that ended within
 * the 7-day window, then the booth-text step for every approved cycle that
 * still owes a text, whatever the date's age (Phase 4 fix).
 */
export async function processMarketDates(db: Firestore, env: Env, opts?: { now?: Date }): Promise<EngineResult> {
  const now = opts?.now ?? new Date();
  const result: EngineResult = {
    scanned: 0,
    considered: 0,
    checkin_sent: 0,
    reminders_sent: 0,
    deadlines_processed: 0,
    summaries_sent: 0,
    drafts_generated: 0,
    booth_texts_sent: 0,
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
      // An admin close (deadline_processed_at set early) also ends the producer-facing texts.
      const deadlinePassed = schedule.deadline_at.getTime() <= now.getTime() || !!date.actions.deadline_processed_at;
      if (!date.actions.checkin_sent_at && schedule.checkin_effective_at.getTime() <= now.getTime() && !deadlinePassed) {
        const c = await claim(db, date.id, 'checkin', now, (a) => !!a.checkin_sent_at);
        if (c.status === 'claimed') result.skipped_claimed++;
        if (c.status === 'proceed') {
          const { recipients } = await listRecipients(db, market.id, { now });
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
            const { recipients, responded, nonResponderIds } = await computeDeadlineStats(db, market.id, date.id, now);
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

      // ── Drafts (Phase 4, contract §3.5) ─────────────────────────────────
      // Due once `drafts_at` has passed. Fresh read: the steps above may have run.
      {
        const snap = await db.collection('market_dates').doc(date.id).get();
        const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
        if (schedule.drafts_at.getTime() <= now.getTime() && !fresh.actions.drafts_generated_at) {
          const c = await claim(db, date.id, 'drafts', now, (a) => !!a.drafts_generated_at);
          if (c.status === 'claimed') result.skipped_claimed++;
          if (c.status === 'proceed') {
            const draft = await draftAssignments(db, market, fresh, { now, actor: 'engine', mode: 'initial', record_skip: true });
            if (!draft.skipped) result.drafts_generated += 1;
          }
        }
      }

    } catch (err) {
      result.errors.push(`${date.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Booth texts (Phase 4 fix): every approved cycle that still owes a text ──
  // NOT limited to the 7-day window or to dates that have ended: an approval in
  // quiet hours for an older date, a corrective text after a staff change, and a
  // season opener approved months ahead (a date still in the future) are all
  // picked up here. The snapshot above already holds every collecting date, and
  // `boothTextsSettled` / the quiet-hours test are pure, so a date with nothing
  // owed - or nothing allowed out yet - costs no read at all.
  for (const doc of datesSnap.docs) {
    const scanned = marketDateFromData(doc.id, doc.data() as Record<string, unknown>);
    const market = marketsById.get(scanned.market_id);
    if (!market || !market.active) continue;
    for (const mode of CYCLE_MODES) {
      const s = cycleStateOf(scanned.actions, mode);
      if (!s.approved_at || boothTextsSettled(s)) continue;
      if (boothTextsAllowedAt(s.approved_at, now, market).getTime() > now.getTime()) continue;
      try {
        // Fresh read: the steps above, or a staff change a moment ago, may have moved it.
        const snap = await db.collection('market_dates').doc(scanned.id).get();
        if (!snap.exists) continue;
        const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
        if (fresh.status !== 'collecting') continue;
        const r = await sendBoothTexts(db, env, market, fresh, { now, cycle: mode });
        if (r.status === 'claimed') result.skipped_claimed++;
        if (r.status === 'sent') result.booth_texts_sent += r.sent;
      } catch (err) {
        result.errors.push(`${scanned.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

// ─── Phase 4: booth drafts, approval and booth texts ─────────────────────

/** `nextDateAfter` lives with the assignment code (this file imports it); re-exported because the contract names it here. */
export { nextDateAfter };

export type BoothTextsOutcome =
  | { status: 'not_approved' | 'already_sent' | 'claimed' }
  /** A staff change to these assignments is being written (or landed while this pass was reading): the next tick sends. */
  | { status: 'changing' }
  | { status: 'deferred'; deferred_until: Date }
  /** Nothing was sent: two vendors share a booth, or the target date is cancelled or has started. */
  | { status: 'blocked'; reason: BoothTextsBlocked }
  | { status: 'sent'; sent: number; failed: number; excluded: number; duplicates: number };

/** The step-lock key of a booth-text pass: one lock per version of the assignments, so a corrective pass never waits out the first pass's lock. */
function boothTextsLockKey(lockPrefix: string, rev: string | null): string {
  return `${lockPrefix}booth_texts${rev ? `_${rev}` : ''}`;
}

/**
 * Sends one booth text (an assignment, a corrective "is now", or a release
 * notice) and logs it with everything `planBoothTexts` reads back: the type,
 * the assignment row it is about, the booths and a per-vendor sequence number.
 * `keyed` (the engine) makes it at-most-once per assignment; a staff resend is
 * deliberately unkeyed.
 */
async function sendBoothText(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  target: Pick<MarketDateDoc, 'id' | 'date'>,
  sourceDateId: string,
  recipient: Recipient,
  item: BoothTextItem,
  opts: { keyed: boolean; sent_by?: string | null },
): Promise<TrySendSmsResult> {
  const first_name = firstNameOf(recipient.contact_name);
  const date_short = dateShort(target.date);
  const body =
    item.type === 'release'
      ? TEMPLATES.booth_release({ market_name: market.name, date_short, first_name })
      : TEMPLATES.booth({ market_name: market.name, date_short, labels: item.booth_labels, first_name, changed: item.changed });
  const key =
    item.type === 'release'
      ? DEDUPE_KEYS.booth_release(target.id, item.producer_id, item.assignment_id)
      : DEDUPE_KEYS.booth(target.id, item.producer_id, item.assignment_id);
  return trySendSms({
    env,
    db,
    to: recipient.phone,
    body,
    kind: 'booth',
    producer_id: item.producer_id,
    market_date_id: target.id,
    sent_by: opts.sent_by ?? null,
    extra: {
      booth_text: item.type,
      assignment_id: item.assignment_id,
      booth_ids: item.booth_ids,
      booth_labels: item.booth_labels,
      source_date_id: sourceDateId,
      seq: item.seq,
      ...(opts.keyed ? {} : { resend: true }),
    },
    ...(opts.keyed ? { dedupe_key: key } : {}),
  });
}

/**
 * The booth-texts step (contract §3.5, reworked by the Phase 4 fix). Once a
 * cycle's assignments are approved, every vendor is told the booth(s) they hold
 * on the TARGET date as the assignments stand NOW:
 *
 *  - the first pass texts every seated vendor once;
 *  - after a staff change, the next pass sends exactly one corrective text to
 *    each vendor whose booths changed and a short release notice to a vendor
 *    who was told a booth and has been removed - and nothing to anyone else;
 *  - nothing goes out while two vendors share a booth (`conflict`), for a
 *    cancelled target (`cancelled`) or once the target market has started
 *    (`started`); the reason is recorded at `<cycle>.booth_texts_blocked` and
 *    cleared when the texts later go out;
 *  - never during the market's quiet hours, first pass or corrective.
 *
 * What a vendor has been told is read from the `messages` log, and each text is
 * keyed on the vendor's newest current assignment row (`DEDUPE_KEYS.booth`), so
 * overlapping runs and a stale-lock takeover cannot text an assignment twice.
 * A provider failure leaves that vendor's row `failed` and is NOT retried here
 * (as in Phase 3): staff see it and use the resend route. Recipients are
 * `listRecipients` (textable, active, current season); an owed vendor who is
 * not one is counted as `excluded`.
 *
 * Runs under a step lock keyed by the version of the assignments it acts on
 * (`booth_texts`, then `booth_texts_<assignments_rev>` after a staff change),
 * and reads that version again after reading the rows: a change that began
 * meanwhile means the rows may be half-applied, and the pass sends nothing
 * (`changing`) rather than text from them. Writes field paths only.
 */
export async function sendBoothTexts(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; cycle?: CycleMode },
): Promise<BoothTextsOutcome> {
  const { now } = opts;
  const mode = opts.cycle ?? 'next';
  const cycle = cycleOf(date, mode);
  const s = cycle.state;
  const at = (field: string) => `${cycle.path}.${field}`;
  if (!s.approved_at) return { status: 'not_approved' };
  if (boothTextsSettled(s)) return { status: 'already_sent' };

  const allowedAt = boothTextsAllowedAt(s.approved_at, now, market);
  if (allowedAt.getTime() > now.getTime()) return { status: 'deferred', deferred_until: allowedAt };

  const ref = db.collection('market_dates').doc(date.id);
  const rev = s.assignments_rev;
  const targetId = mode === 'opener' ? date.id : s.assignments_target_date_id;
  if (!targetId) throw new Error(`booth texts for ${date.id}: approved but no target date recorded`);
  const target = await loadCycleTarget(db, market, cycle);
  if (!target || target.id !== targetId) throw new Error(`booth texts for ${date.id}: target date ${targetId} not found`);

  // A cancelled or started target never produces "your booth on Sat Apr 10 is V1". Decided before any
  // lock: `cancelled` is re-checked every tick (a date can be un-cancelled) and must not burn a lock each
  // time; `started` is final and records the version so the engine stops looking.
  const targetHold = boothTextsHold(target, 0, now);
  if (targetHold) {
    if (targetHold === 'started') {
      await ref.update({ [at('booth_texts_blocked')]: 'started', [at('booth_texts_rev')]: rev, updated_at: now });
    } else if (s.booth_texts_blocked !== targetHold) {
      await ref.update({ [at('booth_texts_blocked')]: targetHold, updated_at: now });
    }
    return { status: 'blocked', reason: targetHold };
  }

  if (await changeInFlight(db, date.id, mode, now)) return { status: 'changing' };

  const c = await claim(db, date.id, boothTextsLockKey(cycle.lock, rev), now, (a) => boothTextsSettled(cycleStateOf(a, mode)));
  if (c.status === 'claimed') return { status: 'claimed' };
  if (c.status === 'done') return { status: 'already_sent' };

  const rows = await currentAssignments(db, target.id);
  const booths = await listBooths(db, market.id, { includeInactive: true });
  const log = await loadBoothTextLog(db, target.id);
  const { recipients } = await listRecipients(db, market.id, { now });

  // The version again, after the rows: if a staff change began since the first look, what was just read
  // may be half of it. Send nothing; the change leaves `assignments_rev` moved, so the next tick returns.
  const againSnap = await ref.get();
  const again = cycleStateOf(marketDateFromData(againSnap.id, againSnap.data() as Record<string, unknown>).actions, mode);
  if (again.assignments_rev !== rev || (await changeInFlight(db, date.id, mode, now))) return { status: 'changing' };

  // Two vendors on one booth: nobody is texted until staff resolve it (which moves the version).
  if (conflictedBoothIds(rows).length > 0) {
    await ref.update({ [at('booth_texts_blocked')]: 'conflict', [at('booth_texts_rev')]: rev, updated_at: now });
    return { status: 'blocked', reason: 'conflict' };
  }

  const plan = planBoothTexts({ rows, booths, log });
  const recipientById = new Map(recipients.map((r) => [r.producer_id, r]));
  let sent = 0;
  let failed = 0;
  let excluded = 0;
  let duplicates = 0;
  for (const item of plan) {
    if (item.state !== 'owed') continue;
    const recipient = recipientById.get(item.producer_id);
    if (!recipient) {
      excluded++;
      continue;
    }
    const result = await sendBoothText(db, env, market, target, date.id, recipient, item, { keyed: true });
    if (result.ok) sent++;
    else if (result.duplicate) duplicates++;
    else failed++;
  }

  const update: Record<string, unknown> = { [at('booth_texts_rev')]: rev, [at('booth_texts_blocked')]: null, updated_at: now };
  if (!again.booth_texts_sent_at) {
    // The first pass: its counts stay on the document. Vendors a dead run had already texted count as texted.
    const before = plan.filter((p) => p.type === 'assignment');
    update[at('booth_texts_sent_at')] = now;
    update[at('booth_text_recipients')] = sent + duplicates + before.filter((p) => p.state === 'sent' || p.state === 'queued').length;
    update[at('booth_text_failed')] = failed + before.filter((p) => p.state === 'failed').length;
    update[at('booth_text_excluded')] = excluded;
  }
  await ref.update(update);
  return { status: 'sent', sent, failed, excluded, duplicates };
}

export type ResendBoothTextOutcome =
  | { status: 'sent'; sms: 'sent' | 'simulated' | 'failed'; message_id: string | null; type: 'assignment' | 'release'; error?: string }
  | { status: 'not_approved' | 'nothing_to_send' | 'pending' }
  | { status: 'quiet_hours'; allowed_at: Date }
  | { status: 'blocked'; reason: BoothTextsBlocked }
  | { status: 'not_textable'; reason: string };

/**
 * The staff "Resend" button for one vendor's booth text (Phase 4 fix): sends
 * the text that reflects what the vendor holds NOW (or the release notice),
 * with no dedupe key - a resend is an intentional second text. Refused before
 * approval, inside quiet hours, while the texts are held (conflict, cancelled
 * or started target), when the vendor cannot be texted, and while the engine
 * is still about to send that very text (`pending`), so a resend can never
 * race the engine into a double.
 */
export async function resendBoothText(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; producer_id: string; user_id: string; cycle?: CycleMode },
): Promise<ResendBoothTextOutcome> {
  const { now } = opts;
  const mode = opts.cycle ?? 'next';
  const cycle = cycleOf(date, mode);
  const s = cycle.state;
  if (!s.approved_at) return { status: 'not_approved' };

  const allowedAt = nextAllowedInstant(now, market.quiet_hours ?? DEFAULT_QUIET_HOURS, market.timezone);
  if (allowedAt.getTime() > now.getTime()) return { status: 'quiet_hours', allowed_at: allowedAt };

  const target = await loadCycleTarget(db, market, cycle);
  if (!target) return { status: 'nothing_to_send' };
  const rows = await currentAssignments(db, target.id);
  const hold = boothTextsHold(target, conflictedBoothIds(rows).length, now);
  if (hold) return { status: 'blocked', reason: hold };

  const booths = await listBooths(db, market.id, { includeInactive: true });
  const log = await loadBoothTextLog(db, target.id);
  const item = planBoothTexts({ rows, booths, log }).find((p) => p.producer_id === opts.producer_id);
  if (!item) return { status: 'nothing_to_send' };
  const inFlight = item.state === 'queued' && !!item.last && now.getTime() - item.last.created_at.getTime() <= QUEUED_STALE_MS;
  if (inFlight || (item.state === 'owed' && !boothTextsSettled(s))) return { status: 'pending' };

  const { recipients, excluded } = await listRecipients(db, market.id, { now });
  const recipient = recipients.find((r) => r.producer_id === opts.producer_id);
  if (!recipient) {
    return { status: 'not_textable', reason: excluded.find((e) => e.producer_id === opts.producer_id)?.reason ?? 'not_a_current_vendor' };
  }

  const result = await sendBoothText(db, env, market, target, date.id, recipient, item, { keyed: false, sent_by: opts.user_id });
  if (result.ok) return { status: 'sent', sms: result.status, message_id: result.message_id, type: item.type };
  return { status: 'sent', sms: 'failed', message_id: result.message_id, type: item.type, error: result.error };
}

export type ManualDraftOutcome =
  | { status: 'drafted'; draft: DraftResult }
  | { status: 'approved' | 'already_drafted' | 'in_progress' | 'not_opener' | 'season_mismatch' | 'not_ended' }
  | { status: 'skipped'; reason: DraftSkipReason };

/**
 * The staff "Draft" / "Redraft" button (contract §3.4). Refuses cleanly before
 * taking any lock (a refusal never leaves one behind): approved cycles are closed
 * to redrafting; a drafted one needs `redraft`; nothing to draft ONTO (no target
 * date, no booths) is `skipped` and nothing is written. Nobody on the list yet is
 * not a refusal here (Phase 4 fix): the draft is simply empty, and staff add
 * vendors by hand - but only once the market has ended (`not_ended` before
 * that): its check-ins do not exist yet, and an empty draft made months early
 * would stand in for the engine's own draft after the market, which then never
 * runs. The first draft takes the same `drafts` lock as the engine's
 * step, so the two cannot both draft; a redraft takes a lock keyed by the draft
 * version it replaces (`redraft_<assignments_draft_at ms>`), so two concurrent
 * redrafts collide and the next one, after the version moves on, does not.
 *
 * `cycle: 'opener'` drafts the season's first market date for ITSELF, from the
 * vendors on the seasonal plan (the engine never does this on its own); it is
 * refused for any other date (`not_opener`) and while the market's current
 * season is not the season that date belongs to (`season_mismatch`: it would
 * seat last season's vendors). Its locks are prefixed `opener_`.
 */
export async function draftNow(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; actor: string; redraft: boolean; cycle?: CycleMode },
): Promise<ManualDraftOutcome> {
  const { now } = opts;
  const mode = opts.cycle ?? 'next';
  const cycle = cycleOf(date, mode);
  const s = cycle.state;
  if (s.approved_at) return { status: 'approved' };
  if (s.assignments_draft_at && !opts.redraft) return { status: 'already_drafted' };
  if (mode === 'opener') {
    if ((await findSeasonOpener(db, market))?.id !== date.id) return { status: 'not_opener' };
    if (!openerSeasonMatches(market, now)) return { status: 'season_mismatch' };
  } else if (date.end_at.getTime() > now.getTime()) {
    return { status: 'not_ended' };
  }

  const prep = await prepareDraft(db, market, date, now, mode);
  if (!('booths' in prep)) return { status: 'skipped', reason: prep.skipped };

  if (!s.drafts_generated_at) {
    const c = await claim(db, date.id, `${cycle.lock}drafts`, now, (a) => !!cycleStateOf(a, mode).drafts_generated_at);
    if (c.status === 'claimed') return { status: 'in_progress' };
    if (c.status === 'done') return { status: 'already_drafted' };
    const draft = await draftAssignments(db, market, date, { now, actor: opts.actor, mode: 'initial', cycle: mode, allow_empty: true });
    return { status: 'drafted', draft };
  }

  const version = s.assignments_draft_at?.getTime() ?? 0;
  const c = await claim(db, date.id, `${cycle.lock}redraft_${version}`, now, (a) => {
    const fresh = cycleStateOf(a, mode);
    return (fresh.assignments_draft_at?.getTime() ?? 0) !== version || !!fresh.approved_at;
  });
  if (c.status === 'claimed') return { status: 'in_progress' };
  if (c.status === 'done') return { status: 'already_drafted' };
  const draft = await draftAssignments(db, market, date, { now, actor: opts.actor, mode: 'redraft', cycle: mode, allow_empty: true });
  return { status: 'drafted', draft };
}

export type ApproveOutcome =
  | { status: 'approved'; texts: BoothTextsOutcome }
  | { status: 'no_draft' | 'already_approved' | 'in_progress' | 'conflicts' | 'target_cancelled' | 'target_started' };

/**
 * Staff approval of a cycle's drafted assignments (contract §3.4/§3.5). Every
 * refusal is decided BEFORE the `approve` lock is taken (locks are never cleared,
 * so a refused attempt must not leave one): no draft, already approved, two
 * vendors on one booth, and (Phase 4 fix) a target date that is cancelled or has
 * already started - approving those could only ever promise a booth at a market
 * that is not happening. Then, under the lock, writes
 * `approved_at/approved_by/booth_summary` and attempts the booth texts at once; a
 * quiet-hours deferral is reported and the engine sends them later.
 */
export async function approveAssignments(
  db: Firestore,
  env: Env,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; user_id: string; cycle?: CycleMode },
): Promise<ApproveOutcome> {
  const { now } = opts;
  const mode = opts.cycle ?? 'next';
  const cycle = cycleOf(date, mode);
  const s = cycle.state;
  const at = (field: string) => `${cycle.path}.${field}`;
  if (s.approved_at) return { status: 'already_approved' };
  const targetId = s.assignments_target_date_id;
  if (!targetId || !s.assignments_draft_at) return { status: 'no_draft' };
  const target = await loadCycleTarget(db, market, cycle);
  if (!target || target.id !== targetId) return { status: 'no_draft' };
  if (target.status === 'cancelled') return { status: 'target_cancelled' };
  if (target.start_at.getTime() <= now.getTime()) return { status: 'target_started' };
  const rows = await currentAssignments(db, targetId);
  if (conflictedBoothIds(rows).length > 0) return { status: 'conflicts' };

  const c = await claim(db, date.id, `${cycle.lock}approve`, now, (a) => !!cycleStateOf(a, mode).approved_at);
  if (c.status === 'claimed') return { status: 'in_progress' };
  if (c.status === 'done') return { status: 'already_approved' };

  const booths = await listBooths(db, market.id);
  const attendance = await loadAttendance(db, market, date, now, mode);
  const summary = computeBoothSummary(
    booths,
    seatedVendors(attendance, rows, mode).attending.map((v) => v.producer_id),
    rows,
  );
  const ref = db.collection('market_dates').doc(date.id);
  await ref.update({
    [at('approved_at')]: now,
    [at('approved_by')]: opts.user_id,
    [at('booth_summary')]: summary,
    updated_at: now,
  });

  const snap = await ref.get();
  const fresh = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
  const texts = await sendBoothTexts(db, env, market, fresh, { now, cycle: mode });
  return { status: 'approved', texts };
}
