import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { isAlreadyExists } from '../db/firestore.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { addDays, eachDate, parseDate, weekdayOf } from '../utils/tz.js';
import {
  applicationsOpen,
  marketCategories,
  marketFees,
  marketLegal,
  marketPaymentLinks,
  marketProductTypes,
  type FarmersMarket,
  type MarketFees,
  type ScheduleVersion,
} from './markets.js';
import { currentSeason, listCurrentMemberships } from './seasons.js';
import { UPLOAD_LIMITS } from './application-uploads.js';
import { addressSchema, productEntrySchema } from './producers.js';
import { CLAIM_TTL_MS } from './checkin-workflow.js';

/**
 * The 2027 producer application (Phase 4 contract §2.2, §3.1): the public
 * submission schema, the season total, the public configuration the form
 * renders from, and the admin queue projection.
 *
 * Nothing here names a market, a fee, a date or a stall: all of it is market
 * data (`farmers_markets` + `booths`).
 */

export { addressSchema, productEntrySchema };

export const STALL_PREFERENCE_MAX = 3;

/** A market id is its slug (the same pattern `createMarketSchema` enforces). */
export const MARKET_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Flood backstop for the public submission (Phase 4 fix X2), independent of
 * the caller's address: at most this many NEW applications per market per UTC
 * day. The next one is a 503 until 00:00 UTC and staff are alerted. A real
 * market takes a few dozen applications in a whole season.
 */
export const SUBMISSION_LIMITS = { daily_per_market: 150 } as const;

/* ── Option lists (not per market; contract §2.1) ── */

export interface OptionItem {
  key: string;
  label: string;
}

export const PAYMENT_METHOD_OPTIONS: OptionItem[] = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Credit or debit card' },
  { key: 'check', label: 'Check' },
  { key: 'wic', label: 'WIC' },
  { key: 'snap', label: 'SNAP/EBT' },
];

export const FREQUENCY_OPTIONS: OptionItem[] = [
  { key: 'every_other_week', label: 'Every other week' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'occasional', label: 'Occasionally' },
];

const MONTH_KEYS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;

export const AGRICULTURAL_PRACTICE_OPTIONS: OptionItem[] = [
  { key: 'certified_organic', label: 'Certified organic' },
  { key: 'certified_naturally_grown', label: 'Certified Naturally Grown' },
  { key: 'no_chemicals', label: 'No synthetic chemicals (not certified)' },
  { key: 'conventional', label: 'Conventional' },
  { key: 'not_applicable', label: 'Not applicable' },
];

/* ── The public submission schema (contract §3.1) ── */

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const str = (max: number) => z.string().trim().max(max);
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      parseDate(v);
      return true;
    } catch {
      return false;
    }
  }, 'not a calendar date');

export const permitEntrySchema = z
  .object({
    status: z.enum(['uploaded', 'will_provide', 'not_required', 'food_freedom']),
    upload_id: z.string().uuid().nullable().default(null),
    note: str(500).default(''),
  })
  .refine((p) => p.status !== 'uploaded' || !!p.upload_id, { message: 'upload_id is required when status is uploaded', path: ['upload_id'] });

const ack = (message: string) => z.literal(true, { errorMap: () => ({ message }) });

export const applicationSubmitSchema = z.object({
  market_id: z.string().regex(MARKET_ID_RE),
  draft_id: z.string().uuid(),
  prefill_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().default(null),
  contact: z.object({
    name: str(120).min(1),
    business_name: str(200).min(1),
    email: z.string().trim().email().max(254),
    mobile: z.string().trim().min(10).max(20),
    website: str(300).default(''),
    social: str(300).default(''),
    address: addressSchema,
    description: str(3000).default(''),
    years_in_operation: z.number().int().min(0).max(150).nullable().default(null),
    outlets: str(1000).default(''),
    agricultural_practices: z.enum(['certified_organic', 'certified_naturally_grown', 'no_chemicals', 'conventional', 'not_applicable']),
    additional_info: str(3000).default(''),
  }),
  sms_consent: z.literal(true, { errorMap: () => ({ message: 'Text consent is required' }) }),
  sms_consent_version: str(40).min(1),
  returning: z.object({ is_returning: z.boolean(), last_stall: str(12).nullable().default(null) }),
  categories: z.array(z.string().regex(KEY)).min(1).max(4),
  products: z
    .array(productEntrySchema)
    .min(1)
    .max(9)
    .refine((p) => new Set(p.map((e) => e.type)).size === p.length, 'duplicate product type'),
  permits: z.record(z.string().regex(KEY), permitEntrySchema).default({}),
  booth: z
    .object({
      rate: z.enum(['seasonal', 'daily']),
      frequency: z.enum(['every_other_week', 'monthly', 'occasional']).nullable().default(null),
      months: z.array(z.string().regex(KEY)).max(12).default([]),
      spaces: z.union([z.literal(1), z.literal(2)]),
      electric: z.boolean(),
      pay_in_full: z.boolean(),
      stall_preference: z.array(z.string().min(1).max(60)).max(STALL_PREFERENCE_MAX).default([]),
      food_truck: z.boolean().default(false),
    })
    .refine((b) => b.rate !== 'daily' || b.frequency !== null, { message: 'frequency is required for the daily rate', path: ['frequency'] }),
  payment_methods: z.array(z.enum(['cash', 'card', 'check', 'wic', 'snap'])).min(1),
  insurance: z.object({
    status: z.enum(['have', 'none', 'need_guidance']),
    certificate_upload_id: z.string().uuid().nullable().default(null),
    carrier: str(120).default(''),
    expires_on: dateString.nullable().default(null),
  }),
  acknowledgements: z.object({
    rules: ack('Please accept the market rules'),
    weekly_report: ack('Please accept the weekly report requirement'),
    farm_visits: ack('Please accept the farm or facility visit requirement'),
    marketing: ack('Please accept the marketing use of names, logos and photos'),
    products_listed_only: ack('Please confirm you will sell only the products you listed'),
    own_booth_only: ack('Please confirm you will sell only what you grow, raise or produce, from your own booth'),
  }),
  rules_version: str(40),
  signature_name: str(120).min(2),
});
export type ApplicationSubmitInput = z.infer<typeof applicationSubmitSchema>;

/* ── Season total (contract §2.2) ── */

export interface SeasonTotal {
  rate: 'seasonal' | 'daily';
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  market_count: number;
  booth_fee: number;
  electric_fee: number;
  total: number;
  basis: 'season' | 'per_market';
  installments: number;
  application_fee: number;
  currency: string;
}

export interface BoothChoice {
  rate: 'seasonal' | 'daily';
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
}

/**
 * Pure. Seasonal: booth fee per space (the paid-in-full amount when the
 * vendor pays at once) plus a single electricity charge; daily: the per-market
 * rate per space plus the per-market electricity charge. Electricity is
 * charged once per vendor (one hookup); the rules charge booth fees per
 * space. `pay_in_full` means nothing for the daily rate.
 */
export function computeSeasonTotal(fees: MarketFees, booth: BoothChoice, marketCount: number): SeasonTotal {
  const seasonal = booth.rate === 'seasonal';
  const payInFull = seasonal && booth.pay_in_full;
  const boothFee = seasonal ? (payInFull ? fees.seasonal_paid_in_full : fees.seasonal_total) * booth.spaces : fees.daily * booth.spaces;
  const electricFee = booth.electric ? (seasonal ? fees.electric_seasonal : fees.electric_daily) : 0;
  return {
    rate: booth.rate,
    spaces: booth.spaces,
    electric: booth.electric,
    pay_in_full: payInFull,
    market_count: marketCount,
    booth_fee: boothFee,
    electric_fee: electricFee,
    total: boothFee + electricFee,
    basis: seasonal ? 'season' : 'per_market',
    installments: seasonal ? (payInFull ? 1 : fees.seasonal_installments) : 0,
    application_fee: fees.application_fee,
    currency: fees.currency,
  };
}

/* ── The season window of a market ── */

/** The schedule version an application season is built on: the one `season.schedule_version_id` names, else the one with the greatest `season_start`. */
export function seasonVersion(market: Pick<FarmersMarket, 'schedule' | 'season'>): ScheduleVersion | null {
  const versions = market.schedule?.versions ?? [];
  if (versions.length === 0) return null;
  const id = market.season?.schedule_version_id;
  const named = id ? versions.find((v) => v.id === id) : undefined;
  if (named) return named;
  return [...versions].sort((a, b) => b.season_start.localeCompare(a.season_start))[0]!;
}

/**
 * Every market date of the version's season: the dates in `[season_start,
 * season_end]` on its days of week, minus `skipped_dates`, plus `special_dates`
 * inside the range. Sorted, unique.
 */
export function seasonDates(market: Pick<FarmersMarket, 'schedule'>, version: ScheduleVersion): string[] {
  const skipped = new Set(market.schedule.skipped_dates.map((s) => s.date));
  const dates = new Set<string>();
  for (const d of eachDate(version.season_start, version.season_end)) {
    if (version.days_of_week.includes(weekdayOf(d)) && !skipped.has(d)) dates.add(d);
  }
  for (const s of market.schedule.special_dates) {
    if (s.date >= version.season_start && s.date <= version.season_end) dates.add(s.date);
  }
  return [...dates].sort();
}

export interface SeasonSummary {
  start: string | null;
  end: string | null;
  market_count: number;
  days_of_week: string[];
  start_time: string | null;
  end_time: string | null;
}

export function summarizeSeason(market: Pick<FarmersMarket, 'schedule' | 'season'>): { version: ScheduleVersion | null; dates: string[]; summary: SeasonSummary } {
  const version = seasonVersion(market);
  if (!version) {
    return { version: null, dates: [], summary: { start: null, end: null, market_count: 0, days_of_week: [], start_time: null, end_time: null } };
  }
  const dates = seasonDates(market, version);
  return {
    version,
    dates,
    summary: {
      start: version.season_start,
      end: version.season_end,
      market_count: dates.length,
      days_of_week: [...version.days_of_week],
      start_time: version.start_time,
      end_time: version.end_time,
    },
  };
}

/* ── Public configuration (GET /api/applications/config) ── */

export interface StallPublic {
  id: string;
  label: string;
  row: string;
  order: number;
  kind: 'stall' | 'food_truck';
  power: boolean;
  size: string;
  usually_taken: boolean;
}

/** Active booths of a market, sorted by row then order, as the public form sees them. */
export async function loadStalls(db: Firestore, market: FarmersMarket, now: Date): Promise<StallPublic[]> {
  const snap = await db.collection('booths').where('market_id', '==', market.id).get();
  const { memberships } = await listCurrentMemberships(db, market, now);
  const taken = new Set(memberships.filter((m) => m.status !== 'inactive' && m.usual_booth_id).map((m) => m.usual_booth_id as string));
  const stalls: StallPublic[] = snap.docs
    .filter((d) => (d.data() as Record<string, unknown>).active !== false)
    .map((d) => {
      const b = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        label: String(b.label ?? d.id),
        row: String(b.row ?? ''),
        order: typeof b.order === 'number' ? b.order : 0,
        kind: b.kind === 'food_truck' ? ('food_truck' as const) : ('stall' as const),
        power: b.power === true,
        size: String(b.size ?? ''),
        usually_taken: taken.has(d.id),
      };
    });
  stalls.sort((a, b) => a.row.localeCompare(b.row) || a.order - b.order || a.label.localeCompare(b.label));
  return stalls;
}

export async function buildApplicationConfig(db: Firestore, market: FarmersMarket, now: Date) {
  const { version, dates, summary } = summarizeSeason(market);
  const legal = marketLegal(market);
  // The two markdown bodies never ride along on the public config: /rules and /agreement serve them.
  const { rules_markdown, hold_harmless_markdown: _holdHarmless, ...legalPublic } = legal;

  const monthNumbers: number[] = [];
  for (const d of dates) {
    const m = Number(d.slice(5, 7));
    if (!monthNumbers.includes(m)) monthNumbers.push(m);
  }
  const months: OptionItem[] = monthNumbers.map((m) => {
    const key = MONTH_KEYS[m - 1]!;
    return { key, label: key.charAt(0).toUpperCase() + key.slice(1) };
  });

  return {
    market: {
      id: market.id,
      name: market.name,
      location_name: market.location?.name ?? '',
      location_address: market.location?.address ?? '',
      timezone: market.timezone,
      booth_map_url: market.booth_map_url ?? null,
    },
    season: {
      label: market.season?.label ?? currentSeason(market, now),
      application_open: market.season?.application_open ?? null,
      application_close: market.season?.application_close ?? null,
      schedule_version_id: version?.id ?? null,
      ...summary,
      open_now: applicationsOpen(market, now),
    },
    fees: marketFees(market),
    payment_links: marketPaymentLinks(market),
    legal: { ...legalPublic, has_rules_text: rules_markdown !== '' },
    categories: marketCategories(market),
    product_types: marketProductTypes(market),
    stalls: await loadStalls(db, market, now),
    payment_methods: PAYMENT_METHOD_OPTIONS,
    frequencies: FREQUENCY_OPTIONS,
    months,
    agricultural_practices: AGRICULTURAL_PRACTICE_OPTIONS,
    limits: {
      upload_max_bytes: UPLOAD_LIMITS.max_bytes,
      upload_mimes: [...UPLOAD_LIMITS.mimes],
      stall_preference_max: STALL_PREFERENCE_MAX,
      upload_retention_hours: UPLOAD_LIMITS.unattached_ttl_hours,
    },
  };
}

/** `{email}` in a payment link becomes the applicant's URL-encoded email. */
export function fillPaymentUrl(template: string | null, email: string): string | null {
  if (!template) return null;
  return template.replaceAll('{email}', encodeURIComponent(email));
}

/** First market date of the season (for the acceptance email), or null. */
export function firstSeasonDate(market: Pick<FarmersMarket, 'schedule' | 'season'>): string | null {
  return summarizeSeason(market).dates[0] ?? null;
}

/* ── Stored application: reads and the queue projection ── */

export type ApplicationRecord = Record<string, unknown>;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Phase 2 documents (page-1 fields) have no `contact`; they read as schema_version 1. */
export function isLegacyApplication(data: ApplicationRecord): boolean {
  return data.schema_version !== 2 || !data.contact;
}

export interface ApplicationListItem {
  id: string;
  market_id: string;
  season: string;
  status: string;
  business_name: string;
  contact_name: string;
  email: string;
  mobile: string;
  categories: string[];
  product_types: string[];
  rate: 'seasonal' | 'daily';
  spaces: 1 | 2;
  electric: boolean;
  is_returning: boolean;
  fee_status: string;
  insurance_status: string;
  permits_pending: number;
  submitted_at: Date;
  producer_id: string | null;
}

/** One queue row. Tolerates the Phase 2 document (legacy fields are mapped, the rest default). */
export function projectApplicationListItem(id: string, data: ApplicationRecord): ApplicationListItem {
  if (isLegacyApplication(data)) {
    const markets = Array.isArray(data.markets_applied) ? (data.markets_applied as unknown[]) : [];
    return {
      id,
      market_id: typeof data.market_id === 'string' ? data.market_id : String(markets[0] ?? ''),
      season: typeof data.season === 'string' ? data.season : '',
      status: typeof data.status === 'string' ? data.status : 'new',
      business_name: String(data.business_name ?? ''),
      contact_name: String(data.contact_person ?? ''),
      email: String(data.email ?? ''),
      mobile: String(data.phone ?? ''),
      categories: [],
      product_types: [],
      rate: 'daily',
      spaces: 1,
      electric: false,
      is_returning: false,
      fee_status: 'unpaid',
      insurance_status: 'none',
      permits_pending: 0,
      submitted_at: toDateOrEpoch(data.submitted_at),
      producer_id: typeof data.producer_id === 'string' ? data.producer_id : null,
    };
  }
  const contact = asRecord(data.contact);
  const booth = asRecord(data.booth);
  const fee = asRecord(data.fee);
  const insurance = asRecord(data.insurance);
  const permits = asRecord(data.permits);
  const products = Array.isArray(data.products) ? (data.products as unknown[]) : [];
  return {
    id,
    market_id: String(data.market_id ?? ''),
    season: String(data.season ?? ''),
    status: typeof data.status === 'string' ? data.status : 'new',
    business_name: String(contact.business_name ?? ''),
    contact_name: String(contact.name ?? ''),
    email: String(contact.email ?? ''),
    mobile: String(contact.mobile ?? ''),
    categories: Array.isArray(data.categories) ? (data.categories as unknown[]).map(String) : [],
    product_types: products.map((p) => String(asRecord(p).type ?? '')),
    rate: booth.rate === 'seasonal' ? 'seasonal' : 'daily',
    spaces: booth.spaces === 2 ? 2 : 1,
    electric: booth.electric === true,
    is_returning: asRecord(data.returning).is_returning === true,
    fee_status: typeof fee.status === 'string' ? fee.status : 'unpaid',
    insurance_status: typeof insurance.status === 'string' ? insurance.status : 'none',
    permits_pending: Object.values(permits).filter((p) => asRecord(p).status === 'will_provide').length,
    submitted_at: toDateOrEpoch(data.submitted_at),
    producer_id: typeof data.producer_id === 'string' ? data.producer_id : null,
  };
}

/** The application's `products[].items`, flattened and de-duplicated in order (what the membership's `approved_items` starts as). */
export function flattenItems(products: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(products) ? products : []) {
    const items = asRecord(p).items;
    for (const item of Array.isArray(items) ? items : []) {
      const s = String(item).trim();
      const key = s.toLowerCase();
      if (s && !seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    }
  }
  return out;
}

/** `YYYY-MM-DD` of the day after `date`. */
export function dayAfter(date: string): string {
  return addDays(date, 1);
}

/* ── One live application per email, market and season (fix X3d) ── */

/** True for an application that still counts: anything but declined or withdrawn. */
export function isLiveApplication(data: ApplicationRecord): boolean {
  return data.status !== 'declined' && data.status !== 'withdrawn';
}

/**
 * How long a key may name an application that does not exist before it is
 * presumed abandoned. The submission writes the key and then the application
 * within one request; the API function times out at 120 s, so no live request
 * can leave that gap open this long.
 */
export const APPLICATION_KEY_PENDING_MS = 3 * 60_000;

/**
 * `application_keys` doc id: market + season + sha256 of the lower-cased
 * email. The address itself is never part of an id (ids show up in logs and
 * in the console). A market slug has no '_' and a season label has none
 * either (`MARKET_ID_RE`, `SEASON_LABEL_RE`), so the three parts cannot run
 * into each other.
 */
export function applicationKeyId(marketId: string, season: string, email: string): string {
  const hash = crypto.createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
  return `${marketId}_${season}_${hash}`;
}

export type ApplicationKeyClaim =
  /** The key now names `application_id`: the caller may create that application. */
  | { ok: true }
  /** Another application holds the key. `holder` is its document, or null while its submission is still in flight. */
  | { ok: false; holder_id: string; holder: ApplicationRecord | null };

/**
 * Claims the key of `(market, season, email)` for a new application, atomically.
 *
 * The key document is written with `create()` BEFORE the application, so of
 * any number of submissions arriving together for one email exactly one gets
 * past here; a read-then-write check of the `applications` collection cannot
 * promise that. When the key already exists:
 *
 *   - its application is live                      -> refused (the caller answers 409, or
 *                                                     the original result for a repeat);
 *   - its application was declined or withdrawn    -> the new application takes the key;
 *   - its application does not exist and the key is younger than
 *     APPLICATION_KEY_PENDING_MS                   -> refused, that submission is in flight;
 *   - its application does not exist and the key is older -> the earlier request died
 *     between its two writes; the new application takes the key.
 *
 * Residual race, documented (the same one the engine's `claim()` accepts): a
 * takeover is a read followed by a `set()`, so two submissions arriving
 * together at a key that is already free to take can both proceed. The
 * re-read after the write narrows that to requests interleaved between the
 * write and the re-read; the worst outcome is two applications from one
 * address in the queue, which the second approval then refuses.
 */
export async function claimApplicationKey(
  db: Firestore,
  args: { market_id: string; season: string; email: string; application_id: string; now: Date },
): Promise<ApplicationKeyClaim> {
  const { market_id, season, email, application_id, now } = args;
  const id = applicationKeyId(market_id, season, email);
  const ref = db.collection('application_keys').doc(id);
  const mine = { market_id, season, email_sha256: id.slice(id.lastIndexOf('_') + 1), application_id, claimed_at: now, created_at: now };
  try {
    await ref.create(mine);
    return { ok: true };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  const key = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  const holderId = typeof key.application_id === 'string' ? key.application_id : '';
  const holderDoc = holderId ? await db.collection('applications').doc(holderId).get() : null;
  if (holderDoc?.exists) {
    const holder = holderDoc.data() as ApplicationRecord;
    if (isLiveApplication(holder)) return { ok: false, holder_id: holderId, holder };
  } else {
    const claimedAt = toDate(key.claimed_at);
    if (holderId && claimedAt && now.getTime() - claimedAt.getTime() < APPLICATION_KEY_PENDING_MS) {
      return { ok: false, holder_id: holderId, holder: null };
    }
  }

  // Free to take: the earlier application ended, or its submission never finished.
  await ref.set({ ...mine, created_at: toDate(key.created_at) ?? now, previous_application_id: holderId || null });
  const after = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  if (after.application_id !== application_id) {
    return { ok: false, holder_id: String(after.application_id ?? ''), holder: null };
  }
  return { ok: true };
}

/** Lets go of a key this submission claimed but could not use (its application was never written). Best effort. */
export async function releaseApplicationKey(
  db: Firestore,
  args: { market_id: string; season: string; email: string; application_id: string },
): Promise<void> {
  const ref = db.collection('application_keys').doc(applicationKeyId(args.market_id, args.season, args.email));
  try {
    const key = (await ref.get()).data() as Record<string, unknown> | undefined;
    if (key && key.application_id === args.application_id) await ref.delete();
  } catch {
    // The key goes stale by itself after APPLICATION_KEY_PENDING_MS.
  }
}

/* ── A lock for one staff action at a time (fix X3e) ── */

export type StaffLock = { acquired: true; run_id: string } | { acquired: false };

/**
 * Takes `workflow_locks/<id>` with the atomic `create()`: of any number of
 * staff requests arriving together exactly one acquires it. A lock younger
 * than the engine's CLAIM_TTL_MS that someone else holds is refused; an older
 * one belongs to a request that died and is taken over (the takeover is a
 * read then a `set()`, the engine's documented residual race).
 */
export async function acquireStaffLock(db: Firestore, id: string, actor: string, now: Date): Promise<StaffLock> {
  const ref = db.collection('workflow_locks').doc(id);
  const run_id = uuid();
  try {
    await ref.create({ key: id, claimed_at: now, claimed_by: actor, run_id, created_at: now });
    return { acquired: true, run_id };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const lock = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  const claimedAt = toDate(lock.claimed_at);
  if (claimedAt && now.getTime() - claimedAt.getTime() < CLAIM_TTL_MS) return { acquired: false };
  await ref.set({
    key: id,
    claimed_at: now,
    claimed_by: actor,
    run_id,
    taken_over_from: typeof lock.run_id === 'string' ? lock.run_id : null,
    created_at: toDate(lock.created_at) ?? now,
  });
  return { acquired: true, run_id };
}

/** Releases a lock this request still holds, so a refused or failed action can be retried at once. Best effort. */
export async function releaseStaffLock(db: Firestore, id: string, lock: StaffLock): Promise<void> {
  if (!lock.acquired) return;
  const ref = db.collection('workflow_locks').doc(id);
  try {
    const current = (await ref.get()).data() as Record<string, unknown> | undefined;
    if (current && current.run_id === lock.run_id) await ref.delete();
  } catch {
    // It goes stale by itself after CLAIM_TTL_MS.
  }
}

/** `workflow_locks` id of the approval of one application. */
export function approvalLockId(applicationId: string): string {
  return `application_approve__${applicationId}`;
}

/** `workflow_locks` id of "a producer is being created or merged for this email": never two producers for one address. */
export function producerIdentityLockId(email: string): string {
  return `producer_identity__${crypto.createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex')}`;
}
