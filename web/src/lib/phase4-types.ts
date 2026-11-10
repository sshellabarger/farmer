/**
 * Phase 4 shapes that cross the API (contract §2, §3): the public application
 * config and submission, uploads, prefill, the rules and agreement pages, the
 * stored application document, booths and assignments. Timestamps arrive as
 * ISO strings (the API's preSerialization hook converts them).
 *
 * SHARED VERBATIM: executor C1 owns this file; executor C2 copies it
 * byte-for-byte. Do not reformat or extend it here — Phase 4 additions to the
 * existing Phase 2/3 interfaces (Market, Membership, MarketDateStatusView)
 * live in `types.ts`, which C2 owns.
 */

/* ── Market configuration (farmers_markets additions) ── */

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
  /** Which of the four categories this type may be listed under. */
  category_keys: string[];
  examples: string;
  /** The §7 permit rule shown inline, plain text. */
  permit_rule: string;
  permit_upload: PermitUploadRule;
  /** Prohibited items shown under the type, plain text ('' when none). */
  prohibited: string;
  practice_checklist: PracticeOption[];
  details: ProductDetailField[];
  sort: number;
}

export type BoothKind = 'stall' | 'food_truck';

/** A booth as the public application sees it. */
export interface StallPublic {
  id: string;
  label: string;
  row: string;
  order: number;
  kind: BoothKind;
  power: boolean;
  size: string;
  /** A current-season vendor already names it as their usual booth. */
  usually_taken: boolean;
}

export interface OptionItem {
  key: string;
  label: string;
}

export interface SeasonSummary {
  start: string | null;
  end: string | null;
  market_count: number;
  days_of_week: string[];
  start_time: string | null;
  end_time: string | null;
}

/** GET /api/applications/config?market= */
export interface ApplicationConfig {
  market: { id: string; name: string; location_name: string; location_address: string; timezone: string; booth_map_url: string | null };
  season: MarketSeason & SeasonSummary & { open_now: boolean };
  fees: MarketFees;
  payment_links: MarketPaymentLinks;
  legal: Omit<MarketLegal, 'rules_markdown' | 'hold_harmless_markdown'> & { has_rules_text: boolean };
  categories: MarketCategory[];
  product_types: ProductTypeConfig[];
  stalls: StallPublic[];
  payment_methods: OptionItem[];
  frequencies: OptionItem[];
  months: OptionItem[];
  agricultural_practices: OptionItem[];
  limits: { upload_max_bytes: number; upload_mimes: string[]; stall_preference_max: number };
}

/* ── Submission ── */

export type AgriculturalPractice = 'certified_organic' | 'certified_naturally_grown' | 'no_chemicals' | 'conventional' | 'not_applicable';
export type DailyFrequency = 'every_other_week' | 'monthly' | 'occasional';
export type PermitStatus = 'uploaded' | 'will_provide' | 'not_required' | 'food_freedom';
export type InsuranceAnswer = 'have' | 'none' | 'need_guidance';
export type BoothRate = 'seasonal' | 'daily';

export interface ApplicationAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface ApplicationContact {
  name: string;
  business_name: string;
  email: string;
  mobile: string;
  website: string;
  social: string;
  address: ApplicationAddress;
  description: string;
  years_in_operation: number | null;
  outlets: string;
  agricultural_practices: AgriculturalPractice;
  additional_info: string;
}

export interface ProductEntry {
  type: string;
  items: string[];
  practices: string[];
  description: string;
  details: Record<string, string | number | boolean>;
}

export interface PermitEntry {
  status: PermitStatus;
  upload_id: string | null;
  note: string;
}

export interface BoothRequest {
  rate: BoothRate;
  frequency: DailyFrequency | null;
  months: string[];
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  stall_preference: string[];
  food_truck: boolean;
}

export interface InsuranceAnswerInput {
  status: InsuranceAnswer;
  certificate_upload_id: string | null;
  carrier: string;
  expires_on: string | null; // YYYY-MM-DD
}

export interface AcknowledgementsInput {
  rules: boolean;
  weekly_report: boolean;
  farm_visits: boolean;
  marketing: boolean;
  products_listed_only: boolean;
  own_booth_only: boolean;
}

/** POST /api/applications body. */
export interface ApplicationSubmitInput {
  market_id: string;
  draft_id: string;
  prefill_token: string | null;
  contact: ApplicationContact;
  sms_consent: boolean;
  sms_consent_version: string;
  returning: { is_returning: boolean; last_stall: string | null };
  categories: string[];
  products: ProductEntry[];
  permits: Record<string, PermitEntry>;
  booth: BoothRequest;
  payment_methods: string[];
  insurance: InsuranceAnswerInput;
  acknowledgements: AcknowledgementsInput;
  rules_version: string;
  signature_name: string;
}

export interface SeasonTotal {
  rate: BoothRate;
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

export interface ApplicationSubmitResult {
  id: string;
  status: 'new';
  fee: { amount: number; currency: string; url: string | null };
  season_total: SeasonTotal;
}

/** POST /api/applications/uploads result. */
export interface UploadResult {
  upload_id: string;
  kind: 'permit' | 'insurance' | 'logo';
  bytes: number;
  mime: string;
  original_name: string;
}

/** GET /api/applications/prefill/:token */
export interface PrefillView {
  market_id: string;
  season: string;
  expires_at: string;
  producer: {
    business_name: string;
    contact_name: string;
    email: string | null;
    phone: string | null;
    website: string;
    social: string;
    address: ApplicationAddress | null;
    description_public: string;
    years_in_operation: number | null;
    outlets: string;
    agricultural_practices: AgriculturalPractice | null;
    categories: string[];
    products: ProductEntry[];
    payment_methods: string[];
  };
  last_membership: {
    season: string;
    fee_plan: BoothRate;
    spaces: 1 | 2;
    electric: boolean;
    pay_in_full: boolean;
    usual_booth_label: string | null;
  } | null;
}

/** GET /api/markets/:id/rules */
export interface RulesView {
  market_id: string;
  market_name: string;
  season: string;
  rules_version: string;
  rules_markdown: string;
  rules_url: string | null;
  updated_at: string;
}

/** GET /api/agreements/:token */
export interface AgreementView {
  status: 'open' | 'signed' | 'expired';
  market_name: string;
  season: string;
  business_name: string;
  contact_name: string;
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  /** False until the market publishes its Hold Harmless text (or once signed). */
  can_sign: boolean;
  insurance_help_url: string | null;
  signed: { name: string; signed_at: string } | null;
  expires_at: string;
}

export interface AgreementSignInput {
  signature_name: string;
  agree: boolean;
}

/* ── Stored application (admin) ── */

export type ApplicationStatus4 = 'new' | 'under_review' | 'approved' | 'declined' | 'withdrawn';
export type FeeStatus = 'unpaid' | 'paid' | 'waived';

export interface ApplicationDoc {
  id: string;
  market_id: string;
  season: string;
  status: ApplicationStatus4;
  draft_id: string;
  prefill_token: string | null;
  prefill_producer_id: string | null;
  contact: ApplicationContact;
  sms_consent: { status: 'opted_in'; at: string; text_version: string; ip?: string };
  returning: { is_returning: boolean; last_stall: string | null };
  categories: string[];
  products: (ProductEntry & { category: string })[];
  permits: Record<string, PermitEntry>;
  booth: BoothRequest;
  season_total: SeasonTotal;
  payment_methods: string[];
  insurance: InsuranceAnswerInput;
  acknowledgements: {
    rules: { version: string; at: string };
    weekly_report: boolean;
    farm_visits: boolean;
    marketing: boolean;
    products_listed_only: boolean;
    own_booth_only: boolean;
  };
  signature: { name: string; signed_at: string; ip?: string };
  fee: { status: FeeStatus; amount: number; currency: string; paid_at: string | null; marked_by: string | null; reference: string | null };
  review: { notes: string; trial_period: boolean; decline_reason: string | null; reviewed_by: string | null; reviewed_at: string | null };
  producer_id: string | null;
  membership_id: string | null;
  upload_ids: string[];
  submitted_at: string;
  source: 'web';
  created_at: string;
  updated_at: string;
}

/** A row of GET /api/applications (the queue). */
export interface ApplicationListItem {
  id: string;
  market_id: string;
  season: string;
  status: ApplicationStatus4;
  business_name: string;
  contact_name: string;
  email: string;
  mobile: string;
  categories: string[];
  product_types: string[];
  rate: BoothRate;
  spaces: 1 | 2;
  electric: boolean;
  is_returning: boolean;
  fee_status: FeeStatus;
  insurance_status: InsuranceAnswer;
  permits_pending: number;
  submitted_at: string;
  producer_id: string | null;
}

export interface UploadMeta {
  id: string;
  kind: 'permit' | 'insurance' | 'logo';
  mime: string;
  bytes: number;
  original_name: string;
  uploaded_at: string;
  application_id: string | null;
}

/* ── Booths and assignments ── */

export interface BoothDoc {
  id: string;
  market_id: string;
  label: string;
  row: string;
  order: number;
  kind: BoothKind;
  power: boolean;
  size: string;
  notes: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type AssignmentSource = 'usual' | 'suggested' | 'manual';

/* ── The assignments view (Phase 4 fix, booth side): cycles, hand-added vendors, per-vendor booth texts ── */

/**
 * `next`: a date's check-ins assign the NEXT market (every date has this cycle).
 * `opener`: the first market date of the season assigns ITSELF, starting from
 * the vendors on the seasonal plan; staff draft it by hand.
 */
export type AssignmentCycleMode = 'next' | 'opener';

/** Why approved booth texts are held back: two vendors on one booth, a cancelled target date still ahead, or a target whose start time has passed (final; see `target_cancelled` for which). */
export type BoothTextsBlocked = 'conflict' | 'cancelled' | 'started';

/**
 * Per vendor: `none` (not approved), `pending` (the engine will send it),
 * `sent`, `failed` (the provider refused; staff resend), `blocked` (held, see
 * `booth_texts_blocked`), `excluded` (cannot be texted, see `reason`),
 * `skipped` (could not be texted when the texts went out and can be now).
 */
export type BoothTextStatus = 'none' | 'pending' | 'sent' | 'failed' | 'blocked' | 'excluded' | 'skipped';

/** `not_placed`: a suitable booth is free (nothing drafted yet, or staff took the booth away). */
export type BoothUnassignedReason = 'no_power_stall' | 'no_pair' | 'full' | 'no_food_truck_slot' | 'not_placed';

export interface BoothTextRow {
  producer_id: string;
  business_name: string;
  /** `release`: the vendor was told a booth and has been taken off the date. */
  type: 'assignment' | 'release';
  booth_labels: string[];
  status: BoothTextStatus;
  reason: string | null;
  last_message: { id: string; status: string; created_at: string } | null;
  can_resend: boolean;
}

/** One cycle's assignments as GET /api/market-dates/:id/status returns them (`assignments`, `opener_assignments`). */
export interface BoothAssignmentsView {
  cycle: AssignmentCycleMode;
  /** False while a `next` cycle cannot be drafted yet (its own market has not ended); always true for an opener. */
  draft_open: boolean;
  target_date: { id: string; date: string; date_label: string; start_at: string } | null;
  target_cancelled: boolean;
  target_started: boolean;
  season: string;
  drafted_at: string | null;
  assignments_draft_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  booth_texts_sent_at: string | null;
  /** When the owed booth texts go out; null when none are owed or they are held. */
  booth_texts_due_at: string | null;
  /** Quiet hours end at or after the market's start: the owed texts will never be sent. */
  booth_texts_too_late: boolean;
  booth_texts_blocked: BoothTextsBlocked | null;
  drafts_skipped: 'no_next_date' | 'no_booths' | 'no_attendees' | null;
  booths: {
    booth: BoothDoc;
    assignment: { id: string; producer_id: string; business_name: string; source: AssignmentSource; assigned_by: string; assigned_at: string } | null;
  }[];
  attending: {
    producer_id: string;
    business_name: string;
    spaces: 1 | 2;
    electric: boolean;
    booth_kind: BoothKind;
    fee_plan: 'seasonal' | 'daily';
    usual_booth_id: string | null;
    booth_ids: string[];
    /** Not on the cycle's own list: staff placed this vendor by hand. */
    added_by_staff: boolean;
  }[];
  /** Current-season vendors who are not on the list and may be placed by hand. */
  can_add: {
    producer_id: string;
    business_name: string;
    spaces: 1 | 2;
    electric: boolean;
    booth_kind: BoothKind;
    fee_plan: 'seasonal' | 'daily';
    reason: 'not_attending' | 'no_answer' | 'daily_plan';
  }[];
  unassigned: { producer_id: string; business_name: string; reason: BoothUnassignedReason }[];
  warnings: { producer_id: string; business_name: string; reason: 'power_mismatch'; booth_ids: string[] }[];
  not_attending: { producer_id: string; business_name: string }[];
  no_answer: { producer_id: string; business_name: string }[];
  summary: { assigned: number; unassigned: number; booths_total: number; booths_free: number; conflicts: number };
  conflict_booth_ids: string[];
  /** Every vendor on each double-booked booth (the grid shows only one of them). */
  conflicts: { booth_id: string; booth_label: string; producers: { producer_id: string; business_name: string }[] }[];
  texts: BoothTextRow[];
  text_counts: Record<Exclude<BoothTextStatus, 'none'>, number>;
  messages: { id: string; producer_id: string | null; to: string; status: string; created_at: string; type: 'assignment' | 'release'; booth_labels: string[] }[];
}

/** What the status route adds for booth assignments (Phase 4 fix). */
export interface MarketDateBoothViews {
  assignments?: BoothAssignmentsView;
  /** The season opener's own cycle; null on every other date. */
  opener_assignments?: BoothAssignmentsView | null;
  is_season_opener?: boolean;
}

export interface BoothDraftResult {
  skipped: 'no_next_date' | 'no_booths' | 'no_attendees' | null;
  target_date_id: string | null;
  vendors_placed: number;
  vendors_unassigned: number;
  rows_written: number;
  superseded: number;
  warnings: { producer_id: string; reason: 'power_mismatch'; booth_ids: string[] }[];
}

export interface BoothApproveTexts {
  attempted: boolean;
  sent: number;
  failed: number;
  excluded: number;
  deferred_until: string | null;
}

export interface BoothAssignmentsUpdateResult {
  assignments: BoothAssignmentsView;
  /** `approved`: the assignments were already approved, so each vendor whose booths changed is texted the change. */
  warning?: string;
}

export interface BoothTextResendResult {
  sms: { status: 'sent' | 'simulated' | 'failed'; error?: string };
  type: 'assignment' | 'release';
  message_id: string | null;
  assignments: BoothAssignmentsView;
}

export interface BoothAssignmentDoc {
  id: string;
  market_id: string;
  market_date_id: string;
  source_date_id: string;
  booth_id: string;
  producer_id: string;
  source: AssignmentSource;
  assigned_by: string;
  assigned_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
}
