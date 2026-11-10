import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { nextAllowedInstant } from '../utils/quiet-hours.js';
import { parseDate, weekdayOf, DAYS_OF_WEEK } from '../utils/tz.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { isAlreadyExists } from '../db/firestore.js';
import type { AssignmentSource, BoothKind, DraftSkipReason } from '../types/schema.js';
import { assignmentCycleFromData, marketDateFromData } from './market-dates.js';
import type { AssignmentCycleState, BoothTextsBlocked, MarketDateActions, MarketDateDoc } from './market-dates.js';
import { DEFAULT_QUIET_HOURS } from './markets.js';
import type { FarmersMarket } from './markets.js';
import { compareBooths, listBooths } from './booths.js';
import type { BoothDoc } from './booths.js';
import { currentSeason, isVendorOfRecord, listCurrentMemberships } from './seasons.js';
import type { FeePlan } from './seasons.js';
import { summarizeSeason } from './applications.js';

/**
 * Booth assignments (Phase 4 contract §2.8, §3.4, §3.5): the drafting
 * algorithm, the draft writer, manual changes and the staff view.
 *
 * `booth_assignments` is append-only. A row's `market_date_id` is the TARGET
 * date the vendor will attend (the next market after the collecting date whose
 * check-ins produced the draft, `source_date_id`). A row is "current" while
 * `superseded_by` is null; replacing one sets `superseded_by`/`superseded_at`
 * instead of deleting it.
 *
 * This module never imports checkin-workflow.ts (that file imports this one);
 * the claims, the texts and the engine live there.
 *
 * CYCLES (Phase 4 fix). A market date document can carry two assignment
 * cycles, each with its own draft / approval / booth-text state:
 *   - `next` (every date): the date's check-ins assign the NEXT market; the
 *     state is `actions.*`, the target is `actions.assignments_target_date_id`.
 *   - `opener` (only the first market date of the current season): there is no
 *     earlier market of the season to ask "are you attending next?", so the
 *     opener assigns ITSELF; the state is `actions.opener.*`, the attendance is
 *     the season's seasonal-plan vendors plus anyone staff add by hand, and the
 *     engine never drafts it (staff press Draft). The last date of the previous
 *     season therefore has no target (`no_next_date`): it must not seat last
 *     season's vendors on the new season's first day.
 * Every function below takes the cycle as `'next' | 'opener'` (default `next`)
 * and writes field paths under that cycle's prefix only.
 *
 * CHANGES AND TEXTS (Phase 4 fix). After approval the assignments are what
 * vendors are texted, and Firestore gives this code no multi-document write
 * (the test envelope has no batch or transaction), so three things keep a staff
 * change and the booth-text step honest with each other:
 *   1. one staff change at a time per cycle - a mutex document created with
 *      `create()` and deleted when the change ends (`withChangeLock`); a second
 *      change meanwhile is refused, never interleaved;
 *   2. `assignments_rev`, a fresh token written BEFORE the rows move and again
 *      AFTER: the booth-text step records the token it acted on
 *      (`booth_texts_rev`), so a change always leaves the two unequal and the
 *      next engine tick looks again (`boothTextsSettled`);
 *   3. the booth-text step reads the token, then the rows, then the token and
 *      the mutex again, and sends nothing when either moved (`changeInFlight`):
 *      it never texts from a half-applied change.
 * What a vendor has been told is read from the `messages` log, and each text's
 * at-most-once key is built on the vendor's newest current assignment row, so
 * no assignment is ever texted twice (`planBoothTexts`).
 */

export type CycleMode = 'next' | 'opener';

export interface AssignmentCycle {
  mode: CycleMode;
  date: MarketDateDoc;
  /** Field-path prefix of this cycle's state on the date document. */
  path: 'actions' | 'actions.opener';
  /** Prefix of this cycle's step-lock keys (`workflow_locks/<date>__<prefix><step>`). */
  lock: '' | 'opener_';
  state: AssignmentCycleState;
}

/** The stored state of one cycle of a date, normalised (an absent opener cycle reads as empty). */
export function cycleStateOf(actions: MarketDateActions, mode: CycleMode): AssignmentCycleState {
  if (mode === 'opener') return actions.opener ?? assignmentCycleFromData(null);
  return {
    drafts_generated_at: actions.drafts_generated_at,
    assignments_draft_at: actions.assignments_draft_at ?? null,
    assignments_target_date_id: actions.assignments_target_date_id ?? null,
    drafts_skipped: actions.drafts_skipped ?? null,
    approved_at: actions.approved_at,
    approved_by: actions.approved_by ?? null,
    booth_texts_sent_at: actions.booth_texts_sent_at,
    booth_summary: actions.booth_summary ?? null,
    booth_text_recipients: actions.booth_text_recipients,
    booth_text_failed: actions.booth_text_failed,
    booth_text_excluded: actions.booth_text_excluded,
    booth_texts_blocked: actions.booth_texts_blocked ?? null,
    assignments_rev: actions.assignments_rev ?? null,
    booth_texts_rev: actions.booth_texts_rev ?? null,
  };
}

export function cycleOf(date: MarketDateDoc, mode: CycleMode): AssignmentCycle {
  return {
    mode,
    date,
    path: mode === 'opener' ? 'actions.opener' : 'actions',
    lock: mode === 'opener' ? 'opener_' : '',
    state: cycleStateOf(date.actions, mode),
  };
}

export const CYCLE_MODES: readonly CycleMode[] = ['next', 'opener'];

/**
 * True when the booth-text step has nothing to do for a cycle as its document
 * stands. Pure and read from the date document alone, so the engine skips a
 * settled date without a single extra read. Settled means:
 *   - not approved (nothing is owed before approval); or
 *   - the last pass acted on the assignments as they are now
 *     (`booth_texts_rev === assignments_rev`; both absent on a cycle nobody has
 *     changed) AND that pass either sent the texts or recorded why it could not
 *     (`conflict`: only a staff change can resolve it, and a change moves the
 *     token; `started`: nothing will ever be sent).
 * A `cancelled` target is the one hold that is re-checked every tick: a date
 * can be un-cancelled without anything touching this document.
 */
export function boothTextsSettled(s: AssignmentCycleState): boolean {
  if (!s.approved_at) return true;
  if ((s.assignments_rev ?? null) !== (s.booth_texts_rev ?? null)) return false;
  if (s.booth_texts_blocked === 'cancelled') return false;
  return s.booth_texts_sent_at != null || s.booth_texts_blocked != null;
}

export interface BoothAssignmentDoc {
  id: string;
  market_id: string;
  market_date_id: string;
  source_date_id: string;
  booth_id: string;
  producer_id: string;
  source: AssignmentSource;
  /** 'engine' or a user id. */
  assigned_by: string;
  assigned_at: Date;
  superseded_by: string | null;
  superseded_at: Date | null;
}

export function assignmentFromData(id: string, data: Record<string, unknown>): BoothAssignmentDoc {
  const source = data.source;
  return {
    id,
    market_id: String(data.market_id ?? ''),
    market_date_id: String(data.market_date_id ?? ''),
    source_date_id: String(data.source_date_id ?? ''),
    booth_id: String(data.booth_id ?? ''),
    producer_id: String(data.producer_id ?? ''),
    source: source === 'usual' || source === 'manual' ? source : 'suggested',
    assigned_by: String(data.assigned_by ?? ''),
    assigned_at: toDateOrEpoch(data.assigned_at),
    superseded_by: typeof data.superseded_by === 'string' ? data.superseded_by : null,
    superseded_at: toDate(data.superseded_at),
  };
}

/** Current (not superseded) assignments of a target date. One equality filter. */
export async function currentAssignments(db: Firestore, targetDateId: string): Promise<BoothAssignmentDoc[]> {
  const snap = await db.collection('booth_assignments').where('market_date_id', '==', targetDateId).get();
  return snap.docs
    .map((d) => assignmentFromData(d.id, d.data() as Record<string, unknown>))
    .filter((a) => a.superseded_by === null)
    .sort((a, b) => a.assigned_at.getTime() - b.assigned_at.getTime() || a.id.localeCompare(b.id));
}

// ─── The drafting algorithm (pure) ───────────────────────────────────────

export type UnassignedReason = 'no_power_stall' | 'no_pair' | 'full' | 'no_food_truck_slot';

export interface PlanVendor {
  producer_id: string;
  business_name: string;
  spaces: 1 | 2;
  electric: boolean;
  booth_kind: BoothKind;
  usual_booth_id: string | null;
}

export interface PlanInput {
  booths: BoothDoc[];
  vendors: PlanVendor[];
  /** Manual placements the plan must work around; their vendors are NOT in `vendors`. */
  fixed: { producer_id: string; booth_id: string }[];
}

export interface PlanResult {
  placed: { producer_id: string; booth_ids: string[]; source: 'usual' | 'suggested' }[];
  /** A two-space vendor given only one booth appears in both lists (`no_pair`). */
  unassigned: { producer_id: string; reason: UnassignedReason }[];
  /** Placements staff should look at. `power_mismatch`: a vendor who needs electricity kept a usual space with no power. */
  warnings: { producer_id: string; reason: 'power_mismatch'; booth_ids: string[] }[];
}

/**
 * Deterministic booth plan (contract §3.5). Booths are taken in (row, order).
 *
 * Pass 1 seats vendors in their usual booth whenever it is free and of the
 * right kind. A two-space vendor also takes the free same-row neighbour at
 * order + 1, else order - 1, WHATEVER that neighbour's power flag (the usual
 * stall is where they plug in); with no free neighbour they keep the usual
 * stall alone and are also listed `no_pair`. A vendor who needs electricity
 * keeps a usual stall that has none - where a vendor stands is the vendor's
 * and the staff's call, not the planner's - and the plan says so with a
 * `power_mismatch` warning instead of silently moving them.
 *
 * Pass 2 seats everyone else: food-truck vendors first, then electric, then
 * two-space, then by name; powered stalls are kept for vendors who need
 * electricity.
 */
export function planAssignments(input: PlanInput): PlanResult {
  const booths = input.booths.filter((b) => b.active).sort(compareBooths);
  const byId = new Map(booths.map((b) => [b.id, b]));
  const taken = new Set(input.fixed.map((f) => f.booth_id));
  const isFree = (b: BoothDoc) => !taken.has(b.id);

  const placed: PlanResult['placed'] = [];
  const unassigned: PlanResult['unassigned'] = [];
  const warnings: PlanResult['warnings'] = [];
  const seated = new Set<string>();

  const freeStalls = () => booths.filter((b) => b.kind === 'stall' && isFree(b));
  const neighbour = (b: BoothDoc, delta: 1 | -1) =>
    booths.find((x) => x.kind === 'stall' && x.row === b.row && x.order === b.order + delta && isFree(x));
  const take = (...ids: string[]) => ids.forEach((id) => taken.add(id));

  // Pass 1 — usual booths.
  const usual = input.vendors
    .map((v) => ({ v, booth: v.usual_booth_id ? byId.get(v.usual_booth_id) : undefined }))
    .filter((x): x is { v: PlanVendor; booth: BoothDoc } => !!x.booth && x.booth.kind === x.v.booth_kind)
    .sort((a, b) => compareBooths(a.booth, b.booth) || a.v.business_name.localeCompare(b.v.business_name) || a.v.producer_id.localeCompare(b.v.producer_id));
  for (const { v, booth } of usual) {
    if (!isFree(booth)) continue;
    const stall = v.booth_kind === 'stall';
    take(booth.id);
    let held = [booth];
    if (stall && v.spaces === 2) {
      const pair = neighbour(booth, 1) ?? neighbour(booth, -1);
      if (pair) {
        take(pair.id);
        held = [booth, pair].sort(compareBooths);
      } else {
        unassigned.push({ producer_id: v.producer_id, reason: 'no_pair' });
      }
    }
    const boothIds = held.map((b) => b.id);
    if (stall && v.electric && !held.some((b) => b.power)) warnings.push({ producer_id: v.producer_id, reason: 'power_mismatch', booth_ids: boothIds });
    placed.push({ producer_id: v.producer_id, booth_ids: boothIds, source: 'usual' });
    seated.add(v.producer_id);
  }

  // Pass 2 — everyone else.
  const rest = input.vendors
    .filter((v) => !seated.has(v.producer_id))
    .sort(
      (a, b) =>
        Number(b.booth_kind === 'food_truck') - Number(a.booth_kind === 'food_truck') ||
        Number(b.electric) - Number(a.electric) ||
        b.spaces - a.spaces ||
        a.business_name.localeCompare(b.business_name) ||
        a.producer_id.localeCompare(b.producer_id),
    );
  for (const v of rest) {
    if (v.booth_kind === 'food_truck') {
      const slot = booths.find((b) => b.kind === 'food_truck' && isFree(b));
      if (!slot) {
        unassigned.push({ producer_id: v.producer_id, reason: 'no_food_truck_slot' });
        continue;
      }
      take(slot.id);
      placed.push({ producer_id: v.producer_id, booth_ids: [slot.id], source: 'suggested' });
      continue;
    }

    const stalls = freeStalls();
    if (stalls.length === 0) {
      unassigned.push({ producer_id: v.producer_id, reason: 'full' });
      continue;
    }

    if (v.spaces === 1) {
      const pick = v.electric
        ? stalls.find((b) => b.power)
        : [...stalls].sort((a, b) => Number(a.power) - Number(b.power) || compareBooths(a, b))[0];
      if (!pick) {
        unassigned.push({ producer_id: v.producer_id, reason: 'no_power_stall' });
        continue;
      }
      take(pick.id);
      placed.push({ producer_id: v.producer_id, booth_ids: [pick.id], source: 'suggested' });
      continue;
    }

    // Two spaces: a same-row consecutive pair of free stalls.
    const pairs: [BoothDoc, BoothDoc][] = [];
    for (const a of stalls) {
      const b = stalls.find((x) => x.row === a.row && x.order === a.order + 1);
      if (!b) continue;
      if (v.electric && !(a.power && b.power)) continue;
      pairs.push([a, b]);
    }
    if (pairs.length === 0) {
      unassigned.push({ producer_id: v.producer_id, reason: 'no_pair' });
      continue;
    }
    // Stable by booth order; a vendor without electricity prefers the pair that uses the fewest powered stalls.
    const poweredCount = (p: [BoothDoc, BoothDoc]) => Number(p[0].power) + Number(p[1].power);
    const pair = v.electric ? pairs[0]! : [...pairs].sort((x, y) => poweredCount(x) - poweredCount(y))[0]!;
    take(pair[0].id, pair[1].id);
    placed.push({ producer_id: v.producer_id, booth_ids: [pair[0].id, pair[1].id], source: 'suggested' });
  }

  return { placed, unassigned, warnings };
}

// ─── Who is attending ────────────────────────────────────────────────────

export interface VendorInfo extends PlanVendor {
  membership_id: string;
  fee_plan: FeePlan;
}

export interface Attendance {
  season: string;
  /** Every active current-season vendor of the market whose producer is active. */
  vendors: VendorInfo[];
  /** The cycle's own list: `next` = answered "attending next" on the source date; `opener` = on the seasonal plan. */
  attending: VendorInfo[];
  not_attending: VendorInfo[];
  no_answer: VendorInfo[];
  /** Business names of every producer, for labelling assignments of vendors who have since left the rotation. */
  names: Map<string, string>;
}

/**
 * The vendors of the market's current season and who the cycle starts from.
 * `next`: what they answered on the collecting date `source` -
 * `attending_next === true` means "attending the next market after `source`"
 * (contract §2.10). `opener`: nobody has been asked anything yet, so the list
 * starts from the vendors on the seasonal plan (they hold a space every week);
 * daily-plan vendors are added by hand.
 */
export async function loadAttendance(
  db: Firestore,
  market: FarmersMarket,
  source: MarketDateDoc,
  now: Date,
  mode: CycleMode = 'next',
): Promise<Attendance> {
  const { season, memberships } = await listCurrentMemberships(db, market, now);
  const producersSnap = await db.collection('producers').get();
  const producers = new Map<string, Record<string, unknown>>();
  const names = new Map<string, string>();
  for (const d of producersSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    producers.set(d.id, data);
    names.set(d.id, String(data.business_name ?? ''));
  }

  const vendors: VendorInfo[] = [];
  const seen = new Set<string>();
  for (const m of memberships.filter(isVendorOfRecord)) {
    if (seen.has(m.producer_id)) continue;
    const p = producers.get(m.producer_id);
    if (!p || p.active === false) continue;
    seen.add(m.producer_id);
    vendors.push({
      producer_id: m.producer_id,
      business_name: String(p.business_name ?? ''),
      spaces: m.spaces,
      electric: m.electric,
      booth_kind: m.booth_kind,
      usual_booth_id: m.usual_booth_id,
      membership_id: m.id,
      fee_plan: m.fee_plan,
    });
  }
  vendors.sort((a, b) => a.business_name.localeCompare(b.business_name) || a.producer_id.localeCompare(b.producer_id));

  if (mode === 'opener') {
    return { season, vendors, attending: vendors.filter((v) => v.fee_plan === 'seasonal'), not_attending: [], no_answer: [], names };
  }

  const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', source.id).get();
  const answer = new Map<string, boolean | null>();
  for (const d of checkinsSnap.docs) {
    const c = d.data() as Record<string, unknown>;
    answer.set(String(c.producer_id ?? ''), typeof c.attending_next === 'boolean' ? c.attending_next : null);
  }
  return {
    season,
    vendors,
    attending: vendors.filter((v) => answer.get(v.producer_id) === true),
    not_attending: vendors.filter((v) => answer.get(v.producer_id) === false),
    no_answer: vendors.filter((v) => !answer.has(v.producer_id) || answer.get(v.producer_id) === null),
    names,
  };
}

export type CanAddReason = 'not_attending' | 'no_answer' | 'daily_plan';

/**
 * Who a cycle is seating: its own list plus every current-season vendor who
 * holds a booth on the target date anyway - a vendor staff added by hand
 * (`added_by_staff`), or one who was drafted and then changed their answer.
 * Everyone else in the rotation is `can_add`, with why they are not on the list.
 */
export function seatedVendors(
  attendance: Attendance,
  rows: Pick<BoothAssignmentDoc, 'producer_id' | 'source'>[],
  mode: CycleMode,
): { attending: (VendorInfo & { added_by_staff: boolean })[]; can_add: (VendorInfo & { reason: CanAddReason })[] } {
  const base = new Set(attendance.attending.map((v) => v.producer_id));
  const holders = new Set(rows.map((r) => r.producer_id));
  const manual = new Set(rows.filter((r) => r.source === 'manual').map((r) => r.producer_id));
  const declined = new Set(attendance.not_attending.map((v) => v.producer_id));
  const attending = attendance.vendors
    .filter((v) => base.has(v.producer_id) || holders.has(v.producer_id))
    .map((v) => ({ ...v, added_by_staff: !base.has(v.producer_id) && manual.has(v.producer_id) }));
  const seated = new Set(attending.map((v) => v.producer_id));
  const can_add = attendance.vendors
    .filter((v) => !seated.has(v.producer_id))
    .map((v) => ({
      ...v,
      reason: (mode === 'opener' ? 'daily_plan' : declined.has(v.producer_id) ? 'not_attending' : 'no_answer') as CanAddReason,
    }));
  return { attending, can_add };
}

// ─── Dates: the next market, the season opener, a cycle's target ──────────

/** Every market date of a market, by calendar date. One equality filter. */
async function marketDatesOf(db: Firestore, marketId: string): Promise<MarketDateDoc[]> {
  const snap = await db.collection('market_dates').where('market_id', '==', marketId).get();
  return snap.docs.map((d) => marketDateFromData(d.id, d.data() as Record<string, unknown>)).sort((a, b) => a.date.localeCompare(b.date));
}

/** The earliest non-cancelled date of the market after `date.date`, or null. */
export async function nextDateAfter(db: Firestore, market: Pick<FarmersMarket, 'id'>, date: Pick<MarketDateDoc, 'date'>): Promise<MarketDateDoc | null> {
  const later = (await marketDatesOf(db, market.id)).filter((d) => d.status !== 'cancelled' && d.date > date.date);
  return later[0] ?? null;
}

/**
 * The season opener among `dates`: the earliest non-cancelled market date on or
 * after the first day of the market's current season (and inside it). The
 * season is the market's own setting - `summarizeSeason` reads
 * `season.schedule_version_id`, else the schedule version that starts last - so
 * nothing here names a date. Null for a market with no schedule version, or
 * whose season has no generated date yet.
 */
export function seasonOpenerOf(market: Pick<FarmersMarket, 'schedule' | 'season'>, dates: MarketDateDoc[]): MarketDateDoc | null {
  const version = seasonScheduleVersion(market);
  if (!version) return null;
  const inSeason = dates
    .filter((d) => d.status !== 'cancelled' && d.date >= version.season_start && d.date <= version.season_end)
    .sort((a, b) => a.date.localeCompare(b.date));
  return inSeason[0] ?? null;
}

/** The schedule version of the market's season, through `summarizeSeason`; null for a market with no schedule version (test fixtures). */
function seasonScheduleVersion(market: Pick<FarmersMarket, 'schedule' | 'season'>) {
  const schedule = market.schedule;
  if (!schedule || !Array.isArray(schedule.versions) || schedule.versions.length === 0) return null;
  return summarizeSeason({
    season: market.season,
    schedule: { versions: schedule.versions, skipped_dates: schedule.skipped_dates ?? [], special_dates: schedule.special_dates ?? [] },
  }).version;
}

export async function findSeasonOpener(db: Firestore, market: FarmersMarket): Promise<MarketDateDoc | null> {
  return seasonOpenerOf(market, await marketDatesOf(db, market.id));
}

/**
 * An opener is seated from the memberships of the market's CURRENT season
 * (`currentSeason`: the season label, else inferred from the schedule), so the
 * season its dates come from must be that same season. They differ when next
 * year's schedule version has been added but the season label has not been set
 * yet: drafting then would seat - and text - LAST season's vendors for the new
 * season's first day. Compared by the year both carry (a label is `YYYY` or
 * `YYYY-suffix`).
 */
export function openerSeasonMatches(market: FarmersMarket, now: Date): boolean {
  const version = seasonScheduleVersion(market);
  return !!version && version.season_start.slice(0, 4) === currentSeason(market, now).slice(0, 4);
}

/**
 * The date a `next` cycle of `date` assigns: the next non-cancelled market
 * date, unless that date is the season opener. The opener is self-sourced (its
 * vendors come from the new season's memberships, not from the last check-in
 * of the season before), so the date before it has nothing to assign.
 */
export async function nextTargetOf(db: Firestore, market: FarmersMarket, date: Pick<MarketDateDoc, 'date'>): Promise<MarketDateDoc | null> {
  const dates = await marketDatesOf(db, market.id);
  const next = dates.filter((d) => d.status !== 'cancelled' && d.date > date.date)[0] ?? null;
  if (!next) return null;
  const opener = seasonOpenerOf(market, dates);
  return opener && opener.id === next.id ? null : next;
}

// ─── Summary and conflicts ───────────────────────────────────────────────

export interface BoothSummary {
  assigned: number;
  unassigned: number;
  booths_total: number;
  booths_free: number;
}

function producersByBooth(rows: Pick<BoothAssignmentDoc, 'booth_id' | 'producer_id'>[]): Map<string, Set<string>> {
  const byBooth = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byBooth.get(r.booth_id) ?? new Set<string>();
    set.add(r.producer_id);
    byBooth.set(r.booth_id, set);
  }
  return byBooth;
}

/** Booth ids held by more than one producer. */
export function conflictedBoothIds(rows: Pick<BoothAssignmentDoc, 'booth_id' | 'producer_id'>[]): string[] {
  return [...producersByBooth(rows).entries()]
    .filter(([, s]) => s.size > 1)
    .map(([id]) => id)
    .sort();
}

export function computeBoothSummary(
  activeBooths: BoothDoc[],
  attendingProducerIds: string[],
  rows: Pick<BoothAssignmentDoc, 'booth_id' | 'producer_id'>[],
): BoothSummary {
  const activeIds = new Set(activeBooths.map((b) => b.id));
  const seatedProducers = new Set(rows.map((r) => r.producer_id));
  const usedBooths = new Set(rows.map((r) => r.booth_id).filter((id) => activeIds.has(id)));
  return {
    assigned: attendingProducerIds.filter((id) => seatedProducers.has(id)).length,
    unassigned: attendingProducerIds.filter((id) => !seatedProducers.has(id)).length,
    booths_total: activeBooths.length,
    booths_free: activeBooths.length - usedBooths.size,
  };
}

// ─── Drafting ────────────────────────────────────────────────────────────

/**
 * `no_next_date` / `no_booths`: there is nothing to draft ONTO. `no_attendees`:
 * there is nobody to draft yet - the engine records that as a skip, while the
 * staff Draft button goes ahead with an empty draft so vendors can be added by
 * hand.
 */
export type PreparedDraft =
  | { skipped: 'no_next_date' | 'no_booths'; target: MarketDateDoc | null }
  | { skipped: 'no_attendees' | null; target: MarketDateDoc; booths: BoothDoc[]; attendance: Attendance };

/**
 * Everything a draft needs, or the reason there is nothing to draft. Pure reads:
 * the manual route calls it before taking any lock so a refusal never leaves one
 * behind. An opener cycle's target is the date itself.
 */
export async function prepareDraft(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  now: Date,
  mode: CycleMode = 'next',
): Promise<PreparedDraft> {
  const target = mode === 'opener' ? date : await nextTargetOf(db, market, date);
  if (!target) return { skipped: 'no_next_date', target: null };
  const booths = await listBooths(db, market.id);
  if (booths.length === 0) return { skipped: 'no_booths', target };
  const attendance = await loadAttendance(db, market, date, now, mode);
  return { skipped: attendance.attending.length === 0 ? 'no_attendees' : null, target, booths, attendance };
}

export interface DraftResult {
  skipped: DraftSkipReason | null;
  target_date_id: string | null;
  vendors_placed: number;
  vendors_unassigned: number;
  rows_written: number;
  superseded: number;
  /** Placements staff should look at (`power_mismatch`); see `planAssignments`. */
  warnings: PlanResult['warnings'];
}

const EMPTY_DRAFT: DraftResult = { skipped: null, target_date_id: null, vendors_placed: 0, vendors_unassigned: 0, rows_written: 0, superseded: 0, warnings: [] };

/**
 * Drafts the booth assignments of a cycle (contract §3.5): for the market date
 * after `date` (`next`), or for `date` itself when it is the season opener
 * (`cycle: 'opener'`). Callers hold the step lock (`drafts` for the first draft,
 * a per-version `redraft_*` lock afterwards), so this never races itself.
 *
 *  - `initial`: the engine's first draft (or the first manual one).
 *  - `redraft`: before approval only — supersedes every current non-manual row of
 *    the target date, keeps manual rows as fixed, re-plans around them.
 *
 * `record_skip` (the engine) writes `drafts_skipped` and `drafts_generated_at`
 * when there is nothing to draft, so the step does not loop. A manual draft
 * returns `no_next_date` / `no_booths` and writes nothing; with `allow_empty` it
 * treats "nobody on the list yet" as an empty draft, which is what lets staff
 * add vendors by hand. Writes field paths under the cycle's prefix only, never
 * a map.
 */
export async function draftAssignments(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; actor: string; mode: 'initial' | 'redraft'; record_skip?: boolean; cycle?: CycleMode; allow_empty?: boolean },
): Promise<DraftResult> {
  const { now } = opts;
  const cycle = cycleOf(date, opts.cycle ?? 'next');
  const at = (field: string) => `${cycle.path}.${field}`;
  const ref = db.collection('market_dates').doc(date.id);

  const prepared = await prepareDraft(db, market, date, now, cycle.mode);
  if (!('booths' in prepared) || (prepared.skipped && !opts.allow_empty)) {
    if (opts.record_skip) {
      const update: Record<string, unknown> = { [at('drafts_skipped')]: prepared.skipped, updated_at: now };
      if (opts.mode === 'initial') update[at('drafts_generated_at')] = now;
      await ref.update(update);
    }
    return { ...EMPTY_DRAFT, skipped: prepared.skipped, target_date_id: prepared.target?.id ?? null };
  }
  const { target, booths, attendance } = prepared;

  // Rows already on the target date: manual ones are fixed, the rest are replaced on a redraft.
  const existing = await currentAssignments(db, target.id);
  const fixedRows = existing.filter((a) => a.source === 'manual');
  const replaced = opts.mode === 'redraft' ? existing.filter((a) => a.source !== 'manual') : [];
  const kept = opts.mode === 'redraft' ? fixedRows : existing; // an initial draft over existing rows keeps them all

  const fixedProducers = new Set(kept.map((a) => a.producer_id));
  const plan = planAssignments({
    booths,
    vendors: attendance.attending.filter((v) => !fixedProducers.has(v.producer_id)),
    fixed: kept.map((a) => ({ producer_id: a.producer_id, booth_id: a.booth_id })),
  });

  const newRows: BoothAssignmentDoc[] = [];
  for (const p of plan.placed) {
    for (const boothId of p.booth_ids) {
      newRows.push({
        id: uuid(),
        market_id: market.id,
        market_date_id: target.id,
        source_date_id: date.id,
        booth_id: boothId,
        producer_id: p.producer_id,
        source: p.source,
        assigned_by: opts.actor,
        assigned_at: now,
        superseded_by: null,
        superseded_at: null,
      });
    }
  }

  // Supersede first (new ids are known up front), then write: a crash in between leaves
  // an un-drafted date to redraft, never two vendors on one booth.
  const firstNewRowOf = new Map<string, string>();
  for (const r of newRows) if (!firstNewRowOf.has(r.producer_id)) firstNewRowOf.set(r.producer_id, r.id);
  for (const old of replaced) {
    await db.collection('booth_assignments').doc(old.id).update({ superseded_by: firstNewRowOf.get(old.producer_id) ?? 'redraft', superseded_at: now });
  }
  for (const r of newRows) {
    await db.collection('booth_assignments').doc(r.id).set(r as unknown as Record<string, unknown>);
  }

  const after = [...kept, ...newRows];
  const summary = computeBoothSummary(
    booths,
    seatedVendors(attendance, after, cycle.mode).attending.map((v) => v.producer_id),
    after,
  );
  const update: Record<string, unknown> = {
    [at('assignments_draft_at')]: now,
    [at('assignments_target_date_id')]: target.id,
    [at('drafts_skipped')]: null,
    [at('booth_summary')]: summary,
    updated_at: now,
  };
  if (opts.mode === 'initial' || !cycle.state.drafts_generated_at) update[at('drafts_generated_at')] = now;
  await ref.update(update);

  return {
    skipped: null,
    target_date_id: target.id,
    vendors_placed: plan.placed.length,
    vendors_unassigned: plan.unassigned.filter((u) => !plan.placed.some((p) => p.producer_id === u.producer_id)).length,
    rows_written: newRows.length,
    superseded: replaced.length,
    warnings: plan.warnings,
  };
}

// ─── Manual changes ──────────────────────────────────────────────────────

/**
 * A staff change holds its mutex for a few document writes; the API function is
 * killed at 120 s, so a lock older than this belongs to a request that died and
 * is taken over.
 */
export const CHANGE_LOCK_TTL_MS = 3 * 60_000;

/** `workflow_locks` doc id of a cycle's change mutex. Unlike the engine's step locks this one is deleted when the change ends. */
export function changeLockId(dateId: string, mode: CycleMode): string {
  return `${dateId}__${mode === 'opener' ? 'opener_' : ''}assignments_change`;
}

/**
 * True while a staff change to this cycle's assignments is being written (its
 * mutex exists and is not stale). The booth-text step sends nothing meanwhile.
 */
export async function changeInFlight(db: Firestore, dateId: string, mode: CycleMode, now: Date): Promise<boolean> {
  const snap = await db.collection('workflow_locks').doc(changeLockId(dateId, mode)).get();
  if (!snap.exists) return false;
  const claimedAt = toDate((snap.data() as Record<string, unknown>).claimed_at);
  return !!claimedAt && now.getTime() - claimedAt.getTime() < CHANGE_LOCK_TTL_MS;
}

/**
 * Runs `fn` as the only staff change of this cycle: the mutex is `create()`d
 * (atomic - of two simultaneous requests exactly one gets it), a stale one is
 * taken over, and it is deleted whatever `fn` does. Returns null when another
 * change holds it.
 */
async function withChangeLock<T>(db: Firestore, dateId: string, mode: CycleMode, now: Date, fn: () => Promise<T>): Promise<T | null> {
  const ref = db.collection('workflow_locks').doc(changeLockId(dateId, mode));
  const run_id = uuid();
  const lock = { market_date_id: dateId, key: `${mode === 'opener' ? 'opener_' : ''}assignments_change`, claimed_at: now, run_id, created_at: now };
  try {
    await ref.create(lock);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    if (await changeInFlight(db, dateId, mode, now)) return null;
    await ref.set(lock); // the holder died mid-change
  }
  try {
    return await fn();
  } finally {
    // Only our own lock: a request that outlived the TTL must not delete its successor's.
    const snap = await ref.get().catch(() => null);
    if (snap?.exists && (snap.data() as Record<string, unknown>).run_id === run_id) await ref.delete().catch(() => {});
  }
}

/** A fresh `assignments_rev` token: letters and digits only, so it is also a legal lock key and field-path segment. */
function revToken(): string {
  return uuid().replace(/-/g, '');
}

export type ChangeResult =
  | { ok: true; changed: number; target_date_id: string }
  | {
      ok: false;
      status: 400 | 409;
      error: string;
      /**
       * `conflict`: the change would put two vendors on one booth after approval.
       * `target_started`: the market it is for has begun. `in_progress`: another
       * change to these assignments is being saved right now.
       */
      code?: 'conflict' | 'target_started' | 'in_progress';
      booth_id?: string;
      booth_label?: string;
    };

/**
 * Applies staff changes to a cycle's assignments: per producer, the full set of
 * booths they should hold (0 = unassign). Validates everything before writing
 * anything. The superseded rows stay as history; the new ones are `manual`.
 *
 * WHO: any active vendor of the current season - not only the ones on the
 * cycle's own list. A vendor with no "attending" check-in (or, on an opener, on
 * the daily plan) whom staff place by hand simply holds a `manual` row; the view
 * marks them "added by staff". A producer outside the rotation can only be
 * unassigned.
 *
 * BEFORE approval a booth another vendor still holds is allowed (so a swap can
 * be made in one request, or in two) and shows up as a conflict that blocks
 * approval. AFTER approval the assignments are what vendors are being texted,
 * so a change that would leave a booth with a second vendor is refused (409
 * `conflict`, naming the booth) - a swap must come as one request - and so is
 * any change once the target market has started. An accepted change after
 * approval moves `assignments_rev`, which is what makes the booth-text step
 * send each affected vendor one corrective text (or a release notice).
 *
 * One change at a time (`withChangeLock`): the rows are read, checked and
 * written under the cycle's mutex, so two simultaneous requests cannot each
 * pass the conflict check against the same rows and then double-book a booth.
 */
export async function applyAssignmentChanges(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  changes: { producer_id: string; booth_ids: string[] }[],
  actor: string,
  now: Date,
  mode: CycleMode = 'next',
): Promise<ChangeResult> {
  if (!cycleOf(date, mode).state.assignments_target_date_id) return { ok: false, status: 409, error: 'There is no draft to change yet' };

  const seenProducers = new Set<string>();
  for (const c of changes) {
    if (seenProducers.has(c.producer_id)) return { ok: false, status: 400, error: 'A producer appears more than once in changes' };
    seenProducers.add(c.producer_id);
    if (new Set(c.booth_ids).size !== c.booth_ids.length) return { ok: false, status: 400, error: 'A booth appears more than once for a producer' };
  }

  const result = await withChangeLock(db, date.id, mode, now, () => applyChangesLocked(db, market, date.id, changes, actor, now, mode));
  return (
    result ?? {
      ok: false,
      status: 409,
      code: 'in_progress',
      error: 'Another change to these assignments is being saved right now; refresh the page and try again',
    }
  );
}

async function applyChangesLocked(
  db: Firestore,
  market: FarmersMarket,
  dateId: string,
  changes: { producer_id: string; booth_ids: string[] }[],
  actor: string,
  now: Date,
  mode: CycleMode,
): Promise<ChangeResult> {
  // Everything is read again under the mutex: the caller's copy of the date may predate an approval.
  const ref = db.collection('market_dates').doc(dateId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, status: 409, error: 'There is no draft to change yet' };
  const date = marketDateFromData(snap.id, snap.data() as Record<string, unknown>);
  const cycle = cycleOf(date, mode);
  const at = (field: string) => `${cycle.path}.${field}`;
  const targetId = cycle.state.assignments_target_date_id;
  if (!targetId) return { ok: false, status: 409, error: 'There is no draft to change yet' };

  const booths = await listBooths(db, market.id);
  const boothById = new Map(booths.map((b) => [b.id, b]));
  const attendance = await loadAttendance(db, market, date, now, mode);
  const vendorIds = new Set(attendance.vendors.map((v) => v.producer_id));
  const rows = await currentAssignments(db, targetId);
  const holders = new Set(rows.map((r) => r.producer_id));

  for (const c of changes) {
    const releaseOnly = c.booth_ids.length === 0 && holders.has(c.producer_id);
    if (!vendorIds.has(c.producer_id) && !releaseOnly) {
      return { ok: false, status: 400, error: 'That producer is not an active vendor of this market this season' };
    }
    for (const id of c.booth_ids) {
      if (!boothById.has(id)) return { ok: false, status: 400, error: 'Unknown or inactive booth' };
    }
  }

  const effective = changes.filter((c) => {
    const mine = rows.filter((r) => r.producer_id === c.producer_id);
    return !(mine.length === c.booth_ids.length && mine.every((r) => c.booth_ids.includes(r.booth_id)));
  });
  if (effective.length === 0) return { ok: true, changed: 0, target_date_id: targetId };

  if (cycle.state.approved_at) {
    const targetSnap = mode === 'opener' ? null : await db.collection('market_dates').doc(targetId).get();
    const target = mode === 'opener' ? date : targetSnap?.exists ? marketDateFromData(targetSnap.id, targetSnap.data() as Record<string, unknown>) : null;
    if (target && target.start_at.getTime() <= now.getTime()) {
      return { ok: false, status: 409, code: 'target_started', error: 'That market has already started; its booth assignments can no longer be changed' };
    }
    const changed = new Set(effective.map((c) => c.producer_id));
    const after = [
      ...rows.filter((r) => !changed.has(r.producer_id)).map((r) => ({ booth_id: r.booth_id, producer_id: r.producer_id })),
      ...effective.flatMap((c) => c.booth_ids.map((booth_id) => ({ booth_id, producer_id: c.producer_id }))),
    ];
    const before = producersByBooth(rows);
    for (const [boothId, producers] of producersByBooth(after)) {
      if (producers.size < 2) continue;
      const was = before.get(boothId) ?? new Set<string>();
      if ([...producers].every((id) => was.has(id))) continue; // a double booking that was already there is not made worse
      const movers = new Set(effective.filter((c) => c.booth_ids.includes(boothId)).map((c) => c.producer_id));
      const stayers = [...producers].filter((id) => !movers.has(id));
      const others = (stayers.length > 0 ? stayers : [...producers]).map((id) => attendance.names.get(id) || id);
      const label = boothById.get(boothId)?.label ?? boothId;
      return {
        ok: false,
        status: 409,
        code: 'conflict',
        booth_id: boothId,
        booth_label: label,
        error: `Booth ${label} is assigned to ${others.join(' and ')}. These assignments are approved: move that vendor in the same change`,
      };
    }
  }

  // A fresh token BEFORE the rows move and another AFTER (see the file comment): a booth-text pass that
  // overlaps this change - or a change that dies half-way - always finds `assignments_rev` different from
  // the token it recorded, so the next engine tick looks again. Never a timestamp comparison.
  await ref.update({ [at('assignments_rev')]: revToken(), updated_at: now });

  for (const c of effective) {
    const mine = rows.filter((r) => r.producer_id === c.producer_id);
    const fresh = c.booth_ids.map((boothId) => ({
      id: uuid(),
      market_id: market.id,
      market_date_id: targetId,
      source_date_id: date.id,
      booth_id: boothId,
      producer_id: c.producer_id,
      source: 'manual' as const,
      assigned_by: actor,
      assigned_at: now,
      superseded_by: null,
      superseded_at: null,
    }));
    for (const old of mine) {
      await db.collection('booth_assignments').doc(old.id).update({ superseded_by: fresh[0]?.id ?? 'unassigned', superseded_at: now });
    }
    for (const r of fresh) await db.collection('booth_assignments').doc(r.id).set(r);
  }

  const after = await currentAssignments(db, targetId);
  await ref.update({
    [at('booth_summary')]: computeBoothSummary(
      booths,
      seatedVendors(attendance, after, mode).attending.map((v) => v.producer_id),
      after,
    ),
    [at('assignments_rev')]: revToken(),
    updated_at: now,
  });
  return { ok: true, changed: effective.length, target_date_id: targetId };
}

// ─── Booth texts: what each vendor has been told, and what is owed ────────

/** A `messages` row of kind `booth` for a target date, as the booth-text step reads it. */
export interface BoothTextLogEntry {
  id: string;
  producer_id: string;
  to: string;
  /** queued | sent | simulated | failed */
  status: string;
  created_at: Date;
  /** Per-vendor send order (1, 2, ...): the tie-break when two texts share a `created_at`. */
  seq: number;
  type: 'assignment' | 'release';
  /** The assignment row this text is about: the newest current row for an assignment text, the assignment being released for a release. */
  assignment_id: string | null;
  booth_ids: string[];
  booth_labels: string[];
}

const TEXT_DELIVERED = new Set(['queued', 'sent', 'simulated']);

/** Every booth text logged for a target date, oldest first. One equality filter. */
export async function loadBoothTextLog(db: Firestore, targetDateId: string): Promise<BoothTextLogEntry[]> {
  const snap = await db.collection('messages').where('market_date_id', '==', targetDateId).get();
  const out: BoothTextLogEntry[] = [];
  for (const d of snap.docs) {
    const m = d.data() as Record<string, unknown>;
    if (m.kind !== 'booth' || typeof m.producer_id !== 'string') continue;
    out.push({
      id: d.id,
      producer_id: m.producer_id,
      to: String(m.to ?? ''),
      status: String(m.status ?? ''),
      created_at: toDateOrEpoch(m.created_at),
      seq: typeof m.seq === 'number' ? m.seq : 0,
      type: m.booth_text === 'release' ? 'release' : 'assignment',
      assignment_id: typeof m.assignment_id === 'string' ? m.assignment_id : null,
      booth_ids: Array.isArray(m.booth_ids) ? m.booth_ids.map(String) : [],
      booth_labels: Array.isArray(m.booth_labels) ? m.booth_labels.map(String) : [],
    });
  }
  return out.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.seq - b.seq || a.id.localeCompare(b.id));
}

export interface BoothTextItem {
  producer_id: string;
  /** `assignment`: "your booth is ...". `release`: the vendor was told a booth and now holds none. */
  type: 'assignment' | 'release';
  /**
   * What the at-most-once key is built on: the id of the vendor's NEWEST current
   * assignment row (so a changed assignment is a new text and an unchanged one
   * never is), or, for a release, the assignment the vendor was last told.
   */
  assignment_id: string;
  booth_ids: string[];
  booth_labels: string[];
  /**
   * `sent`: the vendor has been told exactly this. `queued`: a text for it is in
   * flight (or died in flight). `failed`: it was tried and the provider refused -
   * the engine does not retry, staff resend. `owed`: nothing in the log; the
   * booth-text step sends it.
   */
  state: 'sent' | 'queued' | 'failed' | 'owed';
  /** The vendor was told something else for this date before; the text says "is now". */
  changed: boolean;
  /** The log entry `state` was read from (null when `owed`). */
  last: BoothTextLogEntry | null;
  /** `seq` for the next text to this vendor. */
  seq: number;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Pure: for every vendor who holds a booth on the target date, or was told one
 * and no longer does, the one text that reflects the CURRENT assignments and
 * whether the log already has it. The engine sends the `owed` ones (each under
 * a key built on `assignment_id`, so no assignment is ever texted twice); the
 * staff view shows the rest.
 *
 * A vendor whose booths were changed and then changed back before anything was
 * sent is `sent` (the last thing they were told is still true). A vendor removed
 * before ever being texted gets nothing.
 */
export function planBoothTexts(input: {
  rows: Pick<BoothAssignmentDoc, 'id' | 'producer_id' | 'booth_id' | 'assigned_at'>[];
  booths: BoothDoc[];
  log: BoothTextLogEntry[];
}): BoothTextItem[] {
  type Row = (typeof input.rows)[number];
  const boothById = new Map(input.booths.map((b) => [b.id, b]));
  const rowsBy = new Map<string, Row[]>();
  for (const r of input.rows) {
    if (!boothById.has(r.booth_id)) continue;
    rowsBy.set(r.producer_id, [...(rowsBy.get(r.producer_id) ?? []), r]);
  }
  const logBy = new Map<string, BoothTextLogEntry[]>();
  for (const e of input.log) logBy.set(e.producer_id, [...(logBy.get(e.producer_id) ?? []), e]);

  const items: BoothTextItem[] = [];
  for (const producerId of [...new Set([...rowsBy.keys(), ...logBy.keys()])].sort()) {
    const mine = logBy.get(producerId) ?? [];
    const delivered = mine.filter((e) => TEXT_DELIVERED.has(e.status));
    const lastTold = delivered[delivered.length - 1] ?? null;
    const seq = mine.reduce((n, e) => Math.max(n, e.seq), mine.length) + 1;
    const myRows = rowsBy.get(producerId) ?? [];

    if (myRows.length > 0) {
      const held = myRows.map((r) => boothById.get(r.booth_id)!).sort(compareBooths);
      const boothIds = held.map((b) => b.id);
      const newest = [...myRows].sort((a, b) => a.assigned_at.getTime() - b.assigned_at.getTime() || a.id.localeCompare(b.id))[myRows.length - 1]!;
      const same = mine.filter((e) => e.type === 'assignment' && e.assignment_id === newest.id);
      const sameDelivered = same.filter((e) => TEXT_DELIVERED.has(e.status));
      const stillTrue = lastTold && lastTold.type === 'assignment' && sameIds(lastTold.booth_ids, boothIds) ? lastTold : null;
      const told = sameDelivered.filter((e) => e.status !== 'queued').pop() ?? sameDelivered[sameDelivered.length - 1] ?? stillTrue;
      items.push({
        producer_id: producerId,
        type: 'assignment',
        assignment_id: newest.id,
        booth_ids: boothIds,
        booth_labels: held.map((b) => b.label),
        state: told ? (told.status === 'queued' ? 'queued' : 'sent') : same.length > 0 ? 'failed' : 'owed',
        changed: !!lastTold && !stillTrue,
        last: told ?? same[same.length - 1] ?? null,
        seq,
      });
      continue;
    }

    // No booth now. A vendor who was never told one has nothing to be told.
    if (!lastTold) continue;
    if (lastTold.type === 'release') {
      // Already told (or being told) that the booth is gone.
      items.push({
        producer_id: producerId,
        type: 'release',
        assignment_id: lastTold.assignment_id ?? 'unknown',
        booth_ids: [],
        booth_labels: lastTold.booth_labels,
        state: lastTold.status === 'queued' ? 'queued' : 'sent',
        changed: true,
        last: lastTold,
        seq,
      });
      continue;
    }
    // Told a booth and holds none now: one release notice, keyed on the assignment being released.
    // (A delivered release would be `lastTold`, so whatever is logged for this key failed.)
    const releasedId = lastTold.assignment_id ?? 'unknown';
    const tried = mine.filter((e) => e.type === 'release' && e.assignment_id === releasedId);
    items.push({
      producer_id: producerId,
      type: 'release',
      assignment_id: releasedId,
      booth_ids: [],
      booth_labels: lastTold.booth_labels,
      state: tried.length > 0 ? 'failed' : 'owed',
      changed: true,
      last: tried[tried.length - 1] ?? null,
      seq,
    });
  }
  return items;
}

// ─── The staff view ──────────────────────────────────────────────────────

/**
 * What staff see per vendor:
 *   `none`     not approved yet, nothing is sent;
 *   `pending`  the engine will send it (next tick, or when quiet hours end);
 *   `sent`     the vendor has been told exactly what they hold now;
 *   `failed`   the provider refused it - the engine does not retry, staff resend;
 *   `blocked`  owed, but the texts are held (`booth_texts_blocked` says why);
 *   `excluded` owed, but the vendor cannot be texted (`reason`);
 *   `skipped`  the vendor could not be texted when the texts went out and can be now - resend.
 */
export type BoothTextStatus = 'none' | 'pending' | 'sent' | 'failed' | 'blocked' | 'excluded' | 'skipped';

export interface BoothTextRow {
  producer_id: string;
  business_name: string;
  type: 'assignment' | 'release';
  booth_labels: string[];
  status: BoothTextStatus;
  /** Why an `excluded` vendor cannot be texted (`no_phone`, `opted_out`, ...). */
  reason: string | null;
  last_message: { id: string; status: string; created_at: Date } | null;
  /** The resend button: approved, nothing holding the texts back, a textable vendor, and not already on its way. */
  can_resend: boolean;
}

/** Who can be texted right now, from `listRecipients` (the caller passes it in: this module does not import the engine). */
export interface Textability {
  recipients: Set<string>;
  /** producer id → why not (`no_phone` | `invalid_phone` | `opted_out` | `inactive_producer`). */
  excluded: Map<string, string>;
}

export interface AssignmentsView {
  /** `next`: this date's check-ins assign the next market. `opener`: the season's first market date assigns itself. */
  cycle: CycleMode;
  /**
   * False while a `next` cycle cannot be drafted yet: its own market has not
   * ended, so the check-ins that decide the next market do not exist. Always
   * true for an opener (it is drafted ahead of its market).
   */
  draft_open: boolean;
  target_date: { id: string; date: string; date_label: string; start_at: Date } | null;
  /** Booth texts stop for a cancelled or started target; changes after approval stop once it has started. */
  target_cancelled: boolean;
  target_started: boolean;
  season: string;
  drafted_at: Date | null;
  assignments_draft_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
  booth_texts_sent_at: Date | null;
  /** When the owed booth texts go out: the end of quiet hours, or `now` (the next engine tick). Null when none are owed or they are blocked. */
  booth_texts_due_at: Date | null;
  /** The owed texts would only be allowed out once the market has started, so they will never be sent: call those vendors. */
  booth_texts_too_late: boolean;
  /** Why owed booth texts are being held back right now, judged live; null when nothing is held. */
  booth_texts_blocked: BoothTextsBlocked | null;
  drafts_skipped: DraftSkipReason | null;
  booths: {
    booth: BoothDoc;
    assignment: { id: string; producer_id: string; business_name: string; source: AssignmentSource; assigned_by: string; assigned_at: Date } | null;
  }[];
  attending: {
    producer_id: string;
    business_name: string;
    spaces: 1 | 2;
    electric: boolean;
    booth_kind: BoothKind;
    fee_plan: FeePlan;
    usual_booth_id: string | null;
    booth_ids: string[];
    /** Not on the cycle's own list (no "attending" check-in; daily plan on an opener): staff placed them by hand. */
    added_by_staff: boolean;
  }[];
  /** Current-season vendors who are not on the list and whom staff may place by hand. */
  can_add: { producer_id: string; business_name: string; spaces: 1 | 2; electric: boolean; booth_kind: BoothKind; fee_plan: FeePlan; reason: CanAddReason }[];
  /** Vendors on the list with no booth, or a two-space vendor holding one (`no_pair`). */
  unassigned: { producer_id: string; business_name: string; reason: ViewUnassignedReason }[];
  /** `power_mismatch`: a vendor who needs electricity holds no powered stall. */
  warnings: { producer_id: string; business_name: string; reason: 'power_mismatch'; booth_ids: string[] }[];
  not_attending: { producer_id: string; business_name: string }[];
  no_answer: { producer_id: string; business_name: string }[];
  summary: BoothSummary & { conflicts: number };
  /** Booth ids held by more than one vendor. */
  conflict_booth_ids: string[];
  /** The same double bookings, with every vendor on each booth (the booth grid can only show one). */
  conflicts: { booth_id: string; booth_label: string; producers: { producer_id: string; business_name: string }[] }[];
  /** One row per vendor who holds a booth (or was told one and lost it): what they have been told. */
  texts: BoothTextRow[];
  text_counts: Record<Exclude<BoothTextStatus, 'none'>, number>;
  /** Every booth text logged for the target date, newest first. */
  messages: { id: string; producer_id: string | null; to: string; status: string; created_at: Date; type: 'assignment' | 'release'; booth_labels: string[] }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS: Record<string, string> = {
  sunday: 'Sunday',
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
};

/** 'YYYY-MM-DD' → 'Saturday, Sep 19, 2026' (calendar-date formatting, zone-independent). */
export function longDateLabel(date: string): string {
  const { y, m, d } = parseDate(date);
  const wd = weekdayOf(date);
  if (!DAYS_OF_WEEK.includes(wd)) return date;
  return `${WEEKDAY_LABELS[wd]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Why a vendor on the list has no (or too few) booths, judged against the booths
 * still free. `not_placed`: a booth that would suit them IS free - nothing has
 * been drafted yet, or staff took their booth away - so it is not a shortage.
 */
export type ViewUnassignedReason = UnassignedReason | 'not_placed';

function explainUnassigned(v: VendorInfo, held: number, freeBooths: BoothDoc[]): ViewUnassignedReason {
  if (v.booth_kind === 'food_truck') return freeBooths.some((b) => b.kind === 'food_truck') ? 'not_placed' : 'no_food_truck_slot';
  if (held > 0) return 'no_pair'; // a two-space vendor with one booth: the second space is what is missing
  const stalls = freeBooths.filter((b) => b.kind === 'stall');
  if (stalls.length === 0) return 'full';
  if (v.spaces === 2) {
    const hasPair = stalls.some((a) => stalls.some((b) => b.row === a.row && b.order === a.order + 1 && (!v.electric || (a.power && b.power))));
    return hasPair ? 'not_placed' : 'no_pair';
  }
  if (v.electric && !stalls.some((b) => b.power)) return 'no_power_stall';
  return 'not_placed';
}

/** A `queued` row older than this never got the provider's answer: staff see it as failed and can resend. */
export const QUEUED_STALE_MS = 10 * 60_000;

/**
 * When owed booth texts may go out: never before quiet hours end, counted from
 * the approval and from `now` (so a retry or a corrective text at 22:30 waits
 * for the morning too). Equal to `now` when they may go at once.
 */
export function boothTextsAllowedAt(approvedAt: Date, now: Date, market: Pick<FarmersMarket, 'quiet_hours' | 'timezone'>): Date {
  const quiet = market.quiet_hours ?? DEFAULT_QUIET_HOURS;
  const earliest = nextAllowedInstant(approvedAt, quiet, market.timezone);
  return earliest.getTime() > now.getTime() ? earliest : nextAllowedInstant(now, quiet, market.timezone);
}

/** The market date a cycle's booths are for: the opener itself, else the recorded target, else (before any draft) the next date. */
export async function loadCycleTarget(db: Firestore, market: FarmersMarket, cycle: AssignmentCycle): Promise<MarketDateDoc | null> {
  if (cycle.mode === 'opener') return cycle.date;
  const targetId = cycle.state.assignments_target_date_id;
  if (targetId) {
    const doc = await db.collection('market_dates').doc(targetId).get();
    if (doc.exists) return marketDateFromData(doc.id, doc.data() as Record<string, unknown>);
  }
  return nextTargetOf(db, market, cycle.date);
}

/**
 * Why approved booth texts cannot go out for this target right now (`conflict`
 * is judged from the rows). `started` comes first and is final: once the
 * target's start time has passed nothing will ever be sent, whether the market
 * took place or was cancelled (a past date cannot be un-cancelled), so the
 * engine stops looking. `cancelled` is a target still ahead - it can come back.
 */
export function boothTextsHold(target: Pick<MarketDateDoc, 'status' | 'start_at'> | null, conflicts: number, now: Date): BoothTextsBlocked | null {
  if (target && target.start_at.getTime() <= now.getTime()) return 'started';
  if (target && target.status === 'cancelled') return 'cancelled';
  return conflicts > 0 ? 'conflict' : null;
}

export async function buildAssignmentsView(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  now: Date,
  opts: { cycle?: CycleMode; textable?: Textability } = {},
): Promise<AssignmentsView> {
  const cycle = cycleOf(date, opts.cycle ?? 'next');
  const s = cycle.state;
  const attendance = await loadAttendance(db, market, date, now, cycle.mode);
  const season = attendance.season || currentSeason(market, now);
  const target = await loadCycleTarget(db, market, cycle);

  const rows = target ? await currentAssignments(db, target.id) : [];
  const allBooths = await listBooths(db, market.id, { includeInactive: true });
  const boothById = new Map(allBooths.map((b) => [b.id, b]));
  const seatedBoothIds = new Set(rows.map((r) => r.booth_id));
  const shownBooths = allBooths.filter((b) => b.active || seatedBoothIds.has(b.id));
  const activeBooths = allBooths.filter((b) => b.active);
  const nameOf = (id: string) => attendance.names.get(id) ?? id;

  const boothRows = shownBooths.map((booth) => {
    const a = rows.find((r) => r.booth_id === booth.id);
    return {
      booth,
      assignment: a
        ? { id: a.id, producer_id: a.producer_id, business_name: nameOf(a.producer_id), source: a.source, assigned_by: a.assigned_by, assigned_at: a.assigned_at }
        : null,
    };
  });

  const boothsOf = (producerId: string) =>
    rows
      .filter((r) => r.producer_id === producerId)
      .map((r) => boothById.get(r.booth_id))
      .filter((b): b is BoothDoc => !!b)
      .sort(compareBooths);

  const seated = seatedVendors(attendance, rows, cycle.mode);
  const holders = new Set(rows.map((r) => r.producer_id));
  const freeBooths = activeBooths.filter((b) => !seatedBoothIds.has(b.id));
  const attending = seated.attending.map((v) => ({
    producer_id: v.producer_id,
    business_name: v.business_name,
    spaces: v.spaces,
    electric: v.electric,
    booth_kind: v.booth_kind,
    fee_plan: v.fee_plan,
    usual_booth_id: v.usual_booth_id,
    booth_ids: boothsOf(v.producer_id).map((b) => b.id),
    added_by_staff: v.added_by_staff,
  }));
  const unassigned = seated.attending
    .map((v) => ({ v, held: boothsOf(v.producer_id).length }))
    .filter(({ v, held }) => held === 0 || (v.booth_kind === 'stall' && v.spaces === 2 && held < 2))
    .map(({ v, held }) => ({ producer_id: v.producer_id, business_name: v.business_name, reason: explainUnassigned(v, held, freeBooths) }));
  const warnings = seated.attending
    .filter((v) => {
      const held = boothsOf(v.producer_id);
      return v.electric && v.booth_kind === 'stall' && held.length > 0 && !held.some((b) => b.power);
    })
    .map((v) => ({
      producer_id: v.producer_id,
      business_name: v.business_name,
      reason: 'power_mismatch' as const,
      booth_ids: boothsOf(v.producer_id).map((b) => b.id),
    }));

  const summary = computeBoothSummary(
    activeBooths,
    seated.attending.map((v) => v.producer_id),
    rows,
  );
  const conflictIds = conflictedBoothIds(rows);

  // ── Booth texts: per vendor, what they have been told about the assignments as they stand ──
  const log = target ? await loadBoothTextLog(db, target.id) : [];
  const plan = planBoothTexts({ rows, booths: allBooths, log });
  const approvedAt = s.approved_at;
  const targetCancelled = !!target && target.status === 'cancelled';
  const targetStarted = !!target && target.start_at.getTime() <= now.getTime();
  const held = approvedAt ? boothTextsHold(target, conflictIds.length, now) : null;
  const engineWillSend = !!approvedAt && !held && !boothTextsSettled(s);
  const canText = (id: string) => !opts.textable || opts.textable.recipients.has(id);

  const texts: BoothTextRow[] = plan.map((p) => {
    const textable = canText(p.producer_id);
    let status: BoothTextStatus;
    if (!approvedAt) status = 'none';
    else if (p.state === 'sent') status = 'sent';
    else if (p.state === 'failed') status = 'failed';
    else if (p.state === 'queued') status = p.last && now.getTime() - p.last.created_at.getTime() > QUEUED_STALE_MS ? 'failed' : 'pending';
    else if (!textable) status = 'excluded';
    else if (held) status = 'blocked';
    else status = engineWillSend ? 'pending' : 'skipped';
    return {
      producer_id: p.producer_id,
      business_name: nameOf(p.producer_id),
      type: p.type,
      booth_labels: p.booth_labels,
      status,
      reason: status === 'excluded' ? (opts.textable?.excluded.get(p.producer_id) ?? 'not_a_current_vendor') : null,
      last_message: p.last ? { id: p.last.id, status: p.last.status, created_at: p.last.created_at } : null,
      can_resend: !!approvedAt && !held && textable && (status === 'sent' || status === 'failed' || status === 'skipped'),
    };
  });
  texts.sort((a, b) => a.business_name.localeCompare(b.business_name) || a.producer_id.localeCompare(b.producer_id));
  const text_counts = { pending: 0, sent: 0, failed: 0, blocked: 0, excluded: 0, skipped: 0 };
  for (const t of texts) if (t.status !== 'none') text_counts[t.status] += 1;

  // "Owed" for the banner: the first pass has not gone out, or a vendor who can be texted has not been told.
  const somethingOwed = !!approvedAt && (!s.booth_texts_sent_at || plan.some((p) => p.state === 'owed' && canText(p.producer_id)));
  const dueAt = approvedAt && engineWillSend && somethingOwed ? boothTextsAllowedAt(approvedAt, now, market) : null;

  const messages: AssignmentsView['messages'] = log
    .map((m) => ({ id: m.id, producer_id: m.producer_id, to: m.to, status: m.status, created_at: m.created_at, type: m.type, booth_labels: m.booth_labels }))
    .reverse();

  const withoutBooth = (v: VendorInfo) => !holders.has(v.producer_id);
  return {
    cycle: cycle.mode,
    draft_open: cycle.mode === 'opener' || date.end_at.getTime() <= now.getTime(),
    target_date: target ? { id: target.id, date: target.date, date_label: longDateLabel(target.date), start_at: target.start_at } : null,
    target_cancelled: targetCancelled,
    target_started: targetStarted,
    season,
    drafted_at: s.drafts_generated_at,
    assignments_draft_at: s.assignments_draft_at,
    approved_at: approvedAt,
    approved_by: s.approved_by,
    booth_texts_sent_at: s.booth_texts_sent_at,
    booth_texts_due_at: dueAt,
    booth_texts_too_late: !!dueAt && !!target && dueAt.getTime() >= target.start_at.getTime(),
    booth_texts_blocked: held && somethingOwed ? held : null,
    drafts_skipped: s.drafts_skipped,
    booths: boothRows,
    attending,
    can_add: seated.can_add.map((v) => ({
      producer_id: v.producer_id,
      business_name: v.business_name,
      spaces: v.spaces,
      electric: v.electric,
      booth_kind: v.booth_kind,
      fee_plan: v.fee_plan,
      reason: v.reason,
    })),
    unassigned,
    warnings,
    not_attending: attendance.not_attending.filter(withoutBooth).map((v) => ({ producer_id: v.producer_id, business_name: v.business_name })),
    no_answer: attendance.no_answer.filter(withoutBooth).map((v) => ({ producer_id: v.producer_id, business_name: v.business_name })),
    summary: { ...summary, conflicts: conflictIds.length },
    conflict_booth_ids: conflictIds,
    conflicts: conflictIds.map((boothId) => ({
      booth_id: boothId,
      booth_label: boothById.get(boothId)?.label ?? boothId,
      producers: [...new Set(rows.filter((r) => r.booth_id === boothId).map((r) => r.producer_id))]
        .map((id) => ({ producer_id: id, business_name: nameOf(id) }))
        .sort((a, b) => a.business_name.localeCompare(b.business_name) || a.producer_id.localeCompare(b.producer_id)),
    })),
    texts,
    text_counts,
    messages,
  };
}
