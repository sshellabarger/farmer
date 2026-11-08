import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { nextAllowedInstant } from '../utils/quiet-hours.js';
import { parseDate, weekdayOf, DAYS_OF_WEEK } from '../utils/tz.js';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import type { AssignmentSource, BoothKind, DraftSkipReason } from '../types/schema.js';
import { marketDateFromData } from './market-dates.js';
import type { MarketDateDoc } from './market-dates.js';
import { DEFAULT_QUIET_HOURS } from './markets.js';
import type { FarmersMarket } from './markets.js';
import { compareBooths, listBooths } from './booths.js';
import type { BoothDoc } from './booths.js';
import { currentSeason, isVendorOfRecord, listCurrentMemberships } from './seasons.js';

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
 */

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
}

/**
 * Deterministic booth plan. Booths are taken in (row, order). Pass 1 seats
 * vendors in their usual booth (a two-space vendor also takes the free
 * same-row neighbour at order + 1, else order - 1). Pass 2 seats everyone else:
 * food-truck vendors first, then electric, then two-space, then by name; powered
 * stalls are kept for vendors who need electricity.
 */
export function planAssignments(input: PlanInput): PlanResult {
  const booths = input.booths.filter((b) => b.active).sort(compareBooths);
  const byId = new Map(booths.map((b) => [b.id, b]));
  const taken = new Set(input.fixed.map((f) => f.booth_id));
  const isFree = (b: BoothDoc) => !taken.has(b.id);

  const placed: PlanResult['placed'] = [];
  const unassigned: PlanResult['unassigned'] = [];
  const seated = new Set<string>();

  const freeStalls = () => booths.filter((b) => b.kind === 'stall' && isFree(b));
  const neighbour = (b: BoothDoc, delta: 1 | -1, needPower: boolean) =>
    booths.find((x) => x.kind === 'stall' && x.row === b.row && x.order === b.order + delta && isFree(x) && (!needPower || x.power));
  const take = (...ids: string[]) => ids.forEach((id) => taken.add(id));

  // Pass 1 — usual booths.
  const usual = input.vendors
    .map((v) => ({ v, booth: v.usual_booth_id ? byId.get(v.usual_booth_id) : undefined }))
    .filter((x): x is { v: PlanVendor; booth: BoothDoc } => !!x.booth && x.booth.kind === x.v.booth_kind)
    .sort((a, b) => compareBooths(a.booth, b.booth) || a.v.business_name.localeCompare(b.v.business_name) || a.v.producer_id.localeCompare(b.v.producer_id));
  for (const { v, booth } of usual) {
    if (!isFree(booth)) continue;
    const stall = v.booth_kind === 'stall';
    if (stall && v.electric && !booth.power) continue;
    take(booth.id);
    let boothIds = [booth.id];
    if (stall && v.spaces === 2) {
      const pair = neighbour(booth, 1, v.electric) ?? neighbour(booth, -1, v.electric);
      if (pair) {
        take(pair.id);
        boothIds = [booth, pair].sort(compareBooths).map((b) => b.id);
      } else {
        unassigned.push({ producer_id: v.producer_id, reason: 'no_pair' });
      }
    }
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

  return { placed, unassigned };
}

// ─── Who is attending ────────────────────────────────────────────────────

export interface VendorInfo extends PlanVendor {
  membership_id: string;
}

export interface Attendance {
  season: string;
  /** Every active current-season vendor of the market whose producer is active. */
  vendors: VendorInfo[];
  attending: VendorInfo[];
  not_attending: VendorInfo[];
  no_answer: VendorInfo[];
  /** Business names of every producer, for labelling assignments of vendors who have since left the rotation. */
  names: Map<string, string>;
}

/**
 * The vendors of the market's current season and what they answered on the
 * collecting date `source`. `attending_next === true` means "attending the next
 * market after `source`" (contract §2.10).
 */
export async function loadAttendance(db: Firestore, market: FarmersMarket, source: MarketDateDoc, now: Date): Promise<Attendance> {
  const { season, memberships } = await listCurrentMemberships(db, market, now);
  const producersSnap = await db.collection('producers').get();
  const producers = new Map<string, Record<string, unknown>>();
  const names = new Map<string, string>();
  for (const d of producersSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    producers.set(d.id, data);
    names.set(d.id, String(data.business_name ?? ''));
  }
  const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', source.id).get();
  const answer = new Map<string, boolean | null>();
  for (const d of checkinsSnap.docs) {
    const c = d.data() as Record<string, unknown>;
    answer.set(String(c.producer_id ?? ''), typeof c.attending_next === 'boolean' ? c.attending_next : null);
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
    });
  }
  vendors.sort((a, b) => a.business_name.localeCompare(b.business_name) || a.producer_id.localeCompare(b.producer_id));
  return {
    season,
    vendors,
    attending: vendors.filter((v) => answer.get(v.producer_id) === true),
    not_attending: vendors.filter((v) => answer.get(v.producer_id) === false),
    no_answer: vendors.filter((v) => !answer.has(v.producer_id) || answer.get(v.producer_id) === null),
    names,
  };
}

/** The earliest non-cancelled date of the market after `date.date`, or null. */
export async function nextDateAfter(db: Firestore, market: Pick<FarmersMarket, 'id'>, date: Pick<MarketDateDoc, 'date'>): Promise<MarketDateDoc | null> {
  const snap = await db.collection('market_dates').where('market_id', '==', market.id).get();
  const later = snap.docs
    .map((d) => marketDateFromData(d.id, d.data() as Record<string, unknown>))
    .filter((d) => d.status !== 'cancelled' && d.date > date.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return later[0] ?? null;
}

// ─── Summary and conflicts ───────────────────────────────────────────────

export interface BoothSummary {
  assigned: number;
  unassigned: number;
  booths_total: number;
  booths_free: number;
}

/** Booth ids held by more than one producer. */
export function conflictedBoothIds(rows: Pick<BoothAssignmentDoc, 'booth_id' | 'producer_id'>[]): string[] {
  const byBooth = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byBooth.get(r.booth_id) ?? new Set<string>();
    set.add(r.producer_id);
    byBooth.set(r.booth_id, set);
  }
  return [...byBooth.entries()].filter(([, s]) => s.size > 1).map(([id]) => id).sort();
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

export type PreparedDraft =
  | { skipped: DraftSkipReason; target: MarketDateDoc | null }
  | { skipped: null; target: MarketDateDoc; booths: BoothDoc[]; attendance: Attendance };

/**
 * Everything a draft needs, or the reason there is nothing to draft. Pure reads:
 * the manual route calls it before taking any lock so a refusal never leaves one
 * behind.
 */
export async function prepareDraft(db: Firestore, market: FarmersMarket, date: MarketDateDoc, now: Date): Promise<PreparedDraft> {
  const target = await nextDateAfter(db, market, date);
  if (!target) return { skipped: 'no_next_date', target: null };
  const booths = await listBooths(db, market.id);
  if (booths.length === 0) return { skipped: 'no_booths', target };
  const attendance = await loadAttendance(db, market, date, now);
  if (attendance.attending.length === 0) return { skipped: 'no_attendees', target };
  return { skipped: null, target, booths, attendance };
}

export interface DraftResult {
  skipped: DraftSkipReason | null;
  target_date_id: string | null;
  vendors_placed: number;
  vendors_unassigned: number;
  rows_written: number;
  superseded: number;
}

const EMPTY_DRAFT: DraftResult = { skipped: null, target_date_id: null, vendors_placed: 0, vendors_unassigned: 0, rows_written: 0, superseded: 0 };

/**
 * Drafts the booth assignments for the market date after `date` (contract
 * §3.5). Callers hold the step lock (`drafts` for the first draft, a
 * per-version `redraft_*` lock afterwards), so this never races itself.
 *
 *  - `initial`: the engine's first draft (or the first manual one).
 *  - `redraft`: before approval only — supersedes every current non-manual row of
 *    the target date, keeps manual rows as fixed, re-plans around them.
 *
 * `record_skip` (the engine) writes `actions.drafts_skipped` and
 * `actions.drafts_generated_at` when there is nothing to draft, so the step does
 * not loop; a manual draft returns the skip reason and writes nothing. Writes
 * `actions` field paths only, never the map.
 */
export async function draftAssignments(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  opts: { now: Date; actor: string; mode: 'initial' | 'redraft'; record_skip?: boolean },
): Promise<DraftResult> {
  const { now } = opts;
  const ref = db.collection('market_dates').doc(date.id);

  const prepared = await prepareDraft(db, market, date, now);
  if (prepared.skipped) {
    if (opts.record_skip) {
      const update: Record<string, unknown> = { 'actions.drafts_skipped': prepared.skipped, updated_at: now };
      if (opts.mode === 'initial') update['actions.drafts_generated_at'] = now;
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

  const summary = computeBoothSummary(
    booths,
    attendance.attending.map((v) => v.producer_id),
    [...kept, ...newRows],
  );
  const update: Record<string, unknown> = {
    'actions.assignments_draft_at': now,
    'actions.assignments_target_date_id': target.id,
    'actions.drafts_skipped': null,
    'actions.booth_summary': summary,
    updated_at: now,
  };
  if (opts.mode === 'initial' || !date.actions.drafts_generated_at) update['actions.drafts_generated_at'] = now;
  await ref.update(update);

  return {
    skipped: null,
    target_date_id: target.id,
    vendors_placed: plan.placed.length,
    vendors_unassigned: plan.unassigned.filter((u) => !plan.placed.some((p) => p.producer_id === u.producer_id)).length,
    rows_written: newRows.length,
    superseded: replaced.length,
  };
}

// ─── Manual changes ──────────────────────────────────────────────────────

export type ChangeResult = { ok: true; changed: number; target_date_id: string } | { ok: false; status: 400 | 409; error: string };

/**
 * Applies staff changes to the draft: per producer, the full set of booths they
 * should hold (0 = unassign). Validates everything before writing anything. The
 * superseded rows stay as history; the new ones are `manual`. A booth another
 * vendor still holds is allowed (so a swap can be made in one request, or in two)
 * and shows up as a conflict that blocks approval until it is resolved.
 */
export async function applyAssignmentChanges(
  db: Firestore,
  market: FarmersMarket,
  date: MarketDateDoc,
  changes: { producer_id: string; booth_ids: string[] }[],
  actor: string,
  now: Date,
): Promise<ChangeResult> {
  const targetId = date.actions.assignments_target_date_id;
  if (!targetId) return { ok: false, status: 409, error: 'There is no draft to change yet' };

  const seenProducers = new Set<string>();
  for (const c of changes) {
    if (seenProducers.has(c.producer_id)) return { ok: false, status: 400, error: 'A producer appears more than once in changes' };
    seenProducers.add(c.producer_id);
    if (new Set(c.booth_ids).size !== c.booth_ids.length) return { ok: false, status: 400, error: 'A booth appears more than once for a producer' };
  }

  const booths = await listBooths(db, market.id);
  const boothById = new Map(booths.map((b) => [b.id, b]));
  const attendance = await loadAttendance(db, market, date, now);
  const attendingIds = new Set(attendance.attending.map((v) => v.producer_id));

  for (const c of changes) {
    if (!attendingIds.has(c.producer_id)) return { ok: false, status: 400, error: 'That producer is not attending the next market' };
    for (const id of c.booth_ids) {
      if (!boothById.has(id)) return { ok: false, status: 400, error: 'Unknown or inactive booth' };
    }
  }

  const rows = await currentAssignments(db, targetId);
  let changed = 0;
  for (const c of changes) {
    const mine = rows.filter((r) => r.producer_id === c.producer_id);
    const sameSet = mine.length === c.booth_ids.length && mine.every((r) => c.booth_ids.includes(r.booth_id));
    if (sameSet) continue;
    changed++;
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
  await db
    .collection('market_dates')
    .doc(date.id)
    .update({
      'actions.booth_summary': computeBoothSummary(booths, attendance.attending.map((v) => v.producer_id), after),
      updated_at: now,
    });
  return { ok: true, changed, target_date_id: targetId };
}

// ─── The staff view ──────────────────────────────────────────────────────

export interface AssignmentsView {
  target_date: { id: string; date: string; date_label: string } | null;
  season: string;
  drafted_at: Date | null;
  assignments_draft_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
  booth_texts_sent_at: Date | null;
  booth_texts_due_at: Date | null;
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
    usual_booth_id: string | null;
    booth_ids: string[];
  }[];
  unassigned: { producer_id: string; business_name: string; reason: UnassignedReason }[];
  not_attending: { producer_id: string; business_name: string }[];
  no_answer: { producer_id: string; business_name: string }[];
  summary: BoothSummary & { conflicts: number };
  messages: { id: string; producer_id: string | null; to: string; status: string; created_at: Date }[];
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

/** Why a vendor with no (or too few) booths is unplaced, judged against the booths still free. */
function explainUnassigned(v: VendorInfo, freeBooths: BoothDoc[]): UnassignedReason {
  if (v.booth_kind === 'food_truck') return 'no_food_truck_slot';
  const stalls = freeBooths.filter((b) => b.kind === 'stall');
  if (stalls.length === 0) return 'full';
  if (v.spaces === 2) {
    const hasPair = stalls.some((a) => stalls.some((b) => b.row === a.row && b.order === a.order + 1 && (!v.electric || (a.power && b.power))));
    return hasPair ? 'full' : 'no_pair';
  }
  if (v.electric && !stalls.some((b) => b.power)) return 'no_power_stall';
  return 'full';
}

export async function buildAssignmentsView(db: Firestore, market: FarmersMarket, date: MarketDateDoc, now: Date): Promise<AssignmentsView> {
  const attendance = await loadAttendance(db, market, date, now);
  const season = attendance.season || currentSeason(market, now);

  const targetId = date.actions.assignments_target_date_id ?? null;
  let target: MarketDateDoc | null = null;
  if (targetId) {
    const doc = await db.collection('market_dates').doc(targetId).get();
    if (doc.exists) target = marketDateFromData(doc.id, doc.data() as Record<string, unknown>);
  }
  if (!target) target = await nextDateAfter(db, market, date);

  const rows = target ? await currentAssignments(db, target.id) : [];
  const allBooths = await listBooths(db, market.id, { includeInactive: true });
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

  const boothIdsOf = (producerId: string) => {
    const byId = new Map(allBooths.map((b) => [b.id, b]));
    return rows
      .filter((r) => r.producer_id === producerId)
      .map((r) => byId.get(r.booth_id))
      .filter((b): b is BoothDoc => !!b)
      .sort(compareBooths)
      .map((b) => b.id);
  };

  const freeBooths = activeBooths.filter((b) => !seatedBoothIds.has(b.id));
  const attending = attendance.attending.map((v) => ({
    producer_id: v.producer_id,
    business_name: v.business_name,
    spaces: v.spaces,
    electric: v.electric,
    booth_kind: v.booth_kind,
    usual_booth_id: v.usual_booth_id,
    booth_ids: boothIdsOf(v.producer_id),
  }));
  const unassigned = attendance.attending
    .filter((v) => {
      const n = boothIdsOf(v.producer_id).length;
      return n === 0 || (v.booth_kind === 'stall' && v.spaces === 2 && n < 2);
    })
    .map((v) => ({ producer_id: v.producer_id, business_name: v.business_name, reason: explainUnassigned(v, freeBooths) }));

  const summary = computeBoothSummary(activeBooths, attendance.attending.map((v) => v.producer_id), rows);

  const messages: AssignmentsView['messages'] = [];
  if (target) {
    const snap = await db.collection('messages').where('market_date_id', '==', target.id).get();
    for (const d of snap.docs) {
      const m = d.data() as Record<string, unknown>;
      if (m.kind !== 'booth') continue;
      messages.push({
        id: d.id,
        producer_id: typeof m.producer_id === 'string' ? m.producer_id : null,
        to: String(m.to ?? ''),
        status: String(m.status ?? ''),
        created_at: toDateOrEpoch(m.created_at),
      });
    }
    messages.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  const approvedAt = date.actions.approved_at;
  const sentAt = date.actions.booth_texts_sent_at;
  const quiet = market.quiet_hours ?? DEFAULT_QUIET_HOURS;

  return {
    target_date: target ? { id: target.id, date: target.date, date_label: longDateLabel(target.date) } : null,
    season,
    drafted_at: date.actions.drafts_generated_at,
    assignments_draft_at: date.actions.assignments_draft_at ?? null,
    approved_at: approvedAt,
    approved_by: date.actions.approved_by ?? null,
    booth_texts_sent_at: sentAt,
    booth_texts_due_at: approvedAt && !sentAt ? nextAllowedInstant(approvedAt, quiet, market.timezone) : null,
    drafts_skipped: date.actions.drafts_skipped ?? null,
    booths: boothRows,
    attending,
    unassigned,
    not_attending: attendance.not_attending.map((v) => ({ producer_id: v.producer_id, business_name: v.business_name })),
    no_answer: attendance.no_answer.map((v) => ({ producer_id: v.producer_id, business_name: v.business_name })),
    summary: { ...summary, conflicts: conflictedBoothIds(rows).length },
    messages,
  };
}
