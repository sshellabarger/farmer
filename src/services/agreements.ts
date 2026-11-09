import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { isAlreadyExists } from '../db/firestore.js';
import { toDate } from '../utils/dates.js';
import { trySendSms } from './sms.js';
import { mintPurposeToken, purposeTokenUrl } from './purpose-tokens.js';
import type { PurposeTokenDoc } from './purpose-tokens.js';
import { membershipFromData } from './seasons.js';
import type { MembershipView } from './seasons.js';
import type { FarmersMarket } from './markets.js';
import { CLAIM_TTL_MS } from './checkin-workflow.js';

/**
 * The Hold Harmless agreement (Phase 4 contract §3.1, §3.4): a no-login e-sign
 * link per membership. Signing writes `hold_harmless` on the membership, moves an
 * `approved` membership to `active` (history entry by 'producer') and sends
 * nothing — no text, no email. Staff can mint a fresh link and text it.
 */

/** Agreement tokens live 60 days (contract §2.11). */
export const AGREEMENT_TOKEN_TTL_DAYS = 60;
const E164_RE = /^\+[1-9]\d{6,14}$/;

export const AGREEMENT_TEMPLATES = {
  agreement_link(args: { season: string; market_name: string; first_name: string; link: string }): string {
    const lead = args.first_name ? `${args.first_name}, please` : 'Please';
    return `SJCA Markets: ${lead} sign the ${args.season} ${args.market_name} Hold Harmless agreement here: ${args.link}\nReply STOP to opt out.`;
  },
};

function firstNameOf(contactName: unknown): string {
  const first = String(contactName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.slice(0, 20);
}

export interface AgreementContext {
  membership: MembershipView;
  /** The stored document, for fields the normalised view does not carry (the raw history array). */
  membership_raw: Record<string, unknown>;
  market: FarmersMarket;
  producer: Record<string, unknown>;
}

/** The membership, market and producer a token points at, or null when any is missing. */
export async function loadAgreementContext(db: Firestore, membershipId: string | null): Promise<AgreementContext | null> {
  if (!membershipId) return null;
  const mDoc = await db.collection('producer_memberships').doc(membershipId).get();
  if (!mDoc.exists) return null;
  const raw = mDoc.data() as Record<string, unknown>;
  const membership = membershipFromData(mDoc.id, raw);
  const [marketDoc, producerDoc] = await Promise.all([
    db.collection('farmers_markets').doc(membership.market_id).get(),
    db.collection('producers').doc(membership.producer_id).get(),
  ]);
  if (!marketDoc.exists || !producerDoc.exists) return null;
  return {
    membership,
    membership_raw: raw,
    market: { id: marketDoc.id, ...(marketDoc.data() as Record<string, unknown>) } as FarmersMarket,
    producer: producerDoc.data() as Record<string, unknown>,
  };
}

interface LegalText {
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  insurance_help_url: string | null;
}

/** The market's Hold Harmless text and version (`legal.*`, empty when the admin has not set them). */
export function legalOf(market: FarmersMarket): LegalText {
  const legal = ((market as unknown as Record<string, unknown>).legal ?? {}) as Record<string, unknown>;
  return {
    hold_harmless_markdown: typeof legal.hold_harmless_markdown === 'string' ? legal.hold_harmless_markdown : '',
    hold_harmless_version: typeof legal.hold_harmless_version === 'string' ? legal.hold_harmless_version : '',
    insurance_help_url: typeof legal.insurance_help_url === 'string' && legal.insurance_help_url ? legal.insurance_help_url : null,
  };
}

export interface AgreementViewBody {
  status: 'open' | 'signed';
  market_name: string;
  season: string;
  business_name: string;
  contact_name: string;
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  /**
   * False while the market has not published its Hold Harmless text: nobody
   * can be asked to sign an empty agreement. The page shows a notice instead
   * of the form and POST answers 409.
   */
  can_sign: boolean;
  insurance_help_url: string | null;
  signed: { name: string; signed_at: Date } | null;
  expires_at: Date;
}

/** sha256 of the exact agreement text a producer was shown — stored with the signature. */
export function agreementTextHash(markdown: string): string {
  return crypto.createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export function buildAgreementView(ctx: AgreementContext, token: PurposeTokenDoc): AgreementViewBody {
  const legal = legalOf(ctx.market);
  const hh = ctx.membership.hold_harmless;
  return {
    status: hh ? 'signed' : 'open',
    market_name: ctx.market.name,
    season: ctx.membership.season,
    business_name: String(ctx.producer.business_name ?? ''),
    contact_name: String(ctx.producer.contact_name ?? ''),
    hold_harmless_markdown: legal.hold_harmless_markdown,
    // The version the producer signed, if any; otherwise the one they are being asked to sign.
    hold_harmless_version: hh?.version || legal.hold_harmless_version,
    can_sign: !hh && legal.hold_harmless_markdown.trim().length > 0,
    insurance_help_url: legal.insurance_help_url,
    signed: hh ? { name: hh.name, signed_at: hh.signed_at } : null,
    expires_at: token.expires_at,
  };
}

export type SignResult =
  | { ok: true; signed: { name: string; signed_at: Date }; membership_status: string }
  | { ok: false; status: 409; error: string };

/**
 * Records the signature. At-most-once without a transaction: a `workflow_locks`
 * doc (`agreement__<membership_id>`) is `create()`d first; the loser of a race gets
 * 409, and a lock left by a run that died before writing is taken over after
 * CLAIM_TTL_MS. The signature field is only ever written while null.
 */
export async function signAgreement(
  db: Firestore,
  ctx: AgreementContext,
  token: PurposeTokenDoc,
  input: { name: string; ip: string; now: Date },
): Promise<SignResult> {
  const { now } = input;
  const { membership } = ctx;
  if (membership.hold_harmless) return { ok: false, status: 409, error: 'Already signed' };
  if (membership.status === 'inactive') return { ok: false, status: 409, error: 'This membership is inactive' };
  // An empty agreement cannot be signed: the signature would attest to nothing
  // and would still activate the membership.
  if (legalOf(ctx.market).hold_harmless_markdown.trim().length === 0) {
    return { ok: false, status: 409, error: 'The agreement is not available yet. Please contact the market manager.' };
  }

  const lockRef = db.collection('workflow_locks').doc(`agreement__${membership.id}`);
  try {
    await lockRef.create({ key: 'agreement', membership_id: membership.id, claimed_at: now, created_at: now });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const lock = ((await lockRef.get()).data() ?? {}) as Record<string, unknown>;
    const claimedAt = toDate(lock.claimed_at);
    const stillSigned = (await db.collection('producer_memberships').doc(membership.id).get()).data()?.hold_harmless;
    if (stillSigned) return { ok: false, status: 409, error: 'Already signed' };
    if (claimedAt && now.getTime() - claimedAt.getTime() < CLAIM_TTL_MS) {
      return { ok: false, status: 409, error: 'Signing is already in progress' };
    }
    await lockRef.set({ key: 'agreement', membership_id: membership.id, claimed_at: now, created_at: toDate(lock.created_at) ?? now });
  }

  // Re-read under the lock: this is the value the write is decided on.
  const ref = db.collection('producer_memberships').doc(membership.id);
  const fresh = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  if (fresh.hold_harmless) return { ok: false, status: 409, error: 'Already signed' };

  const legal = legalOf(ctx.market);
  const update: Record<string, unknown> = {
    hold_harmless: {
      signed_at: now,
      name: input.name,
      ip: input.ip,
      version: legal.hold_harmless_version,
      // The version label is the market's to edit; the hash pins the exact text that was signed.
      text_sha256: agreementTextHash(legal.hold_harmless_markdown),
      token: token.token,
    },
    updated_at: now,
  };
  let nextStatus = String(fresh.status ?? membership.status);
  if (fresh.status === 'approved') {
    nextStatus = 'active';
    update.status = 'active';
    const history = Array.isArray(fresh.history) ? [...fresh.history] : [];
    history.push({ from: 'approved', to: 'active', at: now, by: 'producer', note: 'Hold Harmless signed' });
    update.history = history;
  }
  await ref.update(update);
  return { ok: true, signed: { name: input.name, signed_at: now }, membership_status: nextStatus };
}

export type AgreementSmsOutcome =
  | 'sent'
  | 'simulated'
  | 'failed'
  | 'skipped_not_requested'
  | 'skipped_no_phone'
  | 'skipped_invalid_phone'
  | 'skipped_opted_out'
  | 'skipped_inactive_producer';

/**
 * Mints a fresh agreement token (earlier links keep working until they expire)
 * and, when `send`, texts it. Deliberately carries NO dedupe key: this is a staff
 * resend, an intentional extra text.
 */
export async function issueAgreementLink(
  db: Firestore,
  env: Env,
  ctx: AgreementContext,
  opts: { user_id: string; now: Date; send: boolean },
): Promise<{ url: string; expires_at: Date; token: string; sms: AgreementSmsOutcome }> {
  const { membership, market, producer } = ctx;
  const expires_at = new Date(opts.now.getTime() + AGREEMENT_TOKEN_TTL_DAYS * 24 * 60 * 60_000);
  const doc = await mintPurposeToken(db, {
    purpose: 'agreement',
    producer_id: membership.producer_id,
    market_id: membership.market_id,
    season: membership.season,
    membership_id: membership.id,
    expires_at,
    now: opts.now,
    created_by: opts.user_id,
  });
  const url = purposeTokenUrl(env.APP_URL, 'agreement', doc.token);

  let sms: AgreementSmsOutcome = 'skipped_not_requested';
  if (opts.send) {
    const phone = typeof producer.phone === 'string' ? producer.phone.trim() : '';
    if (producer.active === false) sms = 'skipped_inactive_producer';
    else if (!phone) sms = 'skipped_no_phone';
    else if (!E164_RE.test(phone)) sms = 'skipped_invalid_phone';
    else if (producer.sms_opt_out_at) sms = 'skipped_opted_out';
    else {
      const result = await trySendSms({
        env,
        db,
        to: phone,
        body: AGREEMENT_TEMPLATES.agreement_link({
          season: membership.season,
          market_name: market.name,
          first_name: firstNameOf(producer.contact_name),
          link: url,
        }),
        kind: 'acceptance',
        producer_id: membership.producer_id,
        sent_by: opts.user_id,
        extra: { membership_id: membership.id, token: doc.token, market_id: membership.market_id, season: membership.season },
      });
      if (result.ok) {
        sms = result.status;
        await db.collection('link_tokens').doc(doc.token).update({ sent_message_id: result.message_id });
      } else {
        sms = 'failed';
      }
    }
  }
  return { url, expires_at, token: doc.token, sms };
}
