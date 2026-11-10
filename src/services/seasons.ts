import type { Firestore } from 'firebase-admin/firestore';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { addDays, localToUtc, parseDate, utcToLocalDate } from '../utils/tz.js';
import type { MembershipStatus } from './producers.js';

/**
 * Per-season memberships (Phase 4 contract §2.6, decision D33: every producer
 * re-applies each season, so a membership belongs to exactly one season) and
 * the one place that answers "which season is this market in right now?".
 *
 * Written as one byte-identical module for the two Phase 4 backend
 * executors; since the merge there is a single copy. The fix round added, at
 * the end of the file, the insurance calendar date (`expires_on`, X11) and
 * the staff views (`membershipViewFor`, X8).
 *
 * Firestore access stays inside the fake-db envelope (one equality filter per
 * query, everything else in memory) and every date field is read through
 * `toDate` — Firestore hands back Timestamps, never Dates.
 */

/**
 * The season every membership written before Phase 4 belongs to. The 39
 * production docs (the 2026 WLRFM survey import and its Phase 2 approvals)
 * carry no `season` field; `scripts/backfill-membership-seasons.mjs` adds it
 * once, and until then — or for any doc the backfill missed — a missing field
 * reads as this. A fact about the deployed data, not a schedule rule.
 */
export const LEGACY_MEMBERSHIP_SEASON = '2026';

/** '2027', or a qualified label such as '2027-winter'. */
export const SEASON_LABEL_RE = /^\d{4}(-[a-z0-9]{1,16})?$/;

/** Phase 4 fee vocabulary (D31). Phase 2 values map on read: weekly → daily, season → seasonal, both → seasonal. */
export type FeePlan = 'seasonal' | 'daily';
export type BoothKind = 'stall' | 'food_truck';
export type InsuranceStatus = 'missing' | 'on_file' | 'expired' | 'waived';
export type ItemRequestStatus = 'pending' | 'approved' | 'declined';

export interface MembershipInsurance {
  status: InsuranceStatus;
  /**
   * The last day the certificate is valid, 'YYYY-MM-DD' in the market's own
   * calendar: the stored truth (fix X11). null on a document written before
   * the field existed — `insuranceExpiresOn` derives it from `expires_at`
   * with the market's timezone, and `membershipViewFor` fills it in.
   */
  expires_on: string | null;
  /** Derived from `expires_on`: the instant the certificate stops being valid (market-local midnight at the start of the next day). */
  expires_at: Date | null;
  upload_id: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  note: string;
}

export interface HoldHarmless {
  signed_at: Date;
  name: string;
  ip: string;
  version: string;
  /** sha256 of the exact agreement text that was signed ('' on signatures recorded before this field existed). */
  text_sha256: string;
  token: string;
}

export interface ItemRequest {
  id: string;
  items: string[];
  note: string;
  requested_at: Date;
  source: 'application' | 'admin' | 'producer';
  status: ItemRequestStatus;
  decided_by: string | null;
  decided_at: Date | null;
}

/** A `producer_memberships` document as every Phase 4 reader sees it (Phase 2 docs normalised). */
export interface MembershipView {
  id: string;
  producer_id: string;
  market_id: string;
  season: string;
  status: MembershipStatus;
  fee_plan: FeePlan;
  /** The stored value before `normalizeFeePlan` ('weekly' | 'season' | 'both' on Phase 2 docs). */
  fee_plan_raw: string;
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  booth_kind: BoothKind;
  usual_booth_id: string | null;
  trial_period: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  insurance: MembershipInsurance;
  hold_harmless: HoldHarmless | null;
  approved_items: string[];
  item_requests: ItemRequest[];
  application_id: string | null;
  history: unknown[];
  source: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * What `currentSeason` needs from a market document. Structural on purpose: a
 * `FarmersMarket` passes with or without the Phase 4 `season` field, so the
 * helper compiles on every branch.
 */
export interface SeasonSource {
  timezone: string;
  schedule?: { versions?: { effective_from: string; season_start: string }[] | null } | null;
  season?: { label?: string | null } | null;
}

/**
 * The season a market would be in with no explicit label: the year of
 * `season_start` of the latest schedule version whose `effective_from` is on
 * or before today (market-local), else of the earliest version;
 * LEGACY_MEMBERSHIP_SEASON for a market with no versions at all (test
 * fixtures). For production WLRFM today that is '2026' and stays '2026' after
 * the 2027 version is added with a 2027 `effective_from`.
 */
export function inferSeasonLabel(market: SeasonSource, now: Date): string {
  const versions = market.schedule?.versions ?? [];
  if (versions.length === 0) return LEGACY_MEMBERSHIP_SEASON;
  const today = utcToLocalDate(now, market.timezone || 'UTC');
  const sorted = [...versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let applicable = sorted[0]!;
  for (const v of sorted) if (v.effective_from <= today) applicable = v;
  return applicable.season_start.slice(0, 4);
}

/** The market's current season: `season.label` when it is set and well-formed, else `inferSeasonLabel`. */
export function currentSeason(market: SeasonSource, now: Date): string {
  const label = market.season?.label;
  if (typeof label === 'string' && SEASON_LABEL_RE.test(label)) return label;
  return inferSeasonLabel(market, now);
}

/** The season a stored membership belongs to; a missing or malformed field reads as the legacy season. */
export function membershipSeason(data: Record<string, unknown>): string {
  const s = data.season;
  return typeof s === 'string' && SEASON_LABEL_RE.test(s) ? s : LEGACY_MEMBERSHIP_SEASON;
}

/** Doc id of a Phase 4 membership. Phase 2 docs keep their `${producer_id}_${market_id}` ids; never derive an id to read by — query and filter. */
export function membershipDocId(producerId: string, marketId: string, season: string): string {
  return `${producerId}_${marketId}_${season}`;
}

export function normalizeFeePlan(raw: unknown): FeePlan {
  switch (raw) {
    case 'seasonal':
    case 'season':
    case 'both':
      return 'seasonal';
    default:
      return 'daily';
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

function insuranceFromData(raw: unknown): MembershipInsurance {
  const i = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = i.status;
  return {
    status: status === 'on_file' || status === 'expired' || status === 'waived' ? status : 'missing',
    expires_on: isCalendarDate(i.expires_on) ? i.expires_on : null,
    expires_at: toDate(i.expires_at),
    upload_id: typeof i.upload_id === 'string' ? i.upload_id : null,
    verified_by: typeof i.verified_by === 'string' ? i.verified_by : null,
    verified_at: toDate(i.verified_at),
    note: typeof i.note === 'string' ? i.note : '',
  };
}

function holdHarmlessFromData(raw: unknown): HoldHarmless | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  const signedAt = toDate(h.signed_at);
  if (!signedAt) return null;
  return {
    signed_at: signedAt,
    name: typeof h.name === 'string' ? h.name : '',
    ip: typeof h.ip === 'string' ? h.ip : '',
    version: typeof h.version === 'string' ? h.version : '',
    text_sha256: typeof h.text_sha256 === 'string' ? h.text_sha256 : '',
    token: typeof h.token === 'string' ? h.token : '',
  };
}

function itemRequestsFromData(raw: unknown): ItemRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const status = r.status;
    const source = r.source;
    return {
      id: typeof r.id === 'string' ? r.id : String(index),
      items: Array.isArray(r.items) ? r.items.map(String) : [],
      note: typeof r.note === 'string' ? r.note : '',
      requested_at: toDateOrEpoch(r.requested_at),
      source: source === 'admin' || source === 'producer' ? source : 'application',
      status: status === 'approved' || status === 'declined' ? status : 'pending',
      decided_by: typeof r.decided_by === 'string' ? r.decided_by : null,
      decided_at: toDate(r.decided_at),
    };
  });
}

/** Normalise a stored membership. Tolerates every Phase 2 doc (no season, old fee_plan, no Phase 4 fields). */
export function membershipFromData(id: string, data: Record<string, unknown>): MembershipView {
  const feePlanRaw = typeof data.fee_plan === 'string' ? data.fee_plan : 'weekly';
  return {
    id,
    producer_id: String(data.producer_id ?? ''),
    market_id: String(data.market_id ?? ''),
    season: membershipSeason(data),
    status: (typeof data.status === 'string' ? data.status : 'inactive') as MembershipStatus,
    fee_plan: normalizeFeePlan(feePlanRaw),
    fee_plan_raw: feePlanRaw,
    spaces: data.spaces === 2 ? 2 : 1,
    electric: data.electric === true,
    pay_in_full: data.pay_in_full === true,
    booth_kind: data.booth_kind === 'food_truck' ? 'food_truck' : 'stall',
    usual_booth_id: typeof data.usual_booth_id === 'string' && data.usual_booth_id ? data.usual_booth_id : null,
    trial_period: data.trial_period === true,
    approved_at: toDate(data.approved_at),
    approved_by: typeof data.approved_by === 'string' ? data.approved_by : null,
    insurance: insuranceFromData(data.insurance),
    hold_harmless: holdHarmlessFromData(data.hold_harmless),
    approved_items: Array.isArray(data.approved_items) ? data.approved_items.map(String) : [],
    item_requests: itemRequestsFromData(data.item_requests),
    application_id: typeof data.application_id === 'string' ? data.application_id : null,
    history: Array.isArray(data.history) ? data.history : [],
    source: typeof data.source === 'string' ? data.source : 'admin',
    created_at: toDateOrEpoch(data.created_at),
    updated_at: toDateOrEpoch(data.updated_at),
  };
}

/** Insurance as it stands at `now`: an `on_file` certificate past its expiry reads as `expired`. */
export function insuranceStatusAt(insurance: MembershipInsurance, now: Date): InsuranceStatus {
  if (insurance.status === 'on_file' && insurance.expires_at && insurance.expires_at.getTime() <= now.getTime()) return 'expired';
  return insurance.status;
}

/** Every membership at a market, any season. One equality filter. */
export async function listMembershipsForMarket(db: Firestore, marketId: string): Promise<MembershipView[]> {
  const snap = await db.collection('producer_memberships').where('market_id', '==', marketId).get();
  return snap.docs.map((d) => membershipFromData(d.id, d.data() as Record<string, unknown>));
}

/** Every membership of a producer, any market, any season. One equality filter. */
export async function listMembershipsForProducer(db: Firestore, producerId: string): Promise<MembershipView[]> {
  const snap = await db.collection('producer_memberships').where('producer_id', '==', producerId).get();
  return snap.docs.map((d) => membershipFromData(d.id, d.data() as Record<string, unknown>));
}

export function ofSeason<T extends { season: string }>(memberships: T[], season: string): T[] {
  return memberships.filter((m) => m.season === season);
}

/** "The vendors of this market": the memberships of the market's current season (any status), plus the season they belong to. */
export async function listCurrentMemberships(
  db: Firestore,
  market: SeasonSource & { id: string },
  now: Date,
): Promise<{ season: string; memberships: MembershipView[] }> {
  const season = currentSeason(market, now);
  const all = await listMembershipsForMarket(db, market.id);
  return { season, memberships: ofSeason(all, season) };
}

/** The one membership of a producer at a market for a season, or null. Query by producer, filter in memory. */
export async function findMembership(db: Firestore, producerId: string, marketId: string, season: string): Promise<MembershipView | null> {
  const all = await listMembershipsForProducer(db, producerId);
  const matches = all.filter((m) => m.market_id === marketId && m.season === season);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return matches[0]!;
}

/** A vendor in the rotation: receives check-in texts and is drafted into booths. */
export function isVendorOfRecord(m: Pick<MembershipView, 'status'>): boolean {
  return m.status === 'active';
}

/* ── Insurance expiry as a calendar date (Phase 4 fix X11) ── */

/**
 * "Valid through D" as an instant: market-local midnight at the start of the
 * day after D. `insuranceStatusAt` compares against it, so a certificate is
 * still good for the whole of D and expired from the first moment of D + 1,
 * in the market's own timezone (DST included: the instant is resolved by
 * `localToUtc`, never by adding 24 hours).
 */
export function insuranceExpiryInstant(expiresOn: string, timeZone: string): Date {
  return localToUtc(addDays(expiresOn, 1), '00:00', timeZone || 'UTC');
}

/**
 * The last valid day of a certificate. The stored `expires_on` when there is
 * one; for a document that only has the instant, the market-local date of
 * the moment just before it (so both "start of D + 1" and the older "23:59
 * on D" read as D). Showing `expires_at.slice(0, 10)` instead is the UTC date
 * of the NEXT day, and saving that back moved the date forward by a day on
 * every unchanged save.
 */
export function insuranceExpiresOn(insurance: Pick<MembershipInsurance, 'expires_on' | 'expires_at'>, timeZone: string): string | null {
  if (insurance.expires_on) return insurance.expires_on;
  if (!insurance.expires_at) return null;
  return utcToLocalDate(new Date(insurance.expires_at.getTime() - 1), timeZone || 'UTC');
}

/* ── What staff see of a membership (Phase 4 fix X8) ── */

/** The signature as a market manager sees it: who signed, when, which version. The IP address and the token are evidence for admins only. */
export type HoldHarmlessSummary = Pick<HoldHarmless, 'signed_at' | 'name' | 'version'>;

export type MembershipStaffView = Omit<MembershipView, 'hold_harmless'> & { hold_harmless: HoldHarmless | HoldHarmlessSummary | null };

/**
 * The one way a membership leaves the API on a staff route. Admins get every
 * field; a market manager gets the signature without `ip` and `token`. For
 * everyone, `insurance.expires_on` is resolved in the market's `timezone`
 * (stored, or derived for an older document).
 */
export function membershipViewFor(viewer: { role: string }, membership: MembershipView, opts: { timezone: string }): MembershipStaffView {
  const insurance: MembershipInsurance = { ...membership.insurance, expires_on: insuranceExpiresOn(membership.insurance, opts.timezone) };
  const signed = membership.hold_harmless;
  const hold_harmless = !signed ? null : viewer.role === 'admin' ? signed : { signed_at: signed.signed_at, name: signed.name, version: signed.version };
  return { ...membership, insurance, hold_harmless };
}

/**
 * A per-request lookup of market timezones for `membershipViewFor`: each
 * market document is read once however many memberships name it. 'UTC' for a
 * market that is gone or carries no timezone.
 */
export function marketTimezones(db: Firestore): (marketId: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (marketId: string) => {
    let hit = cache.get(marketId);
    if (!hit) {
      hit = (async () => {
        if (!marketId || marketId.includes('/')) return 'UTC';
        const doc = await db.collection('farmers_markets').doc(marketId).get();
        const tz = doc.exists ? (doc.data() as Record<string, unknown>).timezone : null;
        return typeof tz === 'string' && tz ? tz : 'UTC';
      })();
      cache.set(marketId, hit);
    }
    return hit;
  };
}

/** `membershipViewFor` over a list, each in its own market's timezone. */
export async function membershipViewsFor(db: Firestore, viewer: { role: string }, memberships: MembershipView[]): Promise<MembershipStaffView[]> {
  const timezoneOf = marketTimezones(db);
  const out: MembershipStaffView[] = [];
  for (const m of memberships) out.push(membershipViewFor(viewer, m, { timezone: await timezoneOf(m.market_id) }));
  return out;
}
