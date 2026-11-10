import { z } from 'zod';
import { DAYS_OF_WEEK, isValidTimeZone, parseDate, utcToLocalDate } from '../utils/tz.js';
import type { DayOfWeek } from '../utils/tz.js';
import { nextAllowedInstant } from '../utils/quiet-hours.js';
import { SEASON_LABEL_RE } from './seasons.js';

/**
 * Market document shapes and zod validation (Phase 2 contract §2.1, §4.1).
 * `src/services/market-dates.ts` (the generator) and `src/routes/markets.ts`
 * both build on these.
 */

export interface ScheduleVersion {
  id: string;
  effective_from: string;
  season_start: string;
  season_end: string;
  days_of_week: DayOfWeek[];
  start_time: string;
  end_time: string;
  created_at: Date;
  created_by: string;
}

export interface SkippedDate {
  date: string;
  reason: string;
}

export interface SpecialDate {
  date: string;
  start_time: string;
  end_time: string;
  note: string;
}

export interface Workflow {
  checkin_offset_min: number;
  reminder_offsets_min: number[];
  deadline_offset_min: number;
  drafts_offset_min: number;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface WebsiteConfig {
  duda_site_id: string;
  thisweek_page_id: string;
  vendor_collection_id: string;
}

export interface MailchimpConfig {
  audience_id: string;
  template_id: string;
}

/* ── Phase 4 (contract §2.1): season, fees, legal texts, application configuration ── */

export interface MarketSeason {
  label: string;
  application_open: string | null; // YYYY-MM-DD, market-local
  application_close: string | null;
  schedule_version_id: string | null;
}

export interface MarketFees {
  application_fee: number;
  seasonal_total: number;
  seasonal_paid_in_full: number;
  seasonal_installments: number;
  daily: number;
  electric_seasonal: number;
  electric_daily: number;
  currency: string;
}

export interface MarketPaymentLinks {
  /** May contain `{email}`, which the server replaces with the applicant's encoded email. */
  application_fee_url: string | null;
  booth_fee_url: string | null;
}

export interface MarketLegal {
  rules_markdown: string;
  rules_version: string;
  rules_url: string | null;
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  insurance_help_url: string | null;
  /**
   * The market's own sentence about the insurance a vendor must carry (the
   * amount, who must be named as additional insured). Plain text, shown on the
   * application and in the acceptance email; '' = say nothing. Market data,
   * never wording in code (Phase 4 fix X7).
   */
  insurance_requirements_text: string;
  adh_guidelines_url: string | null;
  food_freedom_url: string | null;
  sms_consent_text: string;
  sms_consent_version: string;
}

export interface MarketCategory {
  key: string;
  label: string;
  description: string;
  events_only: boolean;
  sort: number;
}

export interface PracticeOption {
  key: string;
  label: string;
}

export type PermitUploadRule = 'none' | 'optional' | 'required' | 'required_unless_food_freedom';

export interface ProductDetailField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required: boolean;
  hint: string;
}

export interface ProductTypeConfig {
  key: string;
  label: string;
  /** Which of the categories this type may be listed under. */
  category_keys: string[];
  examples: string;
  /** The rules' permit text shown inline, plain text. */
  permit_rule: string;
  permit_upload: PermitUploadRule;
  /** Prohibited items shown under the type, plain text ('' when none). */
  prohibited: string;
  practice_checklist: PracticeOption[];
  details: ProductDetailField[];
  sort: number;
}

export interface FarmersMarket {
  id: string; // == slug
  name: string;
  slug: string;
  location: { name: string; address: string };
  timezone: string;
  schedule: {
    versions: ScheduleVersion[];
    skipped_dates: SkippedDate[];
    special_dates: SpecialDate[];
  };
  workflow: Workflow;
  quiet_hours: QuietHours;
  website?: WebsiteConfig | null;
  mailchimp?: MailchimpConfig | null;
  /** Phase 4. All optional: a market saved before Phase 4 reads with the defaults below; applications stay closed until `season.label` is set. */
  season?: MarketSeason | null;
  fees?: MarketFees;
  payment_links?: MarketPaymentLinks;
  legal?: MarketLegal;
  booth_map_url?: string | null;
  categories?: MarketCategory[];
  product_types?: ProductTypeConfig[];
  active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export const DEFAULT_WORKFLOW: Workflow = {
  checkin_offset_min: 60,
  reminder_offsets_min: [1440, 2880],
  deadline_offset_min: 4320,
  drafts_offset_min: 4380,
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  start: '21:00',
  end: '08:00',
};

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => {
    try {
      parseDate(v);
      return true;
    } catch {
      return false;
    }
  }, 'not a calendar date');

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

const timezoneString = z.string().refine(isValidTimeZone, 'not a valid IANA timezone');

export const scheduleVersionSchema = z
  .object({
    effective_from: dateString,
    season_start: dateString,
    season_end: dateString,
    days_of_week: z.array(z.enum(DAYS_OF_WEEK as unknown as [DayOfWeek, ...DayOfWeek[]])).min(1),
    start_time: timeString,
    end_time: timeString,
  })
  .refine((v) => v.season_start <= v.season_end, { message: 'season_start must be on or before season_end', path: ['season_end'] })
  .refine((v) => v.end_time > v.start_time, { message: 'end_time must be after start_time', path: ['end_time'] });

export const skippedDatesSchema = z.object({
  skipped_dates: z
    .array(z.object({ date: dateString, reason: z.string().min(1) }))
    .refine((arr) => new Set(arr.map((s) => s.date)).size === arr.length, 'duplicate date in skipped_dates'),
});

export const specialDatesSchema = z.object({
  special_dates: z
    .array(
      z.object({ date: dateString, start_time: timeString, end_time: timeString, note: z.string().default('') }),
    )
    .refine((arr) => new Set(arr.map((s) => s.date)).size === arr.length, 'duplicate date in special_dates'),
});

export const extraQuestionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  prompt: z.string().min(1),
  type: z.enum(['text', 'choice', 'yes_no']),
  options: z.array(z.string()).optional(),
}).refine((v) => v.type !== 'choice' || (v.options && v.options.length > 0), {
  message: 'options is required when type is choice',
  path: ['options'],
});

const workflowSchema = z.object({
  checkin_offset_min: z.number().int(),
  reminder_offsets_min: z.array(z.number().int()),
  deadline_offset_min: z.number().int(),
  drafts_offset_min: z.number().int(),
});

const quietHoursSchema = z.object({ start: timeString, end: timeString });

const websiteSchema = z.object({
  duda_site_id: z.string(),
  thisweek_page_id: z.string(),
  vendor_collection_id: z.string(),
});

const mailchimpSchema = z.object({ audience_id: z.string(), template_id: z.string() });

/**
 * A market id is its slug. Public routes test an id against this BEFORE using
 * it as a document id: the admin SDK throws (a 500 and an alert) on an id
 * that contains a slash, is empty, or is `.`/`..`, and none of those can be a
 * market.
 */
export const MARKET_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const createMarketSchema = z.object({
  slug: z.string().regex(MARKET_SLUG_RE),
  name: z.string().min(1),
  location: z.object({ name: z.string().min(1), address: z.string().optional().default('') }),
  timezone: timezoneString.default('America/Chicago'),
  schedule: z.object({
    versions: z.array(scheduleVersionSchema).length(1),
    skipped_dates: z.array(z.object({ date: dateString, reason: z.string().min(1) })).default([]),
    special_dates: z
      .array(z.object({ date: dateString, start_time: timeString, end_time: timeString, note: z.string().default('') }))
      .default([]),
  }),
  workflow: workflowSchema.default(DEFAULT_WORKFLOW),
  quiet_hours: quietHoursSchema.default(DEFAULT_QUIET_HOURS),
  website: websiteSchema.optional(),
  mailchimp: mailchimpSchema.optional(),
  active: z.boolean().default(true),
});

/* ── Phase 4 zod (contract §2.1) ── */

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

function parsesAsUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/** http(s) only: these URLs become links on public pages, so no javascript:/data: schemes. `{email}` is allowed in a payment link. */
const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v) && parsesAsUrl(v), 'expected an http(s) URL');

const uniqueKeys = (items: { key: string }[]) => new Set(items.map((i) => i.key)).size === items.length;

export const marketSeasonSchema = z
  .object({
    label: z.string().regex(SEASON_LABEL_RE, "season label must be a year such as '2030', optionally with a suffix such as '2030-winter'"),
    application_open: dateString.nullable().default(null),
    application_close: dateString.nullable().default(null),
    schedule_version_id: z.string().min(1).nullable().default(null),
  })
  .refine((s) => !s.application_open || !s.application_close || s.application_open <= s.application_close, {
    message: 'application_open must be on or before application_close',
    path: ['application_close'],
  });

const feeAmount = z.number().int().min(0).max(1_000_000);

export const feesSchema = z.object({
  application_fee: feeAmount,
  seasonal_total: feeAmount,
  seasonal_paid_in_full: feeAmount,
  seasonal_installments: z.number().int().min(1).max(12),
  daily: feeAmount,
  electric_seasonal: feeAmount,
  electric_daily: feeAmount,
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter code')
    .transform((v) => v.toUpperCase()),
});

export const paymentLinksSchema = z.object({
  application_fee_url: httpUrl.nullable(),
  booth_fee_url: httpUrl.nullable(),
});

export const legalSchema = z.object({
  rules_markdown: z.string().max(50_000),
  rules_version: z.string().max(40),
  rules_url: httpUrl.nullable(),
  hold_harmless_markdown: z.string().max(50_000),
  hold_harmless_version: z.string().max(40),
  insurance_help_url: httpUrl.nullable(),
  insurance_requirements_text: z.string().trim().max(2000),
  adh_guidelines_url: httpUrl.nullable(),
  food_freedom_url: httpUrl.nullable(),
  sms_consent_text: z.string().min(1).max(2000),
  sms_consent_version: z.string().min(1).max(40),
});

export const categorySchema = z.object({
  key: z.string().regex(KEY_RE),
  label: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  events_only: z.boolean().default(false),
  sort: z.number().int(),
});

const practiceSchema = z.object({ key: z.string().regex(KEY_RE), label: z.string().min(1).max(120) });

const detailFieldSchema = z.object({
  key: z.string().regex(KEY_RE),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'number', 'boolean']),
  required: z.boolean().default(false),
  hint: z.string().max(300).default(''),
});

export const productTypeSchema = z
  .object({
    key: z.string().regex(KEY_RE),
    label: z.string().min(1).max(200),
    category_keys: z.array(z.string().regex(KEY_RE)).min(1).max(12),
    examples: z.string().max(500).default(''),
    permit_rule: z.string().max(2000).default(''),
    permit_upload: z.enum(['none', 'optional', 'required', 'required_unless_food_freedom']),
    prohibited: z.string().max(1000).default(''),
    practice_checklist: z.array(practiceSchema).max(60).default([]),
    details: z.array(detailFieldSchema).max(20).default([]),
    sort: z.number().int(),
  })
  .refine((t) => uniqueKeys(t.practice_checklist), { message: 'duplicate practice key', path: ['practice_checklist'] })
  .refine((t) => uniqueKeys(t.details), { message: 'duplicate detail key', path: ['details'] });

/** A booth map is an absolute path on this site (e.g. `/wlrfm-vendor-map.jpg`) or an http(s) URL. */
const boothMapUrl = z.string().max(2000).refine((v) => (/^\/(?!\/)/.test(v) && !/\s/.test(v)) || (/^https?:\/\//i.test(v) && parsesAsUrl(v)), 'expected an absolute path or an http(s) URL');

export const updateMarketSchema = z.object({
  name: z.string().min(1).optional(),
  location: z.object({ name: z.string().min(1), address: z.string().optional().default('') }).optional(),
  timezone: timezoneString.optional(),
  workflow: workflowSchema.partial().optional(),
  quiet_hours: quietHoursSchema.optional(),
  website: websiteSchema.optional(),
  mailchimp: mailchimpSchema.optional(),
  active: z.boolean().optional(),
  // Phase 4. `season` replaces the stored object (null clears it: applications close, the season label is inferred again);
  // fees / payment_links / legal merge their keys into the stored (or default) object and the whole object is written back.
  season: marketSeasonSchema.nullable().optional(),
  fees: feesSchema.partial().optional(),
  payment_links: paymentLinksSchema.partial().optional(),
  legal: legalSchema.partial().optional(),
  booth_map_url: boothMapUrl.nullable().optional(),
  categories: z.array(categorySchema).max(12).refine(uniqueKeys, 'duplicate category key').optional(),
  product_types: z.array(productTypeSchema).max(30).refine(uniqueKeys, 'duplicate product type key').optional(),
});

export type CreateMarketInput = z.infer<typeof createMarketSchema>;
export type UpdateMarketInput = z.infer<typeof updateMarketSchema>;

/* ── Phase 4 defaults (contract §2.1). Market DATA, applied on read when a market has not set its own. ── */

/** The 2027 §4 amounts. Editable per season through PATCH; never referenced by code outside this constant. */
export const DEFAULT_FEES: MarketFees = {
  application_fee: 15,
  seasonal_total: 700,
  seasonal_paid_in_full: 600,
  seasonal_installments: 2,
  daily: 25,
  electric_seasonal: 50,
  electric_daily: 5,
  currency: 'USD',
};

export const DEFAULT_PAYMENT_LINKS: MarketPaymentLinks = { application_fee_url: null, booth_fee_url: null };

export const DEFAULT_LEGAL: MarketLegal = {
  rules_markdown: '',
  rules_version: '',
  rules_url: null,
  hold_harmless_markdown: '',
  hold_harmless_version: '',
  insurance_help_url: null,
  insurance_requirements_text: '',
  adh_guidelines_url: null,
  food_freedom_url: null,
  sms_consent_text:
    'I agree to receive text messages from SJCA Markets about my market participation (weekly check-ins, booth assignments and market-day notices) at the mobile number above. Message frequency varies; message and data rates may apply. Reply STOP to opt out, HELP for help.',
  sms_consent_version: 'sjca-sms-1',
};

export const DEFAULT_CATEGORIES: MarketCategory[] = [
  {
    key: 'farmers_ranchers',
    label: 'Farmers / Ranchers',
    description: 'fruits, vegetables, meats, mushrooms, nuts, seeds, grains, eggs, herbs, plants, flowers',
    events_only: false,
    sort: 1,
  },
  {
    key: 'specialty_food',
    label: 'Specialty Food',
    description: 'baked goods, mixes, jams and jellies, honey, condiments, beverages, cheese, pet items',
    events_only: false,
    sort: 2,
  },
  {
    key: 'food_adjacent',
    label: 'Food-adjacent products',
    description: 'woodwork, pottery, fabric crafts, plant and botanical arts, natural skincare and cleaning products',
    events_only: false,
    sort: 3,
  },
  {
    key: 'crafts',
    label: 'Crafts (special events only)',
    description: 'soaps, lotions, candles, clothing, pottery, artwork, jewelry, leather',
    events_only: true,
    sort: 4,
  },
];

const PRACTICE_LABEL_OVERRIDES: Record<string, string> = {
  gap_certified: 'GAP certified',
  non_gmo_seed: 'Non-GMO seed',
  non_gmo_feed: 'Non-GMO feed',
  no_gmo: 'No GMOs',
  usda_inspected_processing: 'USDA-inspected processing',
  no_added_hormones: 'No added hormones',
  no_antibiotics: 'No antibiotics',
  food_freedom_labelled: 'Food Freedom labeled',
  other: 'Other',
};

function practice(key: string): PracticeOption {
  const label = PRACTICE_LABEL_OVERRIDES[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
  return { key, label };
}

const PRODUCE_PRACTICES = [
  'certified_organic', 'certified_naturally_grown', 'no_synthetic_pesticides', 'no_synthetic_fertilizers', 'no_herbicides',
  'integrated_pest_management', 'cover_crops', 'crop_rotation', 'compost', 'drip_irrigation', 'non_gmo_seed',
  'heirloom_varieties', 'high_tunnel', 'greenhouse', 'hydroponic', 'raised_beds', 'no_till', 'conventional',
  'gap_certified', 'food_safety_plan', 'cold_storage', 'other',
].map(practice);

const ANIMAL_PRACTICES = [
  'pasture_raised', 'grass_fed', 'grass_finished', 'free_range', 'cage_free', 'no_antibiotics', 'no_added_hormones',
  'non_gmo_feed', 'organic_feed', 'certified_humane', 'animal_welfare_approved', 'usda_inspected_processing', 'on_farm_processing',
].map(practice);

function detail(key: string, label: string, type: ProductDetailField['type'], required: boolean, hint = ''): ProductDetailField {
  return { key, label, type, required, hint };
}

export const DEFAULT_PRODUCT_TYPES: ProductTypeConfig[] = [
  {
    key: 'produce',
    label: 'Produce, herbs, plants and flowers',
    category_keys: ['farmers_ranchers'],
    examples: 'vegetables, fruit, herbs, microgreens, cut flowers, bedding plants, mushrooms',
    permit_rule:
      'No permit is required for whole, uncut produce or microgreens. Plants and nursery stock must comply with Arkansas State Plant Board regulations.',
    permit_upload: 'none',
    prohibited: 'Wild-harvested mushrooms. Sprouts (microgreens are allowed).',
    practice_checklist: PRODUCE_PRACTICES,
    details: [detail('plant_board', 'I sell plants or nursery stock and comply with the Arkansas State Plant Board', 'boolean', false)],
    sort: 1,
  },
  {
    key: 'meat_poultry',
    label: 'Meat and poultry',
    category_keys: ['farmers_ranchers'],
    examples: 'beef, pork, lamb, chicken, turkey',
    permit_rule:
      'Meat and poultry must be processed in a USDA-inspected facility and sold frozen. Labels must include product name, net weight, farm name and address.',
    permit_upload: 'none',
    prohibited: '',
    practice_checklist: ANIMAL_PRACTICES,
    details: [detail('usda_facility', 'USDA-inspected processing facility', 'text', true)],
    sort: 2,
  },
  {
    key: 'eggs',
    label: 'Eggs',
    category_keys: ['farmers_ranchers'],
    examples: 'chicken, duck and quail eggs',
    permit_rule:
      'Eggs must be washed, pre-packaged, labeled "ungraded", labeled with the farm name and address, and refrigerated at all times.',
    permit_upload: 'none',
    prohibited: '',
    practice_checklist: ANIMAL_PRACTICES,
    details: [],
    sort: 3,
  },
  {
    key: 'dairy',
    label: 'Dairy and cheese',
    category_keys: ['farmers_ranchers', 'specialty_food'],
    examples: 'cheese, yogurt, butter, milk',
    permit_rule: 'A permit is required for dairy products. Upload your permit, or tell us you will provide it before your first market.',
    permit_upload: 'required',
    prohibited: '',
    practice_checklist: ANIMAL_PRACTICES,
    details: [detail('facility', 'Facility where the dairy products are made', 'text', true)],
    sort: 4,
  },
  {
    key: 'honey_sorghum',
    label: 'Honey and sorghum',
    category_keys: ['farmers_ranchers', 'specialty_food'],
    examples: 'honey, comb honey, sorghum syrup',
    permit_rule: 'No permit is required for honey and sorghum.',
    permit_upload: 'none',
    prohibited: '',
    practice_checklist: [],
    details: [
      detail('hives', 'Number of hives', 'number', true),
      detail('registered_inspected', 'Hives are registered and inspected', 'boolean', false),
      detail('commercial_facility', 'Processed in a commercial facility', 'boolean', false),
      detail('flavoured', 'Flavored or infused products', 'boolean', false),
    ],
    sort: 5,
  },
  {
    key: 'value_added',
    label: 'Baked goods, jams, canned goods, mixes, condiments, beverages',
    category_keys: ['specialty_food'],
    examples: 'bread, pastries, jams and jellies, pickles, sauces, spice mixes, coffee, kombucha',
    permit_rule:
      'Properly labeled Food Freedom products need no permit. Canned goods not approved by the Food Freedom Act and any TCS (time/temperature control for safety) food require a permit: upload it or tell us you will provide it before your first market.',
    permit_upload: 'required_unless_food_freedom',
    prohibited: '',
    practice_checklist: ['certified_kitchen', 'food_freedom_labelled', 'batch_records', 'allergen_labelling', 'cottage_food_training'].map(practice),
    details: [
      detail('facility_kind', 'Where is it made?', 'text', true, 'home kitchen (Food Freedom), commercial kitchen, or own licensed facility'),
      detail('certifications', 'Certifications', 'text', false),
      detail('food_freedom_only', 'Everything I sell under this type is a labeled Food Freedom product', 'boolean', false),
    ],
    sort: 6,
  },
  {
    key: 'prepared_food',
    label: 'Prepared and ready-to-eat food',
    category_keys: ['specialty_food'],
    examples: 'hot meals, sandwiches, coffee drinks, ice cream, food truck fare',
    permit_rule:
      'Prepared and TCS foods require an Arkansas Department of Health permit (Retail Food Establishment or mobile unit). Upload it or tell us you will provide it before your first market.',
    permit_upload: 'required',
    prohibited: '',
    practice_checklist: [],
    details: [
      detail('permit_number', 'Permit number', 'text', false),
      detail('mobile_unit', 'Sold from a food truck or trailer', 'boolean', false),
    ],
    sort: 7,
  },
  {
    key: 'non_food',
    label: 'Non-food, food-adjacent and craft items',
    category_keys: ['food_adjacent', 'crafts'],
    examples: 'soap, candles, woodwork, pottery, fabric crafts, jewelry, natural skincare',
    permit_rule:
      'No permit is required. Herbal, skincare and cleaning products may carry no unapproved health claims and must comply with FDA/FTC guidance.',
    permit_upload: 'none',
    prohibited: '',
    practice_checklist: ['handmade_in_arkansas', 'natural_ingredients', 'no_health_claims'].map(practice),
    details: [],
    sort: 8,
  },
  {
    key: 'education',
    label: 'Education and demonstration',
    category_keys: ['farmers_ranchers', 'specialty_food', 'food_adjacent'],
    examples: 'cooking demonstrations, gardening classes, farm education',
    permit_rule: 'No permit is required.',
    permit_upload: 'none',
    prohibited: '',
    practice_checklist: [],
    details: [],
    sort: 9,
  },
];

export function marketFees(market: Pick<FarmersMarket, 'fees'>): MarketFees {
  return { ...DEFAULT_FEES, ...(market.fees ?? {}) };
}

export function marketPaymentLinks(market: Pick<FarmersMarket, 'payment_links'>): MarketPaymentLinks {
  return { ...DEFAULT_PAYMENT_LINKS, ...(market.payment_links ?? {}) };
}

export function marketLegal(market: Pick<FarmersMarket, 'legal'>): MarketLegal {
  return { ...DEFAULT_LEGAL, ...(market.legal ?? {}) };
}

export function marketCategories(market: Pick<FarmersMarket, 'categories'>): MarketCategory[] {
  const list = market.categories && market.categories.length > 0 ? market.categories : DEFAULT_CATEGORIES;
  return [...list].sort((a, b) => a.sort - b.sort);
}

export function marketProductTypes(market: Pick<FarmersMarket, 'product_types'>): ProductTypeConfig[] {
  const list = market.product_types && market.product_types.length > 0 ? market.product_types : DEFAULT_PRODUCT_TYPES;
  return [...list].sort((a, b) => a.sort - b.sort);
}

/**
 * True iff the market has set a season label and today (market-local) falls
 * inside `[application_open, application_close]` (a null end is open-ended).
 */
export function applicationsOpen(market: Pick<FarmersMarket, 'season' | 'timezone'>, now: Date): boolean {
  const s = market.season;
  if (!s || !s.label) return false;
  const today = utcToLocalDate(now, market.timezone || 'UTC');
  if (s.application_open && today < s.application_open) return false;
  if (s.application_close && today > s.application_close) return false;
  return true;
}

/**
 * When a text that STAFF trigger for this market (an invitation to re-apply,
 * an acceptance, an agreement link) may next go out: null when the market is
 * outside its quiet hours right now, else the instant the quiet window ends
 * (market-local, `src/utils/quiet-hours.ts`). The engine defers its own texts
 * the same way; a staff action cannot be deferred, so the caller sends the
 * email, skips the text and says so (Phase 4 fix X5). A market document with
 * no (or an unreadable) `quiet_hours` falls back to DEFAULT_QUIET_HOURS, as
 * the engine does.
 */
export function quietUntil(market: Pick<FarmersMarket, 'quiet_hours' | 'timezone'>, now: Date): Date | null {
  const tz = market.timezone || 'UTC';
  let next: Date;
  try {
    next = nextAllowedInstant(now, market.quiet_hours ?? DEFAULT_QUIET_HOURS, tz);
  } catch {
    next = nextAllowedInstant(now, DEFAULT_QUIET_HOURS, tz);
  }
  return next.getTime() > now.getTime() ? next : null;
}
