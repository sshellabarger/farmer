import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { marketDateFromData, type MarketDateDoc } from './market-dates.js';
import type { LinkTokenPurpose } from '../types/schema.js';

/**
 * No-login check-in link tokens (Phase 3 contract §2.1). Never mints a JWT
 * session — `link-tokens.ts`, `checkin-public.ts` and `checkins-submit.ts`
 * must not import `src/utils/jwt.ts` (test-enforced, contract §7.1).
 */

/** 3 days of late submissions past a date's deadline (§2.1). */
export const LINK_TOKEN_GRACE_MIN = 4320;
/** Re-openable until expiry; the latest submission wins. */
export const LINK_TOKEN_MAX_USES = 25;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface LinkTokenDoc {
  /** Equals the doc id. */
  token: string;
  purpose: LinkTokenPurpose;
  producer_id: string;
  market_id: string;
  market_date_id: string;
  expires_at: Date;
  used_at: Date | null;
  /** Successful POSTs only; a GET never counts. */
  uses: number;
  max_uses: number;
  created_at: Date;
  /** 'engine', or the staff user id for a resend. */
  created_by: string;
  /** The `messages` row id of the text that carried this token (null until sent / on a failed send). */
  sent_message_id: string | null;
}

/** `crypto.randomBytes(32).toString('base64url')` — 43 chars, matches TOKEN_RE. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function linkTokenFromData(id: string, data: Record<string, unknown>): LinkTokenDoc {
  return {
    token: id,
    purpose: 'checkin',
    producer_id: String(data.producer_id ?? ''),
    market_id: String(data.market_id ?? ''),
    market_date_id: String(data.market_date_id ?? ''),
    expires_at: toDateOrEpoch(data.expires_at),
    used_at: toDate(data.used_at),
    uses: typeof data.uses === 'number' ? data.uses : 0,
    max_uses: typeof data.max_uses === 'number' ? data.max_uses : LINK_TOKEN_MAX_USES,
    created_at: toDateOrEpoch(data.created_at),
    created_by: String(data.created_by ?? ''),
    sent_message_id: (data.sent_message_id as string | null | undefined) ?? null,
  };
}

export interface MintCheckinTokenArgs {
  producer_id: string;
  market_id: string;
  market_date_id: string;
  /** The date's deadline instant; `expires_at = deadline_at + LINK_TOKEN_GRACE_MIN`. */
  deadline_at: Date;
  now: Date;
  /** 'engine', or the staff user id for a resend. */
  created_by: string;
}

/** Mints and writes a fresh `checkin` token. Never invalidates an older one — an old text still works. */
export async function mintCheckinToken(db: Firestore, args: MintCheckinTokenArgs): Promise<LinkTokenDoc> {
  const token = generateToken();
  const doc: LinkTokenDoc = {
    token,
    purpose: 'checkin',
    producer_id: args.producer_id,
    market_id: args.market_id,
    market_date_id: args.market_date_id,
    expires_at: new Date(args.deadline_at.getTime() + LINK_TOKEN_GRACE_MIN * 60_000),
    used_at: null,
    uses: 0,
    max_uses: LINK_TOKEN_MAX_USES,
    created_at: args.now,
    created_by: args.created_by,
    sent_message_id: null,
  };
  await db.collection('link_tokens').doc(token).set(doc as unknown as Record<string, unknown>);
  return doc;
}

export type ResolvedToken =
  | { status: 'unknown' }
  | { status: 'expired'; reason: 'expired' | 'exhausted' | 'date_cancelled' | 'date_missing'; token: LinkTokenDoc }
  | { status: 'ok'; token: LinkTokenDoc; date: MarketDateDoc };

/**
 * Look up a token and its market date, deciding validity (contract §4.1):
 * unknown doc/regex failure → 'unknown'; expired, exhausted, a cancelled
 * date or a missing date doc → 'expired' with the specific reason; otherwise
 * 'ok' with both the token and its normalised market date.
 */
export async function resolveCheckinToken(db: Firestore, token: string, now: Date): Promise<ResolvedToken> {
  if (!TOKEN_RE.test(token)) return { status: 'unknown' };
  const doc = await db.collection('link_tokens').doc(token).get();
  if (!doc.exists) return { status: 'unknown' };
  const t = linkTokenFromData(doc.id, doc.data() as Record<string, unknown>);
  if (t.expires_at.getTime() <= now.getTime()) return { status: 'expired', reason: 'expired', token: t };
  if (t.uses >= t.max_uses) return { status: 'expired', reason: 'exhausted', token: t };
  const dateDoc = await db.collection('market_dates').doc(t.market_date_id).get();
  if (!dateDoc.exists) return { status: 'expired', reason: 'date_missing', token: t };
  const date = marketDateFromData(dateDoc.id, dateDoc.data() as Record<string, unknown>);
  if (date.status === 'cancelled') return { status: 'expired', reason: 'date_cancelled', token: t };
  return { status: 'ok', token: t, date };
}

/**
 * Marks a successful POST: `uses + 1`, `used_at: now`. No-op on an unknown
 * token.
 *
 * Read-modify-write on purpose (Phase 3 fix, round 2 — no FieldValue
 * sentinels): `uses` is an informational counter behind an advisory cap
 * (LINK_TOKEN_MAX_USES), so two concurrent submissions that both read the
 * same value and both write `+1` under-count by one and nothing more. The
 * update names only `uses` and `used_at`, so no other field of the token
 * (sent_message_id, expires_at, …) — and never the doc itself — can be lost
 * to the interleave; a re-opened form counts on top on the next submission.
 */
export async function markTokenUsed(db: Firestore, token: string, now: Date): Promise<void> {
  const ref = db.collection('link_tokens').doc(token);
  const doc = await ref.get();
  if (!doc.exists) return;
  const t = linkTokenFromData(doc.id, doc.data() as Record<string, unknown>);
  await ref.update({ uses: t.uses + 1, used_at: now });
}

/**
 * Every `checkin` token minted for a producer's given market date, newest
 * first (by `created_at`). One equality filter (`producer_id`) at the DB,
 * the `market_date_id` filter in memory — callers pick the newest unexpired
 * entry themselves (the engine reuses it; an expired-only result means mint
 * a fresh one).
 */
export async function tokensForDate(db: Firestore, producerId: string, marketDateId: string): Promise<LinkTokenDoc[]> {
  const snap = await db.collection('link_tokens').where('producer_id', '==', producerId).get();
  return snap.docs
    .map((d) => linkTokenFromData(d.id, d.data() as Record<string, unknown>))
    .filter((t) => t.market_date_id === marketDateId)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
