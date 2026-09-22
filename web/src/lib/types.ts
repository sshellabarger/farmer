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

export interface MarketDateActions {
  checkin_sent_at: string | null;
  reminders_sent: string[];
  deadline_at: string;
  deadline_processed_at: string | null;
  drafts_generated_at: string | null;
  approved_at: string | null;
  booth_texts_sent_at: string | null;
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

export interface Checkin {
  id: string;
  producer_id: string;
  market_id: string;
  market_date_id: string;
  submitted_at: string;
  source: 'form' | 'import';
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
