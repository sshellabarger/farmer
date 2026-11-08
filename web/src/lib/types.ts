/**
 * Web mirrors of the Phase 2 Firestore documents (contract §2) plus the
 * request/response shapes the API helpers in `api.ts` use. Timestamps arrive
 * as ISO strings (the API's preSerialization hook converts them).
 */

import type {
  AgriculturalPractice,
  ApplicationAddress,
  AssignmentSource,
  BoothDoc,
  BoothKind,
  MarketCategory,
  MarketFees,
  MarketLegal,
  MarketPaymentLinks,
  MarketSeason,
  ProductEntry,
  ProductTypeConfig,
} from './phase4-types';

export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/* ── Markets ── */

export interface ScheduleVersion {
  id: string;
  effective_from: string; // YYYY-MM-DD
  season_start: string;
  season_end: string;
  days_of_week: DayOfWeek[];
  start_time: string; // HH:mm
  end_time: string;
  created_at: string;
  created_by: string;
}

export interface ScheduleVersionInput {
  effective_from: string;
  season_start: string;
  season_end: string;
  days_of_week: DayOfWeek[];
  start_time: string;
  end_time: string;
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

export interface MarketLocation {
  name: string;
  address: string;
}

export interface Market {
  id: string;
  name: string;
  slug: string;
  location: MarketLocation;
  timezone: string;
  schedule: {
    versions: ScheduleVersion[];
    skipped_dates: SkippedDate[];
    special_dates: SpecialDate[];
  };
  workflow: Workflow;
  quiet_hours: QuietHours;
  website?: { duda_site_id: string; thisweek_page_id: string; vendor_collection_id: string } | null;
  mailchimp?: { audience_id: string; template_id: string } | null;
  // Phase 4 (contract 2.1) - absent on markets written before Phase 4; the API applies defaults on read.
  season?: MarketSeason | null;
  fees?: MarketFees;
  payment_links?: MarketPaymentLinks;
  legal?: MarketLegal;
  booth_map_url?: string | null;
  categories?: MarketCategory[];
  product_types?: ProductTypeConfig[];
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PublicMarket {
  id: string;
  name: string;
  location: MarketLocation;
  timezone: string;
  active: boolean;
  next: { date: string; start_time: string; end_time: string } | null;
}

export interface CreateMarketInput {
  slug: string;
  name: string;
  location: { name: string; address?: string };
  timezone?: string;
  schedule: {
    versions: [ScheduleVersionInput];
    skipped_dates?: SkippedDate[];
    special_dates?: SpecialDate[];
  };
  workflow?: Workflow;
  quiet_hours?: QuietHours;
  website?: Market['website'];
  mailchimp?: Market['mailchimp'];
  active?: boolean;
}

export interface UpdateMarketInput {
  name: string;
  location: MarketLocation;
  timezone: string;
  workflow: Workflow;
  quiet_hours: QuietHours;
  website: Market['website'];
  mailchimp: Market['mailchimp'];
  active: boolean;
  // Phase 4 (contract 2.1)
  season: MarketSeason | null;
  fees: MarketFees;
  payment_links: MarketPaymentLinks;
  legal: MarketLegal;
  booth_map_url: string | null;
  categories: MarketCategory[];
  product_types: ProductTypeConfig[];
}

export type MarketDateStatus = 'collecting' | 'lineup_final' | 'published' | 'cancelled';

export interface ExtraQuestion {
  key: string;
  prompt: string;
  type: 'text' | 'choice' | 'yes_no';
  options?: string[];
}

/** Phase 3 contract §2.2: one reminder offset's send outcome. */
export interface ReminderSent {
  offset_min: number;
  sent_at: string;
  recipients: number;
  failed: number;
  skipped: 'superseded' | null;
}

export interface MarketDateActions {
  checkin_sent_at: string | null;
  reminders_sent: ReminderSent[];
  deadline_at: string;
  deadline_processed_at: string | null;
  drafts_generated_at: string | null;
  approved_at: string | null;
  booth_texts_sent_at: string | null;
  // Phase 3 — absent on dates written before the workflow shipped.
  checkin_recipients?: number;
  checkin_failed?: number;
  summary_sent_at?: string | null;
  summary_skipped?: 'no_recipients' | 'notify_false' | null;
  claims?: Record<string, string>;
  // Phase 4 (contract 2.9)
  assignments_draft_at?: string | null;
  assignments_target_date_id?: string | null;
  drafts_skipped?: DraftSkipReason | null;
  approved_by?: string | null;
  booth_summary?: { assigned: number; unassigned: number; booths_total: number; booths_free: number } | null;
  booth_text_recipients?: number;
  booth_text_failed?: number;
  booth_text_excluded?: number;
}

export type DraftSkipReason = 'no_next_date' | 'no_booths' | 'no_attendees';

export interface MarketDate {
  id: string;
  market_id: string;
  date: string;
  start_time: string;
  end_time: string;
  start_at: string;
  end_at: string;
  status: MarketDateStatus;
  schedule_version: string;
  special: boolean;
  note: string;
  actions: MarketDateActions;
  extra_questions: ExtraQuestion[];
  sponsor_id: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  generated_at: string;
  source: 'generator' | 'import';
  created_at: string;
  updated_at: string;
  // Phase 3 — set once the deadline has been processed.
  non_responders?: string[];
  spot_not_held?: string[];
  deadline_recipient_count?: number;
  deadline_responded_count?: number;
}

export interface UpdateMarketDateInput {
  status?: 'cancelled' | 'collecting';
  cancellation_reason?: string;
  note?: string;
  extra_questions?: ExtraQuestion[];
  sponsor_id?: string | null;
}

export interface GenerateResult {
  created: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  skipped: number;
  frozen: number;
  from: string;
  to: string;
}

/* ── Producers / memberships ── */

export type SmsConsentStatus = 'unknown' | 'opted_in' | 'opted_out';

export interface Producer {
  id: string;
  business_name: string;
  name_key: string;
  contact_name: string;
  phone: string | null;
  email: string | null;
  emails: string[];
  aliases: string[];
  /** Phase 2 stored plain strings; Phase 4 stores structured entries. Readers accept both. */
  products: (string | ProductEntry)[];
  category: string;
  documents: { name: string; url: string; uploaded_at: string }[];
  sms_consent: { status: SmsConsentStatus; at: string | null; source: string };
  sms_opt_out_at: string | null;
  user_id: string | null;
  legacy_farm_id: string | null;
  /** Admin-only; absent in responses to market managers. */
  notes?: string;
  source: 'application' | 'import' | 'admin';
  active: boolean;
  // Phase 4 (contract 2.3) - optional on read.
  website?: string;
  social?: string;
  address?: ApplicationAddress | null;
  description_public?: string;
  years_in_operation?: number | null;
  outlets?: string;
  agricultural_practices?: AgriculturalPractice | null;
  categories?: string[];
  payment_methods?: string[];
  logo_upload_id?: string | null;
  last_application_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type MembershipStatus = 'applied' | 'under_review' | 'approved' | 'active' | 'inactive';
/** Phase 4 vocabulary (D31). The API maps the Phase 2 values on read: weekly -> daily, season/both -> seasonal. */
export type FeePlan = 'seasonal' | 'daily';

/** Contract §4.3: allowed status transitions. */
export const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  applied: ['under_review', 'approved', 'inactive'],
  under_review: ['applied', 'approved', 'inactive'],
  approved: ['active', 'inactive'],
  active: ['inactive'],
  inactive: ['active', 'approved'],
};

export interface MembershipHistoryEntry {
  from: string | null;
  to: string;
  at: string;
  by: string;
  note: string | null;
}

export interface Membership {
  id: string;
  producer_id: string;
  market_id: string;
  status: MembershipStatus;
  usual_booth_id: string | null;
  fee_plan: FeePlan;
  approved_at: string | null;
  approved_by: string | null;
  history: MembershipHistoryEntry[];
  source: 'application' | 'import' | 'admin';
  // Phase 4 (contract 2.6) - one membership per producer, market and season (D33).
  season: string;
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  booth_kind: BoothKind;
  trial_period: boolean;
  insurance: MembershipInsurance;
  hold_harmless: { signed_at: string; name: string; ip?: string; version: string; token?: string } | null;
  approved_items: string[];
  item_requests: ItemRequest[];
  application_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InsuranceStatus = 'missing' | 'on_file' | 'expired' | 'waived';

export interface MembershipInsurance {
  status: InsuranceStatus;
  expires_at: string | null;
  upload_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  note: string;
}

export interface ItemRequest {
  id: string;
  items: string[];
  note: string;
  requested_at: string;
  source: 'application' | 'admin' | 'producer';
  status: 'pending' | 'approved' | 'declined';
  decided_by: string | null;
  decided_at: string | null;
}

export interface MembershipWithProducer extends Membership {
  producer: { id: string; business_name: string };
}

export interface ProducerListItem extends Producer {
  memberships: { market_id: string; status: MembershipStatus; season?: string; fee_plan?: FeePlan; spaces?: 1 | 2; electric?: boolean }[];
}

export interface CreateProducerInput {
  business_name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  emails?: string[];
  aliases?: string[];
  products?: string[];
  category?: string;
  notes?: string;
  memberships?: { market_id: string; status?: MembershipStatus; fee_plan?: FeePlan }[];
}

export interface UpdateProducerInput {
  business_name: string;
  contact_name: string;
  phone: string | null;
  email: string | null;
  emails: string[];
  aliases: string[];
  products: string[];
  category: string;
  notes: string;
  active: boolean;
  // Phase 4 (contract 2.3)
  website: string;
  social: string;
  address: ApplicationAddress | null;
  description_public: string;
}

/* ── Applications ── */

export type ApplicationStatus = 'new' | 'under_review' | 'approved' | 'declined';

export type ApplicationExtra = Record<string, string | boolean | string[]>;

export interface Application {
  id: string;
  email: string;
  business_name: string;
  contact_person: string;
  phone: string;
  markets_applied: string[];
  extra: ApplicationExtra;
  status: ApplicationStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_note: string | null;
  producer_id: string | null;
  membership_ids: string[];
  submitted_at: string;
  source: 'web';
  created_at: string;
  updated_at: string;
}

export interface ApplicationInput {
  email: string;
  business_name: string;
  contact_person: string;
  phone: string;
  markets_applied: string[];
  extra: ApplicationExtra;
}

/* ── Check-ins ── */

export type CheckinSource = 'form' | 'import' | 'sms';

export interface Checkin {
  id: string;
  producer_id: string;
  market_id: string;
  market_date_id: string;
  submitted_at: string;
  source: CheckinSource;
  token_id: string | null;
  /** Admin-only; absent for market managers. */
  estimated_sales?: { value: number | null; raw: string; kind: 'exact' | 'range' | 'none' };
  transactions_estimate: { value: number | null; raw: string };
  sold_out_items: string[];
  sold_out_raw: string;
  unsold_items: string[];
  unsold_raw: string;
  attending_next: boolean | null;
  attending_next_raw: string;
  bringing_next: string[];
  bringing_next_raw: string;
  feedback: string;
  extra_answers: { weekly_question?: string; winter_interest?: 'yes' | 'maybe' | 'no'; [key: string]: unknown };
  flags: string[];
  /** Admin-only; absent for market managers. */
  raw_import?: { row_hash: string; source: string; cells: string[]; timestamp_raw: string; duplicates: number } | null;
  /** Phase 3 — present on checkins written by the form or by text. */
  submissions?: number;
  partial?: boolean;
  created_at: string;
  updated_at: string;
}

/* ── Staff users, audit, dashboard ── */

export type StaffRole = 'admin' | 'market_manager';

export interface StaffUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  assigned_market_ids: string[];
  active: boolean;
  sms_opt_out_at: string | null;
  invited_at: string | null;
  created_at: string;
}

export interface SmsOutcome {
  status: 'sent' | 'simulated' | 'failed';
  error?: string;
}

export interface AuditEntry {
  id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target: { collection: string; id: string };
  before: unknown;
  after: unknown;
  note: string | null;
  at: string;
}

export interface DashboardCard {
  market: { id: string; name: string; timezone: string; active: boolean };
  /** Phase 4: the market's current season label. */
  season?: string;
  next_date: MarketDate | null;
  collecting_date: MarketDate | null;
  progress: { active_memberships: number; checkins: number; percent: number } | null;
  upcoming_count: number;
}

export interface Providers {
  sms_provider: string;
  email_provider: string;
  allow_real_sends: boolean;
  node_env: string;
  real_sends_possible: boolean;
}

/* ── Phase 3: check-in workflow (contract §6.3) ── */

/** Contract §4.1 `CheckinFormValues`: the producer-facing form's field values. */
export interface CheckinFormValues {
  attending_next: boolean | null;
  bringing_next: string;
  sold_out: string;
  unsold: string;
  estimated_sales: string;
  transactions_estimate: string;
  feedback: string;
  extra_answers: Record<string, string | boolean>;
}

/** Contract §4.1 `checkinSubmitSchema`: the POST /api/checkin/:token body. */
export interface CheckinSubmitInput {
  attending_next: boolean;
  bringing_next: string;
  sold_out: string;
  unsold: string;
  estimated_sales: string;
  transactions_estimate: string;
  feedback: string;
  extra_answers: Record<string, string | boolean>;
}

/** Contract §4.1: the GET /api/checkin/:token 200 response. */
export interface CheckinTokenView {
  producer_name: string;
  contact_name: string;
  market_id: string;
  market_name: string;
  market_date_id: string;
  date: string;
  date_label: string;
  start_time: string;
  end_time: string;
  deadline_at: string;
  deadline_label: string;
  past_deadline: boolean;
  expires_at: string;
  questions: { extra_questions: ExtraQuestion[] };
  existing: (CheckinFormValues & { submitted_at: string; source: CheckinSource; partial: boolean }) | null;
}

/** Contract §4.2 `DateSchedule`, with instants serialised as ISO strings. */
export interface DateScheduleView {
  checkin_at: string;
  checkin_effective_at: string;
  reminders: { offset_min: number; at: string; effective_at: string; reachable: boolean }[];
  deadline_at: string;
  summary_effective_at: string;
}

/**
 * Contract §4.2 `MarketDateStatus` (the GET /api/market-dates/:id/status
 * response). Renamed to `MarketDateStatusView` here: the Phase 2 contract
 * already exports `MarketDateStatus` as the date-lifecycle string union
 * (`'collecting' | 'lineup_final' | ...`), so the contract's own name would
 * collide with it in this module (deviation — see docs/phase3/notes-C.md).
 */
export interface MarketDateStatusView {
  date: MarketDate;
  market: { id: string; name: string; timezone: string; workflow: Workflow; quiet_hours: QuietHours };
  schedule: DateScheduleView;
  next_due: { action: 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts' | 'booth_texts' | 'none'; at: string | null; offset_min?: number };
  in_window: boolean;
  recipients: {
    producer_id: string;
    business_name: string;
    contact_name: string;
    phone: string;
    responded: boolean;
    late: boolean;
    checkin: { submitted_at: string; source: CheckinSource; partial: boolean; attending_next: boolean | null } | null;
    link_sent_at: string | null;
    link_sends: number;
    reminders_sent: number;
    last_status: 'sent' | 'simulated' | 'failed' | 'queued' | null;
    token_expires_at: string | null;
  }[];
  excluded: { producer_id: string; business_name: string; reason: 'no_phone' | 'invalid_phone' | 'opted_out' | 'inactive_producer' }[];
  counts: { recipients: number; responded: number; non_responders: number; excluded: number };
  messages: { id: string; kind: string; to: string; producer_id: string | null; user_id: string | null; status: string; segments: number; created_at: string }[];
  /** Phase 4 (contract 3.4). Absent from servers that predate booth assignment. */
  assignments?: AssignmentsView;
}

/** Contract §4.2 `POST /:id/close` result shape. */
export interface CloseResult {
  /** True when the request processed the deadline (409 otherwise). */
  processed: boolean;
  recipients: number;
  responded: number;
  non_responders: string[];
  summary: 'sent' | 'skipped_no_recipients' | 'skipped_notify_false' | 'failed' | 'sent_by_engine' | 'already_processed' | 'in_progress';
}

/* ── Phase 4: applications, invites, insurance, booths (contract 3, 4.2) ── */

/** PATCH /api/applications/:id body (contract 3.2). */
export type ApplicationAction =
  | { action: 'review' }
  | { action: 'withdraw' }
  | { action: 'note'; notes: string }
  | { action: 'fee'; status: 'paid' | 'waived' | 'unpaid'; reference?: string }
  | { action: 'decline'; reason: string }
  | {
      action: 'approve';
      fee_plan: FeePlan;
      spaces: 1 | 2;
      electric: boolean;
      pay_in_full: boolean;
      booth_kind: BoothKind;
      usual_booth_id: string | null;
      trial_period: boolean;
      note: string;
      send: boolean;
    };

/** An `application_invites` document (contract 2.5). */
export interface ApplicationInvite {
  market_id: string;
  season: string;
  producer_id: string;
  token?: string;
  email: string | null;
  email_status: 'sent' | 'skipped_no_email' | 'failed' | 'simulated';
  phone: string | null;
  sms_status: 'sent' | 'simulated' | 'skipped_no_phone' | 'skipped_opted_out' | 'failed' | 'duplicate';
  message_id: string | null;
  sent_by: string;
  sent_at: string;
  resends: { at: string; by: string; token?: string; email_status: string; sms_status: string }[];
}

/** POST /api/markets/:id/invite-reapply result (contract 3.3). */
export interface InviteBatchResult {
  season: string;
  candidates: number;
  invited: number;
  skipped_already: number;
  skipped_applied: number;
  skipped_no_contact: number;
  results: { producer_id: string; business_name: string; email_status: string; sms_status: string }[];
}

/** PATCH /api/memberships/:id/insurance body (contract 3.4). */
export interface InsuranceUpdateInput {
  status: InsuranceStatus;
  expires_at: string | null;
  upload_id: string | null;
  note: string;
}

export interface BoothInput {
  label: string;
  row: string;
  order: number;
  kind?: BoothKind;
  power?: boolean;
  size?: string;
  notes?: string;
}

export interface BoothSeedInput {
  rows: { row: string; labels: string[] }[];
  food_truck?: { label: string; row: string; order: number } | null;
}

/** The assignments view of GET /api/market-dates/:id/status (contract 3.4), with instants as ISO strings. */
export interface AssignmentsView {
  target_date: { id: string; date: string; date_label: string } | null;
  season: string;
  drafted_at: string | null;
  assignments_draft_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  booth_texts_sent_at: string | null;
  booth_texts_due_at: string | null;
  drafts_skipped: DraftSkipReason | null;
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
    usual_booth_id: string | null;
    booth_ids: string[];
  }[];
  unassigned: { producer_id: string; business_name: string; reason: 'no_power_stall' | 'no_pair' | 'full' | 'no_food_truck_slot' }[];
  not_attending: { producer_id: string; business_name: string }[];
  no_answer: { producer_id: string; business_name: string }[];
  summary: { assigned: number; unassigned: number; booths_total: number; booths_free: number; conflicts: number };
  messages: { id: string; producer_id: string | null; to: string; status: string; created_at: string }[];
}
