import { z } from 'zod';
import { DAYS_OF_WEEK, isValidTimeZone, parseDate } from '../utils/tz.js';
import type { DayOfWeek } from '../utils/tz.js';

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

export const createMarketSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
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

export const updateMarketSchema = z.object({
  name: z.string().min(1).optional(),
  location: z.object({ name: z.string().min(1), address: z.string().optional().default('') }).optional(),
  timezone: timezoneString.optional(),
  workflow: workflowSchema.partial().optional(),
  quiet_hours: quietHoursSchema.optional(),
  website: websiteSchema.optional(),
  mailchimp: mailchimpSchema.optional(),
  active: z.boolean().optional(),
});

export type CreateMarketInput = z.infer<typeof createMarketSchema>;
export type UpdateMarketInput = z.infer<typeof updateMarketSchema>;
