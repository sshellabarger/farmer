/**
 * Web mirrors of the Phase 2 Firestore documents (contract §2) plus the
 * request/response shapes the API helpers in `api.ts` use. Timestamps arrive
 * as ISO strings (the API's preSerialization hook converts them).
 */

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
}

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
  products: string[];
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
  created_at: string;
  updated_at: string;
}

export type MembershipStatus = 'applied' | 'under_review' | 'approved' | 'active' | 'inactive';
export type FeePlan = 'weekly' | 'season' | 'both';

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
  created_at: string;
  updated_at: string;
}

export interface MembershipWithProducer extends Membership {
  producer: { id: string; business_name: string };
}

export interface ProducerListItem extends Producer {
  memberships: { market_id: string; status: MembershipStatus }[];
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
  next_due: { action: 'checkin' | 'reminder' | 'deadline' | 'summary' | 'none'; at: string | null; offset_min?: number };
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
}

/** Contract §4.2 `POST /:id/close` result shape. */
export interface CloseResult {
  recipients: number;
  responded: number;
  non_responders: string[];
  summary: 'sent' | 'skipped_no_recipients' | 'skipped_notify_false' | 'failed';
}
