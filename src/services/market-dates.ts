import type { Firestore } from 'firebase-admin/firestore';
import { addDays, eachDate, localToUtc, utcToLocalDate, weekdayOf } from '../utils/tz.js';
import type { FarmersMarket, ScheduleVersion } from './markets.js';
import type { MarketDateStatus } from '../types/schema.js';

/**
 * The market-date generator (Phase 2 contract §3). Idempotent: running the
 * same scope twice yields zero created/updated/cancelled the second time.
 */

export interface ExtraQuestion {
  key: string;
  prompt: string;
  type: 'text' | 'choice' | 'yes_no';
  options?: string[];
}

export interface MarketDateActions {
  checkin_sent_at: Date | null;
  reminders_sent: Date[];
  deadline_at: Date;
  deadline_processed_at: Date | null;
  drafts_generated_at: Date | null;
  approved_at: Date | null;
  booth_texts_sent_at: Date | null;
}

export interface MarketDateDoc {
  id: string;
  market_id: string;
  date: string;
  start_time: string;
  end_time: string;
  start_at: Date;
  end_at: Date;
  status: MarketDateStatus;
  schedule_version: string;
  special: boolean;
  note: string;
  actions: MarketDateActions;
  extra_questions: ExtraQuestion[];
  sponsor_id: string | null;
  cancellation_reason: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  generated_at: Date;
  source: 'generator' | 'import';
  created_at: Date;
  updated_at: Date;
}

export interface GenerateOptions {
  scope: 'window' | 'season';
  now?: Date;
  /** user id | 'scheduler' | 'import' */
  actor: string;
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

/** The window/season of dates a generation pass considers. */
export function computeWindow(market: FarmersMarket, scope: 'window' | 'season', now: Date): { from: string; to: string } {
  const today = utcToLocalDate(now, market.timezone);
  if (scope === 'window') {
    return { from: addDays(today, -7), to: addDays(today, 56) };
  }
  const versions = market.schedule.versions;
  let from = versions[0]!.season_start;
  let to = versions[0]!.season_end;
  for (const v of versions) {
    if (v.season_start < from) from = v.season_start;
    if (v.season_end > to) to = v.season_end;
  }
  for (const s of market.schedule.special_dates) {
    if (s.date < from) from = s.date;
    if (s.date > to) to = s.date;
  }
  return { from, to };
}

function actionTimestampSet(actions: MarketDateActions): boolean {
  return !!(
    actions.checkin_sent_at ||
    actions.deadline_processed_at ||
    actions.drafts_generated_at ||
    actions.approved_at ||
    actions.booth_texts_sent_at
  ) || actions.reminders_sent.length > 0;
}

/** A doc the generator must never silently rewrite. */
export function isDateDecided(doc: MarketDateDoc, now: Date): boolean {
  if (doc.status !== 'collecting') return true;
  if (actionTimestampSet(doc.actions)) return true;
  if (doc.end_at.getTime() < now.getTime()) return true;
  return false;
}

/** A generator-cancelled doc with no admin/workflow action yet, still in the future. */
function isRevivable(doc: MarketDateDoc, now: Date): boolean {
  if (doc.status !== 'cancelled' || doc.cancelled_by !== 'generator') return false;
  if (actionTimestampSet(doc.actions)) return false;
  return doc.end_at.getTime() >= now.getTime();
}

function applicableVersion(market: FarmersMarket, date: string): ScheduleVersion | undefined {
  const versions = [...market.schedule.versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let applicable: ScheduleVersion | undefined;
  for (const v of versions) {
    if (v.effective_from <= date) applicable = v;
  }
  return applicable;
}

interface ExpectedDay {
  start_time: string;
  end_time: string;
  schedule_version: string;
  special: boolean;
  note: string;
}

function computeExpected(market: FarmersMarket, date: string): ExpectedDay | null {
  const special = market.schedule.special_dates.find((s) => s.date === date);
  if (special) {
    return { start_time: special.start_time, end_time: special.end_time, schedule_version: 'special', special: true, note: special.note };
  }
  const skipped = market.schedule.skipped_dates.find((s) => s.date === date);
  if (skipped) return null;

  const version = applicableVersion(market, date);
  if (!version) return null;
  if (date < version.season_start || date > version.season_end) return null;
  if (!version.days_of_week.includes(weekdayOf(date))) return null;
  return { start_time: version.start_time, end_time: version.end_time, schedule_version: version.id, special: false, note: '' };
}

function toDoc(id: string, data: Record<string, unknown>): MarketDateDoc {
  return { id, ...data } as MarketDateDoc;
}

export async function generateMarketDates(db: Firestore, market: FarmersMarket, opts: GenerateOptions): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const { from, to } = computeWindow(market, opts.scope, now);
  const dates = eachDate(from, to);

  const existingSnap = await db.collection('market_dates').where('market_id', '==', market.id).get();
  const existingById = new Map<string, MarketDateDoc>();
  for (const doc of existingSnap.docs) {
    existingById.set(doc.id, toDoc(doc.id, doc.data() as Record<string, unknown>));
  }

  const result: GenerateResult = { created: 0, updated: 0, cancelled: 0, unchanged: 0, skipped: 0, frozen: 0, from, to };

  for (const date of dates) {
    const id = `${market.id}_${date}`;
    const existing = existingById.get(id);
    const expected = computeExpected(market, date);
    const skippedEntry = market.schedule.skipped_dates.find((s) => s.date === date);

    if (expected) {
      const start_at = localToUtc(date, expected.start_time, market.timezone);
      const end_at = localToUtc(date, expected.end_time, market.timezone);
      const deadline_at = new Date(end_at.getTime() + market.workflow.deadline_offset_min * 60_000);

      if (!existing) {
        const doc: Omit<MarketDateDoc, 'id'> = {
          market_id: market.id,
          date,
          start_time: expected.start_time,
          end_time: expected.end_time,
          start_at,
          end_at,
          status: 'collecting',
          schedule_version: expected.schedule_version,
          special: expected.special,
          note: expected.special ? expected.note : '',
          actions: {
            checkin_sent_at: null,
            reminders_sent: [],
            deadline_at,
            deadline_processed_at: null,
            drafts_generated_at: null,
            approved_at: null,
            booth_texts_sent_at: null,
          },
          extra_questions: [],
          sponsor_id: null,
          cancellation_reason: null,
          cancelled_at: null,
          cancelled_by: null,
          generated_at: now,
          source: 'generator',
          created_at: now,
          updated_at: now,
        };
        await db.collection('market_dates').doc(id).set(doc as Record<string, unknown>);
        result.created += 1;
        continue;
      }

      const decided = isDateDecided(existing, now);
      const revivable = isRevivable(existing, now);

      if (decided && !revivable) {
        result.frozen += 1;
        continue;
      }

      if (revivable) {
        await db
          .collection('market_dates')
          .doc(id)
          .update({
            status: 'collecting',
            cancellation_reason: null,
            cancelled_at: null,
            cancelled_by: null,
            start_time: expected.start_time,
            end_time: expected.end_time,
            start_at,
            end_at,
            schedule_version: expected.schedule_version,
            special: expected.special,
            ...(expected.special ? { note: expected.note } : {}),
            actions: { ...existing.actions, deadline_at },
            generated_at: now,
            updated_at: now,
          });
        result.updated += 1;
        continue;
      }

      // Undecided existing doc: compare, then update only if something changed.
      const same =
        existing.start_time === expected.start_time &&
        existing.end_time === expected.end_time &&
        existing.start_at.getTime() === start_at.getTime() &&
        existing.end_at.getTime() === end_at.getTime() &&
        existing.schedule_version === expected.schedule_version &&
        existing.special === expected.special &&
        (!expected.special || existing.note === expected.note);
      if (same) {
        result.unchanged += 1;
        continue;
      }

      const update: Record<string, unknown> = {
        start_time: expected.start_time,
        end_time: expected.end_time,
        start_at,
        end_at,
        schedule_version: expected.schedule_version,
        special: expected.special,
        actions: { ...existing.actions, deadline_at },
        generated_at: now,
        updated_at: now,
      };
      if (expected.special) update.note = expected.note;
      await db.collection('market_dates').doc(id).update(update);
      result.updated += 1;
      continue;
    }

    // Not an expected market day.
    if (!existing) {
      if (skippedEntry) result.skipped += 1;
      continue;
    }
    if (isDateDecided(existing, now)) {
      result.frozen += 1;
      continue;
    }
    await db
      .collection('market_dates')
      .doc(id)
      .update({
        status: 'cancelled',
        cancelled_by: 'generator',
        cancelled_at: now,
        cancellation_reason: skippedEntry ? `skipped: ${skippedEntry.reason}` : 'schedule_change',
        updated_at: now,
      });
    result.cancelled += 1;
  }

  return result;
}
