import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { isAlreadyExists } from '../db/firestore.js';
import { localToUtc, addDays } from '../utils/tz.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { sendEmail } from './email.js';
import { trySendSms, type TrySendSmsResult } from './sms.js';
import { marketFees, type FarmersMarket } from './markets.js';
import { listMembershipsForMarket } from './seasons.js';
import { mintPurposeToken, purposeTokenUrl } from './purpose-tokens.js';
import { normalizeEmail } from './identity.js';

/**
 * Invite-to-reapply and the acceptance sends (Phase 4 contract §2.5, §3.2,
 * §3.3, decision D30/D33). Every outbound text goes through the logged
 * `trySendSms`; the first invite of a (market, season, producer) carries a
 * dedupe key and is also guarded by an atomically created
 * `application_invites` document, a forced resend carries neither.
 *
 * Phone numbers and email addresses are never logged here.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

export const APPLICATION_TOKEN_FALLBACK_DAYS = 120;
export const AGREEMENT_TOKEN_DAYS = 60;

export type SmsOutcome = 'sent' | 'simulated' | 'failed' | 'duplicate' | 'skipped_no_phone' | 'skipped_opted_out';
export type EmailOutcome = 'sent' | 'simulated' | 'failed' | 'skipped_no_email';

/* ── Text templates (ASCII only) ── */

function greeting(firstName: string): string {
  return firstName ? `${firstName}, ` : '';
}

export const TEMPLATES_A1 = {
  /** Sent when an application is approved: the Hold Harmless link and (when the market has one) the booth-fee payment link. */
  acceptance: (p: {
    season: string;
    market_name: string;
    first_name: string;
    agreement_link: string;
    total: number;
    per_market: boolean;
    booth_fee_url: string | null;
  }): string => {
    const lines = [
      `SJCA Markets: your ${p.season} ${p.market_name} application is approved${p.first_name ? `, ${p.first_name}` : ''}! Please sign the Hold Harmless agreement here: ${p.agreement_link}`,
    ];
    lines.push(`Booth fee: $${p.total}${p.per_market ? ' per market' : ''}.${p.booth_fee_url ? ` Pay here: ${p.booth_fee_url}` : ''}`);
    lines.push('Reply STOP to opt out.');
    return lines.join('\n');
  },
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

export interface ApplicationInviteDoc {
  market_id: string;
  season: string;
  producer_id: string;
  token: string;
  email: string | null;
  email_status: EmailOutcome | 'simulated';
  phone: string | null;
  sms_status: SmsOutcome;
  message_id: string | null;
  sent_by: string;
  sent_at: Date;
  resends: InviteResend[];
}

export function inviteFromData(data: Record<string, unknown>): ApplicationInviteDoc {
  const resends = Array.isArray(data.resends) ? (data.resends as Record<string, unknown>[]) : [];
  return {
    market_id: String(data.market_id ?? ''),
    season: String(data.season ?? ''),
    producer_id: String(data.producer_id ?? ''),
    token: String(data.token ?? ''),
    email: typeof data.email === 'string' ? data.email : null,
    email_status: (typeof data.email_status === 'string' ? data.email_status : 'skipped_no_email') as ApplicationInviteDoc['email_status'],
    phone: typeof data.phone === 'string' ? data.phone : null,
    sms_status: (typeof data.sms_status === 'string' ? data.sms_status : 'skipped_no_phone') as SmsOutcome,
    message_id: typeof data.message_id === 'string' ? data.message_id : null,
    sent_by: String(data.sent_by ?? ''),
    sent_at: toDateOrEpoch(data.sent_at),
    resends: resends.map((r) => ({
      at: toDateOrEpoch(r.at),
      by: String(r.by ?? ''),
      token: String(r.token ?? ''),
      email_status: String(r.email_status ?? ''),
      sms_status: String(r.sms_status ?? ''),
    })),
  };
}

function inviteEmailBody(market: FarmersMarket, season: string, link: string, appUrl: string): string {
  const fees = marketFees(market);
  return [
    `Hello,`,
    ``,
    `Applications for the ${season} ${market.name} season are open. Every vendor applies again each season. Your returning-vendor application is already filled in with what we have on file; please review it and submit it here:`,
    link,
    ``,
    `A non-refundable application fee of $${fees.application_fee} is paid after you submit.`,
    `Market rules: ${appUrl.replace(/\/+$/, '')}/rules?market=${encodeURIComponent(market.id)}`,
    ``,
    `St. Joseph Center of Arkansas - SJCA Markets`,
  ].join('\n');
}

export type InviteResult =
  | { status: 'invited'; invite: ApplicationInviteDoc; url: string; resent: boolean }
  | { status: 'already'; invite: ApplicationInviteDoc };

/**
 * Invite one producer to apply for `season`. `force` re-sends an existing
 * invite (appending to `resends`, no dedupe key). The caller has already
 * checked that applications are open for `season`.
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
  const existing = await ref.get();
  if (existing.exists && !force) return { status: 'already', invite: inviteFromData(existing.data() as Record<string, unknown>) };

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

  const email = producerEmail(producer);
  const blocker = textBlocker(producer);
  const phone = typeof producer.phone === 'string' && E164_RE.test(producer.phone) ? producer.phone : null;

  let resent = existing.exists;
  if (!existing.exists) {
    const initial = {
      market_id: market.id,
      season,
      producer_id: producerId,
      token: tokenDoc.token,
      email,
      email_status: email ? ('sent' as const) : ('skipped_no_email' as const),
      phone,
      sms_status: blocker ?? ('sent' as const),
      message_id: null,
      sent_by: actor,
      sent_at: now,
      resends: [] as unknown[],
    };
    try {
      await ref.create(initial);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Another admin invited this producer between our read and this write.
      if (!force) {
        await db.collection('link_tokens').doc(tokenDoc.token).delete();
        const winner = await ref.get();
        return { status: 'already', invite: inviteFromData(winner.data() as Record<string, unknown>) };
      }
      resent = true;
    }
  }

  // Sends. A first invite is idempotent by dedupe key; a forced resend is deliberate and carries none.
  let emailStatus: EmailOutcome = 'skipped_no_email';
  if (email) {
    const subject = `Apply for the ${season} ${market.name} season`;
    emailStatus = await trySendEmail(env, email, subject, inviteEmailBody(market, season, url, env.APP_URL));
  }

  let smsStatus: SmsOutcome = blocker ?? 'sent';
  let messageId: string | null = null;
  if (!blocker && phone) {
    const first = firstNameOf(typeof producer.contact_name === 'string' ? producer.contact_name : '');
    const result = await trySendSms({
      env,
      db,
      to: phone,
      body: TEMPLATES_A1.application_invite({ season, market_name: market.name, first_name: first, link: url }),
      kind: 'application_invite',
      producer_id: producerId,
      sent_by: actor,
      extra: { token: tokenDoc.token, market_id: market.id, season },
      ...(resent ? {} : { dedupe_key: `application_invite:${market.id}:${season}:${producerId}` }),
    });
    smsStatus = smsOutcome(result);
    messageId = result.message_id;
  }

  const tokenUpdate: Record<string, unknown> = {};
  if (messageId) tokenUpdate.sent_message_id = messageId;
  if (emailStatus === 'sent' || emailStatus === 'simulated') tokenUpdate.email_sent_at = now;
  if (Object.keys(tokenUpdate).length > 0) await db.collection('link_tokens').doc(tokenDoc.token).update(tokenUpdate);

  if (resent) {
    const current = inviteFromData(((await ref.get()).data() ?? {}) as Record<string, unknown>);
    const resends = [
      ...current.resends,
      { at: now, by: actor, token: tokenDoc.token, email_status: emailStatus, sms_status: smsStatus },
    ];
    await ref.update({ resends, token: tokenDoc.token, email, phone, email_status: emailStatus, sms_status: smsStatus, message_id: messageId });
  } else {
    await ref.update({ email_status: emailStatus, sms_status: smsStatus, message_id: messageId });
  }

  const finalDoc = inviteFromData(((await ref.get()).data() ?? {}) as Record<string, unknown>);
  return { status: 'invited', invite: finalDoc, url, resent };
}

/* ── Bulk: invite every returning producer ── */

export interface InviteBatchResult {
  season: string;
  candidates: number;
  invited: number;
  skipped_already: number;
  skipped_applied: number;
  skipped_no_contact: number;
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

  const otherSeason = new Set<string>();
  const thisSeason = new Set<string>();
  for (const m of memberships) {
    if (m.season !== season) otherSeason.add(m.producer_id);
    else if (m.status !== 'inactive') thisSeason.add(m.producer_id);
  }

  // Producers that already have a live application for (market, season).
  const appSnap = await db.collection('applications').where('market_id', '==', market.id).get();
  const applied = new Set<string>();
  for (const d of appSnap.docs) {
    const a = d.data() as Record<string, unknown>;
    if (a.season !== season || a.status === 'declined' || a.status === 'withdrawn') continue;
    if (typeof a.producer_id === 'string') applied.add(a.producer_id);
    if (typeof a.prefill_producer_id === 'string') applied.add(a.prefill_producer_id);
  }

  const out: InviteBatchResult = { season, candidates: 0, invited: 0, skipped_already: 0, skipped_applied: 0, skipped_no_contact: 0, results: [] };

  const producerIds = [...otherSeason].sort();
  for (const producerId of producerIds) {
    const doc = await db.collection('producers').doc(producerId).get();
    if (!doc.exists) continue;
    const producer = doc.data() as Record<string, unknown>;
    if (producer.active === false) continue;
    out.candidates += 1;
    const businessName = String(producer.business_name ?? '');

    if (applied.has(producerId) || thisSeason.has(producerId)) {
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
      const already = !force && (await db.collection('application_invites').doc(inviteDocId(market.id, season, producerId)).get()).exists;
      if (already) {
        out.skipped_already += 1;
        continue;
      }
      out.invited += 1;
      out.results.push({
        producer_id: producerId,
        business_name: businessName,
        email_status: email ? 'would_send' : 'skipped_no_email',
        sms_status: blocker ?? 'would_send',
      });
      continue;
    }

    const result = await inviteProducer({ db, env, market, season, producerId, producer, actor, force, now });
    if (result.status === 'already') {
      out.skipped_already += 1;
      continue;
    }
    out.invited += 1;
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

function acceptanceEmailBody(p: {
  market: FarmersMarket;
  season: string;
  firstName: string;
  agreementUrl: string;
  totals: AcceptanceTotals;
  boothFeeUrl: string | null;
  insuranceHelpUrl: string | null;
  firstDate: string | null;
  appUrl: string;
}): string {
  const t = p.totals;
  const lines: string[] = [];
  lines.push(p.firstName ? `Hello ${p.firstName},` : 'Hello,');
  lines.push('');
  lines.push(`Your ${p.season} ${p.market.name} application has been approved.`);
  lines.push('');
  lines.push(
    `Booth: ${t.rate === 'seasonal' ? 'seasonal' : 'daily'} rate, ${t.spaces} ${t.spaces === 1 ? 'space' : 'spaces'}, electricity ${t.electric ? 'yes' : 'no'}${t.rate === 'seasonal' ? `, ${t.pay_in_full ? 'paying in full' : 'paying in installments'}` : ''}.`,
  );
  lines.push(
    t.basis === 'per_market'
      ? `Booth fee: $${t.total} per market.`
      : `Booth fee: $${t.total} for the season${t.installments > 1 ? `, in ${t.installments} installments` : ''}.`,
  );
  lines.push('');
  lines.push(`Step 1 - sign the Hold Harmless agreement: ${p.agreementUrl}`);
  if (p.boothFeeUrl) lines.push(`Step 2 - pay your booth fee: ${p.boothFeeUrl}`);
  lines.push('');
  lines.push(
    'Proof of $1,000,000 general liability insurance naming KBK-Breck, LLC c/o Kelley Commercial Partners, The WLRFM and ALFN/West Little Rock Farmers Market as additional insureds is required before your first market day.',
  );
  if (p.insuranceHelpUrl) lines.push(`Insurance information: ${p.insuranceHelpUrl}`);
  if (p.firstDate) {
    lines.push('');
    lines.push(`The first market day of the season is ${p.firstDate}.`);
  }
  lines.push('');
  lines.push(`Market rules: ${p.appUrl.replace(/\/+$/, '')}/rules?market=${encodeURIComponent(p.market.id)}`);
  lines.push('');
  lines.push('St. Joseph Center of Arkansas - SJCA Markets');
  return lines.join('\n');
}

export interface AcceptanceSends {
  sms: SmsOutcome;
  email: boolean;
}

/**
 * The text and the email that go out with an approval. Both are best-effort
 * (an approval never fails because a message did); the text is idempotent per
 * application (`acceptance:<application_id>`). The email is attempted when the
 * deployment has a sender address, or runs the console provider.
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
  firstDate: string | null;
  actor: string;
}): Promise<AcceptanceSends> {
  const { db, env, market, season } = args;
  const firstName = firstNameOf(args.contactName);

  let sms: SmsOutcome;
  const blocker = textBlocker(args.producer);
  if (blocker) {
    sms = blocker;
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
        total: args.totals.total,
        per_market: args.totals.basis === 'per_market',
        booth_fee_url: args.boothFeeUrl,
      }),
      kind: 'acceptance',
      producer_id: args.producerId,
      sent_by: args.actor,
      extra: { application_id: args.applicationId, membership_id: args.membershipId, token: args.agreementToken },
      dedupe_key: `acceptance:${args.applicationId}`,
    });
    sms = smsOutcome(result);
  }

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
        firstDate: args.firstDate,
        appUrl: env.APP_URL,
      }),
    );
    email = outcome !== 'failed';
  }
  return { sms, email };
}
