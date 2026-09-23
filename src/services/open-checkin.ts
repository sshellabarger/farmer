import type { Firestore } from 'firebase-admin/firestore';
import { isAlreadyExists } from '../db/firestore.js';

/**
 * Producer-side check-in lookups shared by the workflow engine, the staff
 * routes and the inbound text handler. (Built as a "copy verbatim" module by
 * two Phase 3 executors; since the merge this is the single copy.)
 *
 * Firestore access stays inside the fake-db envelope (Phase 2 contract
 * §1.1.4): one equality filter per query, everything else in memory.
 */

export const CHECKIN_PATH = '/checkin';

/** The no-login link a producer receives: `${APP_URL}/checkin?t=<token>`. */
export function checkinUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}${CHECKIN_PATH}?t=${encodeURIComponent(token)}`;
}

/** Date | Firestore Timestamp | ISO string → Date (null when absent or invalid). */
export function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value as { toDate?: () => Date };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface OpenCheckin {
  /** The link token (= the `link_tokens` doc id). */
  token: string;
  producer_id: string;
  market_id: string;
  market_date_id: string;
  expires_at: Date;
  created_at: Date | null;
}

/**
 * The producer's most recently minted, still-valid `checkin` link token whose
 * market date is still `collecting`, or null. Valid = purpose 'checkin',
 * `expires_at > now`, `uses < max_uses`. One query on `producer_id`, then at
 * most one `market_dates` read per distinct candidate date.
 */
export async function findOpenCheckin(db: Firestore, producerId: string, now: Date): Promise<OpenCheckin | null> {
  const snap = await db.collection('link_tokens').where('producer_id', '==', producerId).get();
  const candidates: OpenCheckin[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (d.purpose !== 'checkin') continue;
    const expires = toDate(d.expires_at);
    if (!expires || expires.getTime() <= now.getTime()) continue;
    const uses = typeof d.uses === 'number' ? d.uses : 0;
    const maxUses = typeof d.max_uses === 'number' ? d.max_uses : Number.POSITIVE_INFINITY;
    if (uses >= maxUses) continue;
    candidates.push({
      token: doc.id,
      producer_id: String(d.producer_id ?? ''),
      market_id: String(d.market_id ?? ''),
      market_date_id: String(d.market_date_id ?? ''),
      expires_at: expires,
      created_at: toDate(d.created_at),
    });
  }
  candidates.sort((a, b) => (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0));

  const collecting = new Map<string, boolean>();
  for (const c of candidates) {
    let ok = collecting.get(c.market_date_id);
    if (ok === undefined) {
      const dateDoc = await db.collection('market_dates').doc(c.market_date_id).get();
      ok = dateDoc.exists && (dateDoc.data() as Record<string, unknown> | undefined)?.status === 'collecting';
      collecting.set(c.market_date_id, ok);
    }
    if (ok) return c;
  }
  return null;
}

export interface StaffContact {
  user_id: string;
  name: string;
  phone: string;
  role: string;
}

/**
 * Staff who receive texts about a market: `users` with role 'admin', or
 * 'market_manager' with the market in `assigned_market_ids`; active (absent
 * = true); with a phone; not opted out. Sorted by user id for stable order.
 */
export async function staffForMarket(db: Firestore, marketId: string): Promise<StaffContact[]> {
  const snap = await db.collection('users').get();
  const out: StaffContact[] = [];
  for (const doc of snap.docs) {
    const u = doc.data() as Record<string, unknown>;
    if (u.active === false) continue;
    if (u.sms_opt_out_at) continue;
    const phone = typeof u.phone === 'string' ? u.phone.trim() : '';
    if (!phone) continue;
    const role = String(u.role ?? '');
    const assigned = Array.isArray(u.assigned_market_ids) ? (u.assigned_market_ids as unknown[]) : [];
    const eligible = role === 'admin' || (role === 'market_manager' && assigned.includes(marketId));
    if (!eligible) continue;
    out.push({ user_id: doc.id, name: String(u.name ?? ''), phone, role });
  }
  return out.sort((a, b) => a.user_id.localeCompare(b.user_id));
}

export interface AttendingNextResult {
  checkin_id: string;
  created: boolean;
}

/**
 * Record a YES/NO answer texted by a producer. Creates a minimal
 * `source: 'sms'` check-in (every §2.6 field present, empty) when none exists
 * for the date, otherwise only updates `attending_next` on the existing one.
 * The create is atomic: a form submission landing in the same instant keeps
 * every one of its answers and gains only the texted one (a read-then-set here
 * could replace a full check-in with this stub).
 */
export async function recordAttendingNext(
  db: Firestore,
  open: OpenCheckin,
  attending: boolean,
  raw: string,
  now: Date,
): Promise<AttendingNextResult> {
  const id = `${open.market_date_id}_${open.producer_id}`;
  const ref = db.collection('checkins').doc(id);
  try {
    await ref.create(stubCheckin(open, attending, raw, now));
    return { checkin_id: id, created: true };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  await ref.update({ attending_next: attending, attending_next_raw: raw, updated_at: now });
  return { checkin_id: id, created: false };
}

function stubCheckin(open: OpenCheckin, attending: boolean, raw: string, now: Date): Record<string, unknown> {
  return {
    producer_id: open.producer_id,
    market_id: open.market_id,
    market_date_id: open.market_date_id,
    submitted_at: now,
    source: 'sms',
    token_id: open.token,
    estimated_sales: { value: null, raw: '', kind: 'none' },
    transactions_estimate: { value: null, raw: '' },
    sold_out_items: [],
    sold_out_raw: '',
    unsold_items: [],
    unsold_raw: '',
    attending_next: attending,
    attending_next_raw: raw,
    bringing_next: [],
    bringing_next_raw: '',
    feedback: '',
    extra_answers: {},
    flags: [],
    raw_import: null,
    submissions: 1,
    partial: true,
    created_at: now,
    updated_at: now,
  };
}
