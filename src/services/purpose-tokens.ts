import type { Firestore } from 'firebase-admin/firestore';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { generateToken, TOKEN_RE } from './link-tokens.js';

/**
 * No-login links for the two Phase 4 purposes (contract §2.11): the
 * returning-vendor application prefill ('application', D30) and the Hold
 * Harmless e-sign ('agreement'). Same `link_tokens` collection and 43-char
 * token as the Phase 3 check-in links; `findOpenCheckin` ignores these rows
 * because it filters on `purpose === 'checkin'`, and `resolveCheckinToken`
 * answers 'unknown' for them. Never mints a JWT.
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte. Do not reformat or extend it here.
 */

export type PurposeTokenPurpose = 'application' | 'agreement';

/** A prefill link may be reopened and resubmitted; POST /api/applications counts a use. */
export const APPLICATION_TOKEN_MAX_USES = 25;
/** Signing is a single act; after it the link shows the signed confirmation, not the form. */
export const AGREEMENT_TOKEN_MAX_USES = 1;

export const APPLICATION_PATH = '/apply';
export const AGREEMENT_PATH = '/agreement';

/** `${APP_URL}/apply?t=<token>` or `${APP_URL}/agreement?t=<token>`. */
export function purposeTokenUrl(appUrl: string, purpose: PurposeTokenPurpose, token: string): string {
  const path = purpose === 'application' ? APPLICATION_PATH : AGREEMENT_PATH;
  return `${appUrl.replace(/\/+$/, '')}${path}?t=${encodeURIComponent(token)}`;
}

export interface PurposeTokenDoc {
  /** Equals the doc id. */
  token: string;
  purpose: PurposeTokenPurpose;
  producer_id: string;
  market_id: string;
  season: string;
  /** The membership the agreement belongs to; null for an application token. */
  membership_id: string | null;
  /** Set on an application token once a submission used it. */
  application_id: string | null;
  expires_at: Date;
  used_at: Date | null;
  uses: number;
  max_uses: number;
  created_at: Date;
  /** The staff user id that minted it, or 'approve' / 'invite' for the routes that mint on the producer's behalf. */
  created_by: string;
  /** The `messages` row id of the text that carried it (null when no text was sent). */
  sent_message_id: string | null;
  email_sent_at: Date | null;
}

export function purposeTokenFromData(id: string, data: Record<string, unknown>): PurposeTokenDoc {
  return {
    token: id,
    purpose: data.purpose === 'agreement' ? 'agreement' : 'application',
    producer_id: String(data.producer_id ?? ''),
    market_id: String(data.market_id ?? ''),
    season: String(data.season ?? ''),
    membership_id: typeof data.membership_id === 'string' ? data.membership_id : null,
    application_id: typeof data.application_id === 'string' ? data.application_id : null,
    expires_at: toDateOrEpoch(data.expires_at),
    used_at: toDate(data.used_at),
    uses: typeof data.uses === 'number' ? data.uses : 0,
    max_uses: typeof data.max_uses === 'number' ? data.max_uses : 1,
    created_at: toDateOrEpoch(data.created_at),
    created_by: String(data.created_by ?? ''),
    sent_message_id: typeof data.sent_message_id === 'string' ? data.sent_message_id : null,
    email_sent_at: toDate(data.email_sent_at),
  };
}

export interface MintPurposeTokenArgs {
  purpose: PurposeTokenPurpose;
  producer_id: string;
  market_id: string;
  season: string;
  membership_id?: string | null;
  application_id?: string | null;
  expires_at: Date;
  now: Date;
  created_by: string;
}

/** Mints and writes a fresh token. Never invalidates an older one — an earlier email or text keeps working until it expires. */
export async function mintPurposeToken(db: Firestore, args: MintPurposeTokenArgs): Promise<PurposeTokenDoc> {
  const token = generateToken();
  const doc: PurposeTokenDoc = {
    token,
    purpose: args.purpose,
    producer_id: args.producer_id,
    market_id: args.market_id,
    season: args.season,
    membership_id: args.membership_id ?? null,
    application_id: args.application_id ?? null,
    expires_at: args.expires_at,
    used_at: null,
    uses: 0,
    max_uses: args.purpose === 'agreement' ? AGREEMENT_TOKEN_MAX_USES : APPLICATION_TOKEN_MAX_USES,
    created_at: args.now,
    created_by: args.created_by,
    sent_message_id: null,
    email_sent_at: null,
  };
  await db.collection('link_tokens').doc(token).set(doc as unknown as Record<string, unknown>);
  return doc;
}

export type ResolvedPurposeToken =
  | { status: 'unknown' }
  | { status: 'expired'; reason: 'expired' | 'wrong_purpose'; token: PurposeTokenDoc }
  /** `uses >= max_uses`: the act was completed (an agreement was signed); callers show the completed state, not an error. */
  | { status: 'used'; token: PurposeTokenDoc }
  | { status: 'ok'; token: PurposeTokenDoc };

/** Look a token up for one purpose. Regex failure, a missing doc or a checkin token → 'unknown'. */
export async function resolvePurposeToken(db: Firestore, token: string, purpose: PurposeTokenPurpose, now: Date): Promise<ResolvedPurposeToken> {
  if (!TOKEN_RE.test(token)) return { status: 'unknown' };
  const doc = await db.collection('link_tokens').doc(token).get();
  if (!doc.exists) return { status: 'unknown' };
  const data = doc.data() as Record<string, unknown>;
  if (data.purpose !== 'application' && data.purpose !== 'agreement') return { status: 'unknown' };
  const t = purposeTokenFromData(doc.id, data);
  if (t.purpose !== purpose) return { status: 'expired', reason: 'wrong_purpose', token: t };
  if (t.expires_at.getTime() <= now.getTime()) return { status: 'expired', reason: 'expired', token: t };
  if (t.uses >= t.max_uses) return { status: 'used', token: t };
  return { status: 'ok', token: t };
}

/**
 * Records a completed act: `uses + 1`, `used_at: now`, and the application
 * id when given. Read-modify-write on purpose (same reasoning as Phase 3's
 * `markTokenUsed`): the counter is advisory; the act it records is made
 * at-most-once by its own write (an application `create()`, a `hold_harmless`
 * field written only when null), never by this counter.
 */
export async function markPurposeTokenUsed(db: Firestore, token: string, now: Date, opts: { application_id?: string } = {}): Promise<void> {
  const ref = db.collection('link_tokens').doc(token);
  const doc = await ref.get();
  if (!doc.exists) return;
  const t = purposeTokenFromData(doc.id, doc.data() as Record<string, unknown>);
  const update: Record<string, unknown> = { uses: t.uses + 1, used_at: now };
  if (opts.application_id) update.application_id = opts.application_id;
  await ref.update(update);
}

/** A producer's tokens of one purpose, newest first; optionally one market / season. One equality filter (`producer_id`). */
export async function purposeTokensFor(
  db: Firestore,
  producerId: string,
  purpose: PurposeTokenPurpose,
  filter: { market_id?: string; season?: string } = {},
): Promise<PurposeTokenDoc[]> {
  const snap = await db.collection('link_tokens').where('producer_id', '==', producerId).get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .filter(({ data }) => data.purpose === purpose)
    .map(({ id, data }) => purposeTokenFromData(id, data))
    .filter((t) => (filter.market_id ? t.market_id === filter.market_id : true))
    .filter((t) => (filter.season ? t.season === filter.season : true))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
