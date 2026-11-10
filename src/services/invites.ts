import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { isAlreadyExists } from '../db/firestore.js';
import { localToUtc, addDays } from '../utils/tz.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { escapeHtml, htmlLink } from '../utils/html.js';
import { sendEmail } from './email.js';
import { splitMessage, trySendSms, type TrySendSmsResult } from './sms.js';
import { applicationsOpen, marketFees, quietUntil, type FarmersMarket } from './markets.js';
import { listMembershipsForMarket } from './seasons.js';
import { mintPurposeToken, purposeTokenUrl, resolvePurposeToken } from './purpose-tokens.js';
import { normalizeEmail } from './identity.js';

/**
 * Invite-to-reapply and the acceptance sends (Phase 4 contract §2.5, §3.2,
 * §3.3, decision D30/D33). Every outbound text goes through the logged
 * `trySendSms`; the first invite of a (market, season, producer) carries a
 * dedupe key and is also guarded by an atomically created
 * `application_invites` document, a forced resend carries neither.
 *
 * Quiet hours (Phase 4 fix X5). These texts are triggered by staff, at
 * whatever hour staff happen to work, so each send asks the market first
 * (`quietUntil`): inside the market's quiet window the email still goes, the
 * text does not (`skipped_quiet_hours`), and the invite record keeps the two
 * channels apart so a later run sends exactly what is still missing.
 *
 * Phone numbers and email addresses are never logged here.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

export const APPLICATION_TOKEN_FALLBACK_DAYS = 120;
export const AGREEMENT_TOKEN_DAYS = 60;

export type SmsOutcome = 'sent' | 'simulated' | 'failed' | 'duplicate' | 'skipped_no_phone' | 'skipped_opted_out' | 'skipped_quiet_hours';
export type EmailOutcome = 'sent' | 'simulated' | 'failed' | 'skipped_no_email';

/** The text reached the provider (or its log row already existed): nothing more to send on this channel. */
export function smsDelivered(status: string): boolean {
  return status === 'sent' || status === 'simulated' || status === 'duplicate';
}

export function emailDelivered(status: string): boolean {
  return status === 'sent' || status === 'simulated';
}

/* ── Text templates (ASCII only) ── */

function greeting(firstName: string): string {
  return firstName ? `${firstName}, ` : '';
}

/** The acceptance text is at most this many SMS segments, as `splitMessage` (services/sms.ts) splits it. */
export const ACCEPTANCE_MAX_SEGMENTS = 2;

/**
 * The acceptance text (Phase 4 fix X14): the news, the agreement link, where
 * the details are, and the opt-out line. The amounts and the payment link live
 * in the email, not here: with them a production-shaped message (a 19-character
 * APP_URL, a 43-character token, a 31-character market name) was 336
 * characters and went out as three SMS, the link alone in the second.
 *
 * Laid out for `splitMessage`, which breaks at the last newline inside each
 * 153-character window: the first line is segment one, the link and the
 * opt-out line together are segment two, so the link is never cut and never
 * travels alone. A long market name or first name would push the first line
 * over a segment, so the wording is fitted: with the first name; without it;
 * then with the market name shortened, a character at a time, until the whole
 * text is `ACCEPTANCE_MAX_SEGMENTS` segments. When no wording can fit (a link
 * longer than a segment, or a name outside the GSM alphabet, which drops a
 * segment to 67 characters) the full wording is sent rather than a mangled one.
 */
function acceptanceText(p: { season: string; market_name: string; first_name: string; agreement_link: string; details_in_email: boolean }): string {
  const head = (firstName: string, marketName: string): string =>
    `SJCA Markets: your ${p.season} ${marketName} application is approved${firstName ? `, ${firstName}` : ''}!${p.details_in_email ? ' Details are in your email.' : ''}`;
  const tail = `Sign your Hold Harmless agreement: ${p.agreement_link}\nReply STOP to opt out.`;
  const build = (firstName: string, marketName: string): string => `${head(firstName, marketName)}\n${tail}`;
  // Fits: the whole text is within the limit AND the split falls on the line break, so the two
  // texts that arrive are the two halves as written, never a sentence cut in the middle.
  const fits = (firstName: string, marketName: string): boolean => {
    const parts = splitMessage(build(firstName, marketName));
    return parts.length === 1 || (parts.length <= ACCEPTANCE_MAX_SEGMENTS && parts[0] === head(firstName, marketName));
  };

  if (fits(p.first_name, p.market_name) || !fits('', '')) return build(p.first_name, p.market_name);
  let marketName = p.market_name;
  while (!fits('', marketName) && marketName.length > 0) marketName = marketName.slice(0, -1).trimEnd();
  return build('', marketName);
}

export const TEMPLATES_A1 = {
  /**
   * Sent when an application is approved. `details_in_email` is true when the
   * acceptance email went out with it (the fee, the payment link, insurance and
   * the first market day are there); false leaves that sentence out.
   */
  acceptance: acceptanceText,
  application_invite: (p: { season: string; market_name: string; first_name: string; link: string }): string =>
    `SJCA Markets: applications for the ${p.season} ${p.market_name} season are open. ${greeting(p.first_name)}${p.first_name ? 'your' : 'Your'} returning-vendor application is prefilled here: ${p.link}\nReply STOP to opt out.`,
} as const;

export function firstNameOf(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/* ── Small send helpers ── */

export function smsOutcome(result: TrySendSmsResult): SmsOutcome {
  if (result.ok) return result.status;
  return result.duplicate ? 'duplicate' : 'failed';
}

/** Email through the logged-to-console / Resend wrapper; never throws. */
export async function trySendEmail(env: Env, to: string, subject: string, message: string): Promise<'sent' | 'simulated' | 'failed'> {
  try {
    await sendEmail({ env, to, subject, message });
    return env.EMAIL_PROVIDER === 'console' ? 'simulated' : 'sent';
  } catch (err) {
    console.error('Application email failed:', err instanceof Error ? err.message : String(err));
    return 'failed';
  }
}

/** Why a producer cannot be texted right now, or null when they can. */
export function textBlocker(producer: Record<string, unknown>): 'skipped_no_phone' | 'skipped_opted_out' | null {
  const phone = typeof producer.phone === 'string' ? producer.phone : '';
  if (!E164_RE.test(phone)) return 'skipped_no_phone';
  if (toDate(producer.sms_opt_out_at)) return 'skipped_opted_out';
  return null;
}

export function producerEmail(producer: Record<string, unknown>): string | null {
  const direct = normalizeEmail(typeof producer.email === 'string' ? producer.email : null);
  if (direct) return direct;
  const list = Array.isArray(producer.emails) ? (producer.emails as unknown[]) : [];
  for (const e of list) {
    const n = normalizeEmail(typeof e === 'string' ? e : null);
    if (n) return n;
  }
  return null;
}

/** Every address on file for a producer (`email` and `emails[]`), normalised and de-duplicated. */
export function producerEmails(producer: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const candidates: unknown[] = [producer.email, ...(Array.isArray(producer.emails) ? (producer.emails as unknown[]) : [])];
  for (const candidate of candidates) {
    const n = normalizeEmail(typeof candidate === 'string' ? candidate : null);
    if (n) out.add(n);
  }
  return [...out];
}

/** An application link expires at the market-local midnight after `application_close`, else 120 days out. */
export function applicationTokenExpiry(market: FarmersMarket, now: Date): Date {
  const close = market.season?.application_close;
  if (close) return localToUtc(addDays(close, 1), '00:00', market.timezone || 'UTC');
  return new Date(now.getTime() + APPLICATION_TOKEN_FALLBACK_DAYS * 24 * 60 * 60 * 1000);
}

/* ── Single invite ── */

export function inviteDocId(marketId: string, season: string, producerId: string): string {
  return `${marketId}_${season}_${producerId}`;
}

export interface InviteResend {
  at: Date;
  by: string;
  token: string;
  email_status: string;
  sms_status: string;
}

/** A later run that sent a channel the first run could not (quiet hours, no phone yet, a failed email). */
export interface InviteCompletion {
  at: Date;
  by: string;
  /** null when that channel was not attempted on this run. */
  email_status: string | null;
  sms_status: string | null;
}

/**
 * `pending` is what a channel reads between the atomic `create()` of the
 * invite and its send: a request that died in that gap leaves a record that
 * says, truthfully, that nothing went out, and the next run completes it.
 */
export type InviteEmailStatus = EmailOutcome | 'pending';
export type InviteSmsStatus = SmsOutcome | 'pending';

export interface ApplicationInviteDoc {
  market_id: string;
  season: string;
  producer_id: string;
  token: string;
  email: string | null;
  email_status: InviteEmailStatus;
  /** When the email went out (the latest one); null while it has not. Tracked apart from the text. */
  email_sent_at: Date | null;
  phone: string | null;
  sms_status: InviteSmsStatus;
  /** When the text went out (the latest one); null while it has not. */
  sms_sent_at: Date | null;
  message_id: string | null;
  sent_by: string;
  sent_at: Date;
  resends: InviteResend[];
  completions: InviteCompletion[];
}

export function inviteFromData(data: Record<string, unknown>): ApplicationInviteDoc {
  const resends = Array.isArray(data.resends) ? (data.resends as Record<string, unknown>[]) : [];
  const completions = Array.isArray(data.completions) ? (data.completions as Record<string, unknown>[]) : [];
  const emailStatus = (typeof data.email_status === 'string' ? data.email_status : 'skipped_no_email') as InviteEmailStatus;
  const smsStatus = (typeof data.sms_status === 'string' ? data.sms_status : 'skipped_no_phone') as InviteSmsStatus;
  const sentAt = toDateOrEpoch(data.sent_at);
  return {
    market_id: String(data.market_id ?? ''),
    season: String(data.season ?? ''),
    producer_id: String(data.producer_id ?? ''),
    token: String(data.token ?? ''),
    email: typeof data.email === 'string' ? data.email : null,
    email_status: emailStatus,
    // A record written before the channels were tracked apart sent both when it was created.
    email_sent_at: toDate(data.email_sent_at) ?? (emailDelivered(emailStatus) ? sentAt : null),
    phone: typeof data.phone === 'string' ? data.phone : null,
    sms_status: smsStatus,
    sms_sent_at: toDate(data.sms_sent_at) ?? (smsDelivered(smsStatus) ? sentAt : null),
    message_id: typeof data.message_id === 'string' ? data.message_id : null,
    sent_by: String(data.sent_by ?? ''),
    sent_at: sentAt,
    resends: resends.map((r) => ({
      at: toDateOrEpoch(r.at),
      by: String(r.by ?? ''),
      token: String(r.token ?? ''),
      email_status: String(r.email_status ?? ''),
      sms_status: String(r.sms_status ?? ''),
    })),
    completions: completions.map((c) => ({
      at: toDateOrEpoch(c.at),
      by: String(c.by ?? ''),
      email_status: typeof c.email_status === 'string' ? c.email_status : null,
      sms_status: typeof c.sms_status === 'string' ? c.sms_status : null,
    })),
  };
}

/** `${APP_URL}/rules?market=<id>`: the public rules page of a market. */
function rulesUrl(appUrl: string, marketId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/rules?market=${encodeURIComponent(marketId)}`;
}

/**
 * The invitation email. The body is HTML (`sendEmail` inserts it as it is,
 * turning newlines into <br>): every interpolated value goes through
 * `escapeHtml`, and every address through `htmlLink` (Phase 4 fix X6).
 */
export function inviteEmailBody(market: FarmersMarket, season: string, link: string, appUrl: string): string {
  const fees = marketFees(market);
  const e = escapeHtml;
  return [
    `Hello,`,
    ``,
    `Applications for the ${e(season)} ${e(market.name)} season are open. Every vendor applies again each season. Your returning-vendor application is already filled in with what we have on file; please review it and submit it here:`,
    htmlLink(link),
    ``,
    `A non-refundable application fee of $${e(fees.application_fee)} is paid after you submit.`,
    `Market rules: ${htmlLink(rulesUrl(appUrl, market.id))}`,
    ``,
    `St. Joseph Center of Arkansas - SJCA Markets`,
  ].join('\n');
}

/**
 * What a run would send for one producer, decided from the invite record (if
 * any), the producer as they are now and the hour. Pure, so the dry run and
 * the real run can never disagree.
 *
 *   first    no record yet: the email (when there is an address) and the text
 *            (unless `hold` says why not);
 *   resend   `force` over an existing record: both channels again, the text
 *            without a dedupe key (a deliberate repeat);
 *   complete an existing record with a channel still missing that can go out
 *            now: the email when it never went (no address then, or it
 *            failed), the text when it was skipped (quiet hours, no phone
 *            then, opted out then) and nothing holds it now. A text the
 *            provider FAILED is not retried here: its log row holds the dedupe
 *            key, so only a forced resend can send it again;
 *   none     an existing record with nothing to add right now.
 */
export function planInvite(
  existing: ApplicationInviteDoc | null,
  opts: { force: boolean; email: string | null; hold: SmsOutcome | null },
): { action: 'first' | 'resend' | 'complete' | 'none'; email: boolean; sms: boolean } {
  if (!existing || opts.force) return { action: existing ? 'resend' : 'first', email: !!opts.email, sms: !opts.hold };
  const email = !emailDelivered(existing.email_status) && !!opts.email;
  const sms = !smsDelivered(existing.sms_status) && existing.sms_status !== 'failed' && !opts.hold;
  return { action: email || sms ? 'complete' : 'none', email, sms };
}

/** Why the text of an invite cannot go out right now (the producer first, then the hour), or null. */
function inviteTextHold(producer: Record<string, unknown>, quiet: Date | null): SmsOutcome | null {
  return textBlocker(producer) ?? (quiet ? 'skipped_quiet_hours' : null);
}

export type InviteResult =
  /** `completed`: an existing invite had a missing channel sent on this run (same token). */
  | { status: 'invited'; invite: ApplicationInviteDoc; url: string; resent: boolean; completed: boolean }
  | { status: 'already'; invite: ApplicationInviteDoc };

/**
 * Invite one producer to apply for `season`, or finish an invite an earlier
 * run could only half send.
 *
 * The first invite `create()`s the record (the lock: two admins inviting at
 * once produce one invite) and sends the email and, outside quiet hours, the
 * text under the dedupe key `application_invite:<market>:<season>:<producer>`.
 * A later run without `force` sends only what is still missing, with the SAME
 * token and the SAME dedupe key, so re-running the invite after quiet hours
 * texts exactly the producers who have not been texted, and a producer who
 * gained a phone number since gets the text. `force` re-sends both channels
 * (a new token, appended to `resends`, no dedupe key).
 *
 * The caller has already checked that applications are open for `season`.
 */
export async function inviteProducer(args: {
  db: Firestore;
  env: Env;
  market: FarmersMarket;
  season: string;
  producerId: string;
  producer: Record<string, unknown>;
  actor: string;
  force: boolean;
  now: Date;
}): Promise<InviteResult> {
  const { db, env, market, season, producerId, producer, actor, force, now } = args;
  const ref = db.collection('application_invites').doc(inviteDocId(market.id, season, producerId));
  const existingSnap = await ref.get();
  const existing = existingSnap.exists ? inviteFromData(existingSnap.data() as Record<string, unknown>) : null;

  const email = producerEmail(producer);
  const phone = typeof producer.phone === 'string' && E164_RE.test(producer.phone) ? producer.phone : null;
  const hold = inviteTextHold(producer, quietUntil(market, now));
  const plan = planInvite(existing, { force, email, hold });
  const dedupeKey = `application_invite:${market.id}:${season}:${producerId}`;
  const firstName = firstNameOf(typeof producer.contact_name === 'string' ? producer.contact_name : '');
  const subject = `Apply for the ${season} ${market.name} season`;
  const read = async () => inviteFromData(((await ref.get()).data() ?? {}) as Record<string, unknown>);

  const sendText = (token: string, url: string, keyed: boolean) =>
    trySendSms({
      env,
      db,
      to: phone as string,
      body: TEMPLATES_A1.application_invite({ season, market_name: market.name, first_name: firstName, link: url }),
      kind: 'application_invite',
      producer_id: producerId,
      sent_by: actor,
      extra: { token, market_id: market.id, season },
      ...(keyed ? { dedupe_key: dedupeKey } : {}),
    });

  /* ── An existing invite, not forced: send what is still missing, or nothing ── */
  if (existing && plan.action !== 'resend') {
    const waiting = !smsDelivered(existing.sms_status) && existing.sms_status !== 'failed';
    if (plan.action === 'none') {
      // Keep the record honest about WHY the text is still waiting (it was "no phone", now it is "quiet hours").
      if (waiting && hold && hold !== existing.sms_status) {
        await ref.update({ sms_status: hold, phone, updated_at: now });
        return { status: 'already', invite: await read() };
      }
      return { status: 'already', invite: existing };
    }

    // The same link the email (or an earlier text) carried, unless it can no longer be opened.
    let token = existing.token;
    const resolved = await resolvePurposeToken(db, token, 'application', now);
    if (resolved.status !== 'ok') {
      token = (
        await mintPurposeToken(db, {
          purpose: 'application',
          producer_id: producerId,
          market_id: market.id,
          season,
          expires_at: applicationTokenExpiry(market, now),
          now,
          created_by: actor,
        })
      ).token;
    }
    const url = purposeTokenUrl(env.APP_URL, 'application', token);

    const update: Record<string, unknown> = { token, updated_at: now };
    const tokenUpdate: Record<string, unknown> = {};
    let emailStatus: EmailOutcome | null = null;
    let smsStatus: SmsOutcome | null = null;
    if (plan.email && email) {
      emailStatus = await trySendEmail(env, email, subject, inviteEmailBody(market, season, url, env.APP_URL));
      update.email = email;
      update.email_status = emailStatus;
      if (emailDelivered(emailStatus)) {
        update.email_sent_at = now;
        tokenUpdate.email_sent_at = now;
      }
    }
    if (plan.sms && phone) {
      const result = await sendText(token, url, true);
      smsStatus = smsOutcome(result);
      update.phone = phone;
      update.sms_status = smsStatus;
      update.message_id = result.message_id;
      if (smsDelivered(smsStatus)) update.sms_sent_at = now;
      if (result.message_id) tokenUpdate.sent_message_id = result.message_id;
    } else if (waiting && hold && hold !== existing.sms_status) {
      update.sms_status = hold;
      update.phone = phone;
    }
    update.completions = [...existing.completions, { at: now, by: actor, email_status: emailStatus, sms_status: smsStatus }];
    if (Object.keys(tokenUpdate).length > 0) await db.collection('link_tokens').doc(token).update(tokenUpdate);
    await ref.update(update);
    return { status: 'invited', invite: await read(), url, resent: false, completed: true };
  }

  /* ── A first invite, or a forced resend: a fresh token ── */
  const tokenDoc = await mintPurposeToken(db, {
    purpose: 'application',
    producer_id: producerId,
    market_id: market.id,
    season,
    expires_at: applicationTokenExpiry(market, now),
    now,
    created_by: actor,
  });
  const url = purposeTokenUrl(env.APP_URL, 'application', tokenDoc.token);

  let resent = !!existing;
  if (!existing) {
    const initial = {
      market_id: market.id,
      season,
      producer_id: producerId,
      token: tokenDoc.token,
      email,
      email_status: email ? ('pending' as const) : ('skipped_no_email' as const),
      email_sent_at: null,
      phone,
      sms_status: hold ?? ('pending' as const),
      sms_sent_at: null,
      message_id: null,
      sent_by: actor,
      sent_at: now,
      resends: [] as unknown[],
      completions: [] as unknown[],
    };
    try {
      await ref.create(initial);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Another admin invited this producer between our read and this write.
      if (!force) {
        await db.collection('link_tokens').doc(tokenDoc.token).delete();
        return { status: 'already', invite: await read() };
      }
      resent = true;
    }
  }

  // Sends. A first invite is idempotent by dedupe key; a forced resend is deliberate and carries none.
  let emailStatus: EmailOutcome = 'skipped_no_email';
  if (email) emailStatus = await trySendEmail(env, email, subject, inviteEmailBody(market, season, url, env.APP_URL));

  let smsStatus: SmsOutcome = hold ?? 'failed';
  let messageId: string | null = null;
  if (!hold && phone) {
    const result = await sendText(tokenDoc.token, url, !resent);
    smsStatus = smsOutcome(result);
    messageId = result.message_id;
  }

  const tokenUpdate: Record<string, unknown> = {};
  if (messageId) tokenUpdate.sent_message_id = messageId;
  if (emailDelivered(emailStatus)) tokenUpdate.email_sent_at = now;
  if (Object.keys(tokenUpdate).length > 0) await db.collection('link_tokens').doc(tokenDoc.token).update(tokenUpdate);

  const update: Record<string, unknown> = { email_status: emailStatus, sms_status: smsStatus, message_id: messageId, updated_at: now };
  if (emailDelivered(emailStatus)) update.email_sent_at = now;
  if (smsDelivered(smsStatus)) update.sms_sent_at = now;
  if (resent) {
    const current = await read();
    update.resends = [...current.resends, { at: now, by: actor, token: tokenDoc.token, email_status: emailStatus, sms_status: smsStatus }];
    update.token = tokenDoc.token;
    update.email = email;
    update.phone = phone;
  }
  await ref.update(update);

  return { status: 'invited', invite: await read(), url, resent, completed: false };
}

/* ── Bulk: invite every returning producer ── */

export interface InviteBatchResult {
  season: string;
  /** False on a dry run made while the application window is closed (a real run is refused then). */
  applications_open: boolean;
  candidates: number;
  /** Producers invited on this run (a first invite, or a forced resend). */
  invited: number;
  /** Producers already invited who had a missing channel (usually the text) sent on this run. */
  completed: number;
  skipped_already: number;
  skipped_applied: number;
  skipped_no_contact: number;
  /** Texts that did not go out because it is quiet hours at the market; run the invite again after `quiet_until`. */
  held_quiet_hours: number;
  quiet_until: Date | null;
  results: { producer_id: string; business_name: string; email_status: string; sms_status: string }[];
}

export async function inviteReapply(args: {
  db: Firestore;
  env: Env;
  market: FarmersMarket;
  season: string;
  actor: string;
  force: boolean;
  dryRun: boolean;
  now: Date;
}): Promise<InviteBatchResult> {
  const { db, env, market, season, actor, force, dryRun, now } = args;
  const memberships = await listMembershipsForMarket(db, market.id);
  const quiet = quietUntil(market, now);

  const otherSeason = new Set<string>();
  const thisSeason = new Set<string>();
  for (const m of memberships) {
    if (m.season !== season) otherSeason.add(m.producer_id);
    else if (m.status !== 'inactive') thisSeason.add(m.producer_id);
  }

  // Producers that already have a live application for (market, season): named on the application
  // (approved, or submitted through the prefill link), or recognisable by its contact email. A
  // returning vendor who typed the public form from scratch is matched by email, the same identity
  // rule approval uses (never by name), so they are not invited to apply a second time (fix X12).
  const appSnap = await db.collection('applications').where('market_id', '==', market.id).get();
  const applied = new Set<string>();
  const appliedEmails = new Set<string>();
  for (const d of appSnap.docs) {
    const a = d.data() as Record<string, unknown>;
    if (a.season !== season || a.status === 'declined' || a.status === 'withdrawn') continue;
    if (typeof a.producer_id === 'string') applied.add(a.producer_id);
    if (typeof a.prefill_producer_id === 'string') applied.add(a.prefill_producer_id);
    const contact = a.contact && typeof a.contact === 'object' ? (a.contact as Record<string, unknown>) : {};
    const contactEmail = normalizeEmail(typeof contact.email === 'string' ? contact.email : null);
    if (contactEmail) appliedEmails.add(contactEmail);
  }

  const out: InviteBatchResult = {
    season,
    applications_open: applicationsOpen(market, now),
    candidates: 0,
    invited: 0,
    completed: 0,
    skipped_already: 0,
    skipped_applied: 0,
    skipped_no_contact: 0,
    held_quiet_hours: 0,
    quiet_until: quiet,
    results: [],
  };

  const producerIds = [...otherSeason].sort();
  for (const producerId of producerIds) {
    const doc = await db.collection('producers').doc(producerId).get();
    if (!doc.exists) continue;
    const producer = doc.data() as Record<string, unknown>;
    if (producer.active === false) continue;
    out.candidates += 1;
    const businessName = String(producer.business_name ?? '');

    if (applied.has(producerId) || thisSeason.has(producerId) || producerEmails(producer).some((e) => appliedEmails.has(e))) {
      out.skipped_applied += 1;
      continue;
    }

    const email = producerEmail(producer);
    const blocker = textBlocker(producer);
    if (!email && blocker === 'skipped_no_phone') {
      out.skipped_no_contact += 1;
      out.results.push({ producer_id: producerId, business_name: businessName, email_status: 'skipped_no_email', sms_status: 'skipped_no_phone' });
      continue;
    }

    if (dryRun) {
      const snap = await db.collection('application_invites').doc(inviteDocId(market.id, season, producerId)).get();
      const existing = snap.exists ? inviteFromData(snap.data() as Record<string, unknown>) : null;
      const hold = inviteTextHold(producer, quiet);
      const plan = planInvite(existing, { force, email, hold });
      const textWaits = !existing || force || (!smsDelivered(existing.sms_status) && existing.sms_status !== 'failed');
      const smsStatus = plan.sms ? 'would_send' : textWaits && hold ? hold : (existing?.sms_status ?? 'skipped_no_phone');
      if (smsStatus === 'skipped_quiet_hours') out.held_quiet_hours += 1;
      if (plan.action === 'none') {
        out.skipped_already += 1;
        continue;
      }
      if (plan.action === 'complete') out.completed += 1;
      else out.invited += 1;
      out.results.push({
        producer_id: producerId,
        business_name: businessName,
        email_status: plan.email ? 'would_send' : (existing && !force ? existing.email_status : 'skipped_no_email'),
        sms_status: smsStatus,
      });
      continue;
    }

    const result = await inviteProducer({ db, env, market, season, producerId, producer, actor, force, now });
    if (result.invite.sms_status === 'skipped_quiet_hours') out.held_quiet_hours += 1;
    if (result.status === 'already') {
      out.skipped_already += 1;
      continue;
    }
    if (result.completed) out.completed += 1;
    else out.invited += 1;
    out.results.push({
      producer_id: producerId,
      business_name: businessName,
      email_status: result.invite.email_status,
      sms_status: result.invite.sms_status,
    });
  }
  return out;
}

/* ── Acceptance (sent when an admin approves an application) ── */

export interface AcceptanceTotals {
  rate: 'seasonal' | 'daily';
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  booth_fee: number;
  electric_fee: number;
  total: number;
  basis: 'season' | 'per_market';
  installments: number;
}

/**
 * The acceptance email. HTML, like the invitation: the first name is what the
 * applicant typed on the public form, so it and every other interpolated
 * value is escaped (Phase 4 fix X6).
 */
export function acceptanceEmailBody(p: {
  market: FarmersMarket;
  season: string;
  firstName: string;
  agreementUrl: string;
  totals: AcceptanceTotals;
  boothFeeUrl: string | null;
  insuranceHelpUrl: string | null;
  /** The market's `legal.insurance_requirements_text`; '' leaves the sentence out. */
  insuranceRequirementsText: string;
  firstDate: string | null;
  appUrl: string;
}): string {
  const t = p.totals;
  const e = escapeHtml;
  const lines: string[] = [];
  lines.push(p.firstName ? `Hello ${e(p.firstName)},` : 'Hello,');
  lines.push('');
  lines.push(`Your ${e(p.season)} ${e(p.market.name)} application has been approved.`);
  lines.push('');
  lines.push(
    `Booth: ${t.rate === 'seasonal' ? 'seasonal' : 'daily'} rate, ${e(t.spaces)} ${t.spaces === 1 ? 'space' : 'spaces'}, electricity ${t.electric ? 'yes' : 'no'}${t.rate === 'seasonal' ? `, ${t.pay_in_full ? 'paying in full' : 'paying in installments'}` : ''}.`,
  );
  lines.push(
    t.basis === 'per_market'
      ? `Booth fee: $${e(t.total)} per market.`
      : `Booth fee: $${e(t.total)} for the season${t.installments > 1 ? `, in ${e(t.installments)} installments` : ''}.`,
  );
  lines.push('');
  lines.push(`Step 1 - sign the Hold Harmless agreement: ${htmlLink(p.agreementUrl)}`);
  if (p.boothFeeUrl) lines.push(`Step 2 - pay your booth fee: ${htmlLink(p.boothFeeUrl)}`);
  // What insurance the market asks for is the market's wording (`legal.insurance_requirements_text`), never this code's.
  const requirements = p.insuranceRequirementsText.trim();
  if (requirements || p.insuranceHelpUrl) lines.push('');
  if (requirements) lines.push(e(requirements));
  if (p.insuranceHelpUrl) lines.push(`Insurance information: ${htmlLink(p.insuranceHelpUrl)}`);
  if (p.firstDate) {
    lines.push('');
    lines.push(`The first market day of the season is ${e(p.firstDate)}.`);
  }
  lines.push('');
  lines.push(`Market rules: ${htmlLink(rulesUrl(p.appUrl, p.market.id))}`);
  lines.push('');
  lines.push('St. Joseph Center of Arkansas - SJCA Markets');
  return lines.join('\n');
}

export interface AcceptanceSends {
  sms: SmsOutcome;
  email: boolean;
  /** Set when the text was held for the market's quiet hours: when they end. Staff send the agreement link after that. */
  quiet_until: Date | null;
}

/**
 * The text and the email that go out with an approval. Both are best-effort
 * (an approval never fails because a message did); the text is idempotent per
 * application (`acceptance:<application_id>`). The email is attempted when the
 * deployment has a sender address, or runs the console provider.
 *
 * Inside the market's quiet hours the email goes and the text does not
 * (`skipped_quiet_hours`): an approval at 23:00 must not buzz a phone. Staff
 * send the agreement link later through POST /api/memberships/:id/agreement-link.
 */
export async function sendAcceptance(args: {
  db: Firestore;
  env: Env;
  market: FarmersMarket;
  season: string;
  applicationId: string;
  membershipId: string;
  producerId: string;
  producer: Record<string, unknown>;
  contactName: string;
  contactEmail: string;
  agreementToken: string;
  agreementUrl: string;
  totals: AcceptanceTotals;
  boothFeeUrl: string | null;
  insuranceHelpUrl: string | null;
  insuranceRequirementsText: string;
  firstDate: string | null;
  actor: string;
  now: Date;
}): Promise<AcceptanceSends> {
  const { db, env, market, season } = args;
  const firstName = firstNameOf(args.contactName);

  // The email goes first: it carries the amounts and the payment link, and the text
  // only says "details are in your email" when that email really went out.
  let email = false;
  if (env.FROM_EMAIL !== '' || env.EMAIL_PROVIDER === 'console') {
    const outcome = await trySendEmail(
      env,
      args.contactEmail,
      `[SJCA Markets] Your ${season} ${market.name} application is approved`,
      acceptanceEmailBody({
        market,
        season,
        firstName,
        agreementUrl: args.agreementUrl,
        totals: args.totals,
        boothFeeUrl: args.boothFeeUrl,
        insuranceHelpUrl: args.insuranceHelpUrl,
        insuranceRequirementsText: args.insuranceRequirementsText,
        firstDate: args.firstDate,
        appUrl: env.APP_URL,
      }),
    );
    email = outcome !== 'failed';
  }

  let sms: SmsOutcome;
  let quiet_until: Date | null = null;
  const blocker = textBlocker(args.producer);
  const quiet = quietUntil(market, args.now);
  if (blocker) {
    sms = blocker;
  } else if (quiet) {
    sms = 'skipped_quiet_hours';
    quiet_until = quiet;
  } else {
    const result = await trySendSms({
      env,
      db,
      to: args.producer.phone as string,
      body: TEMPLATES_A1.acceptance({
        season,
        market_name: market.name,
        first_name: firstName,
        agreement_link: args.agreementUrl,
        details_in_email: email,
      }),
      kind: 'acceptance',
      producer_id: args.producerId,
      sent_by: args.actor,
      extra: { application_id: args.applicationId, membership_id: args.membershipId, token: args.agreementToken },
      dedupe_key: `acceptance:${args.applicationId}`,
    });
    sms = smsOutcome(result);
  }

  return { sms, email, quiet_until };
}
