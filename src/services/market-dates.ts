import type { Firestore } from 'firebase-admin/firestore';
import { addDays, eachDate, localToUtc, utcToLocalDate, weekdayOf } from '../utils/tz.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
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

/** Phase 3 contract §2.2: one `reminders_sent` entry per offset the engine has acted on. */
export interface ReminderSent {
  offset_min: number;
  sent_at: Date;
  recipients: number;
  failed: number;
  skipped: 'superseded' | null;
}

/**
 * Stored shape of a reminder outcome (Phase 3 fix, round 2): the engine
 * writes each offset's `ReminderSent` to its own field,
 * `actions.reminder_state.<reminderStateKey(offset)>`, with a dotted field
 * path — never the `actions` map — so two runs holding different reminder
 * locks write disjoint paths and neither can drop the other's decision.
 * `actions.reminders_sent`, the array every reader (the status route, the web
 * page, `isDateDecided`) uses, is DERIVED from that map by
 * `marketDateFromData`, offset-sorted, over any legacy `reminders_sent`
 * array. No production doc has either yet, so nothing migrates. Offsets are
 * integers (zod, `src/services/markets.ts`), so the key is a plain
 * identifier and dot notation is legal.
 */
export function reminderStateKey(offsetMin: number): string {
  if (!Number.isInteger(offsetMin)) throw new Error(`reminder offset must be an integer (got ${offsetMin})`);
  return `offset_${offsetMin}`;
}

export interface MarketDateActions {
  checkin_sent_at: Date | null;
  /** Derived on read from `reminder_state` (see reminderStateKey); never written as an array by the engine. */
  reminders_sent: ReminderSent[];
  deadline_at: Date;
  deadline_processed_at: Date | null;
  drafts_generated_at: Date | null;
  approved_at: Date | null;
  booth_texts_sent_at: Date | null;
  // Phase 3 — absent on every doc the generator alone has ever touched;
  // readers (marketDateFromData) default them.
  checkin_recipients?: number;
  checkin_failed?: number;
  summary_sent_at?: Date | null;
  summary_skipped?: 'no_recipients' | 'notify_false' | null;
  /** keys: 'checkin' | `reminder_${offset_min}` | 'deadline' | 'summary' — never count toward isDateDecided. */
  claims?: Record<string, Date>;
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
  // Phase 3 — written by processDeadline; absent until a date's deadline has
  // been processed at least once.
  non_responders?: string[];
  spot_not_held?: string[];
  deadline_recipient_count?: number;
  deadline_responded_count?: number;
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

/**
 * A `market_dates` document as read back from Firestore, with every date
 * field normalised to `Date` (Firestore returns Timestamps). The one way to
 * turn a snapshot into a MarketDateDoc — routes use it too.
 */
function reminderSentFromData(raw: unknown): ReminderSent {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    offset_min: typeof r.offset_min === 'number' ? r.offset_min : 0,
    sent_at: toDateOrEpoch(r.sent_at),
    recipients: typeof r.recipients === 'number' ? r.recipients : 0,
    failed: typeof r.failed === 'number' ? r.failed : 0,
    skipped: r.skipped === 'superseded' ? 'superseded' : null,
  };
}

function reminderStateFromData(raw: unknown): ReminderSent[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.values(raw as Record<string, unknown>).map(reminderSentFromData);
}

/**
 * The derived, offset-sorted `reminders_sent`: the `reminder_state` map (the
 * engine's write shape) over any legacy `reminders_sent` array. An offset
 * present in both reads from the map; an offset only the array holds is
 * kept — a recorded outcome is never dropped on read, which is the point of
 * the per-offset shape.
 */
function deriveRemindersSent(a: Record<string, unknown>): ReminderSent[] {
  const byOffset = new Map<number, ReminderSent>();
  for (const r of (Array.isArray(a.reminders_sent) ? a.reminders_sent : []).map(reminderSentFromData)) byOffset.set(r.offset_min, r);
  for (const r of reminderStateFromData(a.reminder_state)) byOffset.set(r.offset_min, r);
  return [...byOffset.values()].sort((x, y) => x.offset_min - y.offset_min);
}

function claimsFromData(raw: unknown): Record<string, Date> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Date> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const d = toDate(value);
    if (d) out[key] = d;
  }
  return out;
}

export function marketDateFromData(id: string, data: Record<string, unknown>): MarketDateDoc {
  const a = (data.actions ?? {}) as Record<string, unknown>;
  const actions: MarketDateActions = {
    checkin_sent_at: toDate(a.checkin_sent_at),
    // Phase 3 (contract §2.2): reminders_sent entries are ReminderSent objects,
    // not bare Timestamps — a naive `.map(toDate)` would silently drop every
    // one. Round 2: derived from the per-offset `reminder_state` map.
    reminders_sent: deriveRemindersSent(a),
    deadline_at: toDateOrEpoch(a.deadline_at),
    deadline_processed_at: toDate(a.deadline_processed_at),
    drafts_generated_at: toDate(a.drafts_generated_at),
    approved_at: toDate(a.approved_at),
    booth_texts_sent_at: toDate(a.booth_texts_sent_at),
    checkin_recipients: typeof a.checkin_recipients === 'number' ? a.checkin_recipients : undefined,
    checkin_failed: typeof a.checkin_failed === 'number' ? a.checkin_failed : undefined,
    summary_sent_at: 'summary_sent_at' in a ? toDate(a.summary_sent_at) : undefined,
    summary_skipped: a.summary_skipped === 'no_recipients' || a.summary_skipped === 'notify_false' ? a.summary_skipped : undefined,
    claims: claimsFromData(a.claims),
  };
  return {
    ...(data as Omit<MarketDateDoc, 'id'>),
    id,
    start_at: toDateOrEpoch(data.start_at),
    end_at: toDateOrEpoch(data.end_at),
    actions,
    non_responders: Array.isArray(data.non_responders) ? (data.non_responders as string[]) : undefined,
    spot_not_held: Array.isArray(data.spot_not_held) ? (data.spot_not_held as string[]) : undefined,
    deadline_recipient_count: typeof data.deadline_recipient_count === 'number' ? data.deadline_recipient_count : undefined,
    deadline_responded_count: typeof data.deadline_responded_count === 'number' ? data.deadline_responded_count : undefined,
    cancelled_at: toDate(data.cancelled_at),
    generated_at: toDateOrEpoch(data.generated_at),
    created_at: toDateOrEpoch(data.created_at),
    updated_at: toDateOrEpoch(data.updated_at),
  };
}

export async function generateMarketDates(db: Firestore, market: FarmersMarket, opts: GenerateOptions): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const { from, to } = computeWindow(market, opts.scope, now);
  const dates = eachDate(from, to);

  const existingSnap = await db.collection('market_dates').where('market_id', '==', market.id).get();
  const existingById = new Map<string, MarketDateDoc>();
  for (const doc of existingSnap.docs) {
    existingById.set(doc.id, marketDateFromData(doc.id, doc.data() as Record<string, unknown>));
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
            // A field path, never the `actions` map (round 2): the only
            // action the generator owns is deadline_at. The map spread it
            // replaced also carried the normalised doc's `undefined` optional
            // fields, which the admin SDK rejects outright.
            'actions.deadline_at': deadline_at,
            generated_at: now,
            updated_at: now,
          });
        result.updated += 1;
        continue;
      }

      // Undecided existing doc (isDateDecided is false: no engine action, not
      // even a reminder_state entry): compare, then update only if something
      // changed — and only the one action field the generator owns.
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
        'actions.deadline_at': deadline_at,
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
