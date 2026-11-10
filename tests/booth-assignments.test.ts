import { describe, it, expect } from 'vitest';
import {
  planAssignments, conflictedBoothIds, computeBoothSummary, planBoothTexts, boothTextsSettled, boothTextsAllowedAt, seasonOpenerOf,
} from '../src/services/booth-assignments.js';
import type { BoothTextLogEntry, PlanVendor } from '../src/services/booth-assignments.js';
import type { BoothDoc } from '../src/services/booths.js';
import { assignmentCycleFromData, marketDateFromData } from '../src/services/market-dates.js';

// The pure drafting algorithm (contract §3.5). Layout mirrors the WLRFM map as DATA built here:
// two rows of 11 (V1-V11 west, V12-V22 east) plus a food-truck slot; V12-V14 are powered.
const D = new Date('2026-01-01T00:00:00Z');

function booth(label: string, row: string, order: number, extra: Partial<BoothDoc> = {}): BoothDoc {
  return {
    id: `wlrfm_${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    market_id: 'wlrfm', label, row, order, kind: 'stall', power: false, size: '12x12', notes: '', active: true, created_at: D, updated_at: D,
    ...extra,
  };
}

function layout(powered: string[] = ['V12', 'V13', 'V14']): BoothDoc[] {
  const out: BoothDoc[] = [];
  for (let i = 1; i <= 11; i++) out.push(booth(`V${i}`, 'west', i, { power: powered.includes(`V${i}`) }));
  for (let i = 12; i <= 22; i++) out.push(booth(`V${i}`, 'east', i - 11, { power: powered.includes(`V${i}`) }));
  out.push(booth('Food truck', 'center', 8, { kind: 'food_truck' }));
  return out;
}

const id = (label: string) => `wlrfm_${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function vendor(producer_id: string, extra: Partial<PlanVendor> = {}): PlanVendor {
  return { producer_id, business_name: `Farm ${producer_id}`, spaces: 1, electric: false, booth_kind: 'stall', usual_booth_id: null, ...extra };
}

function labelsOf(result: ReturnType<typeof planAssignments>, producerId: string): string[] {
  const p = result.placed.find((x) => x.producer_id === producerId);
  return p ? p.booth_ids.map((b) => b.replace('wlrfm_', '').toUpperCase().replace('FOOD-TRUCK', 'Food truck')) : [];
}

describe('planAssignments — usual booths', () => {
  it('seats vendors in their usual booth first, whatever their name sorts to', () => {
    const r = planAssignments({
      booths: layout(),
      vendors: [vendor('zed', { usual_booth_id: id('V1') }), vendor('amy', { usual_booth_id: id('V5') }), vendor('newbie')],
      fixed: [],
    });
    expect(labelsOf(r, 'zed')).toEqual(['V1']);
    expect(labelsOf(r, 'amy')).toEqual(['V5']);
    expect(r.placed.find((p) => p.producer_id === 'zed')?.source).toBe('usual');
    // The vendor without a usual booth is suggested one, and not V1/V5.
    const n = r.placed.find((p) => p.producer_id === 'newbie')!;
    expect(n.source).toBe('suggested');
    expect(n.booth_ids).not.toContain(id('V1'));
    expect(n.booth_ids).not.toContain(id('V5'));
    expect(r.unassigned).toEqual([]);
  });

  it('gives a two-space vendor the usual booth and the free neighbour at order + 1', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { spaces: 2, usual_booth_id: id('V7') })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V7', 'V8']);
    expect(r.unassigned).toEqual([]);
  });

  it('falls back to order - 1 when order + 1 is taken', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { spaces: 2, usual_booth_id: id('V7') })], fixed: [{ producer_id: 'm', booth_id: id('V8') }] });
    expect(labelsOf(r, 'a')).toEqual(['V6', 'V7']);
  });

  it('gives only the usual booth and reports no_pair when both neighbours are taken', () => {
    const r = planAssignments({
      booths: layout(), vendors: [vendor('a', { spaces: 2, usual_booth_id: id('V7') })],
      fixed: [{ producer_id: 'm', booth_id: id('V8') }, { producer_id: 'n', booth_id: id('V6') }],
    });
    expect(labelsOf(r, 'a')).toEqual(['V7']);
    expect(r.unassigned).toEqual([{ producer_id: 'a', reason: 'no_pair' }]);
  });

  it('does not cross a row boundary for the neighbour (V11 west is not next to V12 east)', () => {
    const r = planAssignments({
      booths: layout(), vendors: [vendor('a', { spaces: 2, usual_booth_id: id('V11') })],
      fixed: [{ producer_id: 'm', booth_id: id('V10') }],
    });
    expect(labelsOf(r, 'a')).toEqual(['V11']);
    expect(r.unassigned).toEqual([{ producer_id: 'a', reason: 'no_pair' }]);
  });

  it('lets the first vendor (by booth order, then name) keep a booth two vendors both call usual', () => {
    const r = planAssignments({
      booths: layout(),
      vendors: [vendor('b', { business_name: 'Bravo', usual_booth_id: id('V3') }), vendor('a', { business_name: 'Alpha', usual_booth_id: id('V3') })],
      fixed: [],
    });
    expect(labelsOf(r, 'a')).toEqual(['V3']);
    expect(r.placed.find((p) => p.producer_id === 'b')?.source).toBe('suggested');
  });

  it('ignores a usual booth that is retired, taken by a manual placement, or the wrong kind', () => {
    const booths = layout();
    booths.find((b) => b.label === 'V2')!.active = false;
    const r = planAssignments({
      booths,
      vendors: [vendor('a', { usual_booth_id: id('V2') }), vendor('b', { usual_booth_id: id('V3') }), vendor('c', { usual_booth_id: id('Food truck') })],
      fixed: [{ producer_id: 'm', booth_id: id('V3') }],
    });
    for (const p of ['a', 'b', 'c']) expect(r.placed.find((x) => x.producer_id === p)?.source).toBe('suggested');
    expect(labelsOf(r, 'c')).not.toContain('Food truck');
    expect(r.unassigned).toEqual([]);
  });
});

describe('planAssignments — electricity', () => {
  it('puts an electric vendor only on a powered stall', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { electric: true })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V12']);
  });

  it('reports no_power_stall when every powered stall is taken', () => {
    const r = planAssignments({
      booths: layout(), vendors: [vendor('a', { electric: true })],
      fixed: ['V12', 'V13', 'V14'].map((l, i) => ({ producer_id: `m${i}`, booth_id: id(l) })),
    });
    expect(r.placed).toEqual([]);
    expect(r.unassigned).toEqual([{ producer_id: 'a', reason: 'no_power_stall' }]);
  });

  it('keeps an electric vendor in an unpowered usual booth and warns staff instead of silently moving them (contract 3.5)', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { electric: true, usual_booth_id: id('V3') })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V3']);
    expect(r.placed[0]!.source).toBe('usual');
    expect(r.unassigned).toEqual([]);
    expect(r.warnings).toEqual([{ producer_id: 'a', reason: 'power_mismatch', booth_ids: [id('V3')] }]);
    // A powered usual stall, or no need for power, is no warning.
    expect(planAssignments({ booths: layout(), vendors: [vendor('a', { electric: true, usual_booth_id: id('V12') })], fixed: [] }).warnings).toEqual([]);
    expect(planAssignments({ booths: layout(), vendors: [vendor('a', { usual_booth_id: id('V3') })], fixed: [] }).warnings).toEqual([]);
  });

  it('gives an electric two-space vendor on a powered row-end stall the unpowered neighbour (not one stall and no_pair)', () => {
    // V11 is the last stall of the west row and the only powered one there: its one neighbour, V10, has no power.
    const r = planAssignments({ booths: layout(['V11']), vendors: [vendor('a', { spaces: 2, electric: true, usual_booth_id: id('V11') })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V10', 'V11']);
    expect(r.placed[0]!.source).toBe('usual');
    expect(r.unassigned).toEqual([]);
    expect(r.warnings).toEqual([]); // the usual stall is where they plug in
    // The same vendor on a powered usual stall in the middle of the row: order + 1 first, whatever its power flag.
    const mid = planAssignments({ booths: layout(['V5']), vendors: [vendor('a', { spaces: 2, electric: true, usual_booth_id: id('V5') })], fixed: [] });
    expect(labelsOf(mid, 'a')).toEqual(['V5', 'V6']);
    expect(mid.unassigned).toEqual([]);
  });

  it('warns once for an electric two-space vendor whose usual stall and neighbour both lack power', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { spaces: 2, electric: true, usual_booth_id: id('V3') })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V3', 'V4']);
    expect(r.warnings).toEqual([{ producer_id: 'a', reason: 'power_mismatch', booth_ids: [id('V3'), id('V4')] }]);
  });

  it('keeps non-electric vendors off powered stalls while others remain', () => {
    const vendors = Array.from({ length: 19 }, (_, i) => vendor(`p${String(i).padStart(2, '0')}`));
    const r = planAssignments({ booths: layout(), vendors, fixed: [] });
    const used = new Set(r.placed.flatMap((p) => p.booth_ids));
    for (const l of ['V12', 'V13', 'V14']) expect(used.has(id(l))).toBe(false);
    expect(r.unassigned).toEqual([]);
    // Once the unpowered stalls run out they do spill onto powered ones.
    const more = planAssignments({ booths: layout(), vendors: Array.from({ length: 22 }, (_, i) => vendor(`p${String(i).padStart(2, '0')}`)), fixed: [] });
    expect(new Set(more.placed.flatMap((p) => p.booth_ids)).size).toBe(22);
  });

  it('seats electric vendors before non-electric ones so they get the powered stalls', () => {
    const vendors = [vendor('a_plain'), ...['x', 'y', 'z'].map((p) => vendor(`e_${p}`, { electric: true }))];
    const r = planAssignments({ booths: layout(), vendors, fixed: [] });
    expect(['e_x', 'e_y', 'e_z'].map((p) => labelsOf(r, p)[0]).sort()).toEqual(['V12', 'V13', 'V14']);
  });
});

describe('planAssignments — two spaces', () => {
  it('suggests the first same-row consecutive free pair', () => {
    const west = layout().filter((b) => b.row === 'west');
    const r = planAssignments({ booths: west, vendors: [vendor('a', { spaces: 2 })], fixed: [{ producer_id: 'm', booth_id: id('V1') }] });
    expect(labelsOf(r, 'a')).toEqual(['V2', 'V3']);
  });

  it('requires both stalls powered for an electric two-space vendor', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { spaces: 2, electric: true })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V12', 'V13']);
  });

  it('prefers a pair without powered stalls for a vendor who does not need power', () => {
    // Rows sort alphabetically (east before west) and the east row opens with the powered stalls, so the first
    // pair that uses no power is V15-V16.
    const r = planAssignments({ booths: layout(), vendors: [vendor('a', { spaces: 2 })], fixed: [] });
    expect(labelsOf(r, 'a')).toEqual(['V15', 'V16']);
    // With only the powered end free, it still gets a pair there.
    const booths = layout().filter((b) => ['V12', 'V13', 'V14'].includes(b.label));
    expect(labelsOf(planAssignments({ booths, vendors: [vendor('a', { spaces: 2 })], fixed: [] }), 'a')).toEqual(['V12', 'V13']);
  });

  it('reports no_pair when free stalls exist but none are adjacent', () => {
    const booths = [booth('A', 'west', 1), booth('B', 'west', 3), booth('C', 'east', 2)];
    const r = planAssignments({ booths, vendors: [vendor('a', { spaces: 2 })], fixed: [] });
    expect(r.placed).toEqual([]);
    expect(r.unassigned).toEqual([{ producer_id: 'a', reason: 'no_pair' }]);
  });

  it('seats two-space vendors before one-space vendors so a pair is not broken up', () => {
    const booths = [booth('A', 'west', 1), booth('B', 'west', 2), booth('C', 'west', 3)];
    const r = planAssignments({ booths, vendors: [vendor('one', { business_name: 'Aardvark' }), vendor('two', { business_name: 'Zebra', spaces: 2 })], fixed: [] });
    expect(r.placed.find((p) => p.producer_id === 'two')!.booth_ids).toHaveLength(2);
    expect(r.placed.find((p) => p.producer_id === 'one')!.booth_ids).toHaveLength(1);
    expect(r.unassigned).toEqual([]);
  });
});

describe('planAssignments — food trucks', () => {
  it('puts a food-truck vendor on the food-truck booth, never a stall', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('t', { booth_kind: 'food_truck' })], fixed: [] });
    expect(labelsOf(r, 't')).toEqual(['Food truck']);
  });

  it('reports no_food_truck_slot when there is no slot or it is taken, and keeps stall vendors off it', () => {
    const noSlot = planAssignments({ booths: layout().filter((b) => b.kind === 'stall'), vendors: [vendor('t', { booth_kind: 'food_truck' })], fixed: [] });
    expect(noSlot.unassigned).toEqual([{ producer_id: 't', reason: 'no_food_truck_slot' }]);
    const taken = planAssignments({ booths: layout(), vendors: [vendor('t', { booth_kind: 'food_truck' })], fixed: [{ producer_id: 'm', booth_id: id('Food truck') }] });
    expect(taken.unassigned).toEqual([{ producer_id: 't', reason: 'no_food_truck_slot' }]);

    const only = planAssignments({ booths: [booth('T', 'center', 1, { kind: 'food_truck' })], vendors: [vendor('s')], fixed: [] });
    expect(only.unassigned).toEqual([{ producer_id: 's', reason: 'full' }]);
  });

  it('honours a food-truck vendor\'s usual booth', () => {
    const r = planAssignments({ booths: layout(), vendors: [vendor('t', { booth_kind: 'food_truck', usual_booth_id: id('Food truck') })], fixed: [] });
    expect(r.placed[0]).toMatchObject({ producer_id: 't', source: 'usual' });
  });
});

describe('planAssignments — full house, fixed placements, determinism', () => {
  it('leaves exactly one vendor unplaced (full) when 23 stall vendors meet 22 stalls and a truck slot', () => {
    const vendors = Array.from({ length: 23 }, (_, i) => vendor(`p${String(i).padStart(2, '0')}`));
    const r = planAssignments({ booths: layout(), vendors, fixed: [] });
    expect(r.placed).toHaveLength(22);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0]!.reason).toBe('full');
    const used = r.placed.flatMap((p) => p.booth_ids);
    expect(new Set(used).size).toBe(22);
    expect(used).not.toContain(id('Food truck'));
  });

  it('works around fixed manual placements', () => {
    const r = planAssignments({
      booths: layout(), vendors: [vendor('a', { usual_booth_id: id('V1') }), vendor('b')],
      fixed: [{ producer_id: 'm', booth_id: id('V1') }, { producer_id: 'm', booth_id: id('V2') }],
    });
    const used = r.placed.flatMap((p) => p.booth_ids);
    expect(used).not.toContain(id('V1'));
    expect(used).not.toContain(id('V2'));
    expect(r.placed).toHaveLength(2);
  });

  it('ignores retired booths', () => {
    const booths = layout();
    for (const b of booths) if (b.label !== 'V5') b.active = false;
    const r = planAssignments({ booths, vendors: [vendor('a'), vendor('b')], fixed: [] });
    expect(r.placed).toHaveLength(1);
    expect(r.unassigned).toHaveLength(1);
  });

  it('is deterministic: the same input twice (and in shuffled order) gives deep-equal output', () => {
    const vendors = [
      vendor('p1', { usual_booth_id: id('V4'), spaces: 2 }), vendor('p2', { electric: true }), vendor('p3', { spaces: 2, electric: true }),
      vendor('p4', { booth_kind: 'food_truck' }), vendor('p5'), vendor('p6', { usual_booth_id: id('V9') }), vendor('p7'),
    ];
    const a = planAssignments({ booths: layout(), vendors, fixed: [] });
    const b = planAssignments({ booths: layout(), vendors, fixed: [] });
    expect(a).toEqual(b);
    const c = planAssignments({ booths: [...layout()].reverse(), vendors: [...vendors].reverse(), fixed: [] });
    const norm = (r: typeof a) => ({
      placed: [...r.placed].sort((x, y) => x.producer_id.localeCompare(y.producer_id)),
      unassigned: [...r.unassigned].sort((x, y) => x.producer_id.localeCompare(y.producer_id)),
    });
    expect(norm(c)).toEqual(norm(a));
  });
});

describe('summary helpers', () => {
  it('finds booths held by two producers', () => {
    expect(conflictedBoothIds([{ booth_id: 'b1', producer_id: 'p1' }, { booth_id: 'b1', producer_id: 'p2' }, { booth_id: 'b2', producer_id: 'p1' }])).toEqual(['b1']);
    expect(conflictedBoothIds([{ booth_id: 'b1', producer_id: 'p1' }, { booth_id: 'b1', producer_id: 'p1' }])).toEqual([]);
  });

  it('counts seated vendors and free booths', () => {
    const booths = layout();
    const s = computeBoothSummary(booths, ['a', 'b', 'c'], [
      { booth_id: id('V1'), producer_id: 'a' }, { booth_id: id('V2'), producer_id: 'a' }, { booth_id: id('V3'), producer_id: 'b' },
    ]);
    expect(s).toEqual({ assigned: 2, unassigned: 1, booths_total: 23, booths_free: 20 });
  });
});

// ─── Phase 4 fix: what each vendor is owed, read from the rows and the log ───

describe('planBoothTexts — booth texts follow the current assignment', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 8, 22, 15, min));
  const booths = layout();
  const row = (rowId: string, producer: string, label: string, at = T(0)) => ({ id: rowId, producer_id: producer, booth_id: id(label), assigned_at: at });
  let n = 0;
  function entry(producer: string, extra: Partial<BoothTextLogEntry>): BoothTextLogEntry {
    n += 1;
    return {
      id: `m${n}`, producer_id: producer, to: '+15015550101', status: 'sent', created_at: T(1), seq: n, type: 'assignment',
      assignment_id: null, booth_ids: [], booth_labels: [], ...extra,
    };
  }
  const told = (producer: string, rowId: string, labels: string[], extra: Partial<BoothTextLogEntry> = {}) =>
    entry(producer, { assignment_id: rowId, booth_ids: labels.map(id), booth_labels: labels, ...extra });
  const released = (producer: string, rowId: string, labels: string[], extra: Partial<BoothTextLogEntry> = {}) =>
    entry(producer, { type: 'release', assignment_id: rowId, booth_labels: labels, ...extra });

  it('owes every seated vendor one first text, keyed on their newest current row, labels in booth order', () => {
    const plan = planBoothTexts({ rows: [row('r2', 'a', 'V8'), row('r1', 'a', 'V7'), row('r3', 'b', 'Food truck')], booths, log: [] });
    expect(plan).toEqual([
      expect.objectContaining({ producer_id: 'a', type: 'assignment', assignment_id: 'r2', booth_labels: ['V7', 'V8'], state: 'owed', changed: false, seq: 1 }),
      expect.objectContaining({ producer_id: 'b', type: 'assignment', assignment_id: 'r3', booth_labels: ['Food truck'], state: 'owed', changed: false }),
    ]);
  });

  it('owes nothing once the vendor has been told exactly this assignment (sent, simulated or still queued)', () => {
    for (const status of ['sent', 'simulated']) {
      const [item] = planBoothTexts({ rows: [row('r1', 'a', 'V7')], booths, log: [told('a', 'r1', ['V7'], { status })] });
      expect(item).toMatchObject({ state: 'sent', changed: false });
    }
    const [queued] = planBoothTexts({ rows: [row('r1', 'a', 'V7')], booths, log: [told('a', 'r1', ['V7'], { status: 'queued' })] });
    expect(queued!.state).toBe('queued');
  });

  it('a provider failure is `failed`, not owed: the engine does not retry it', () => {
    const [item] = planBoothTexts({ rows: [row('r1', 'a', 'V7')], booths, log: [told('a', 'r1', ['V7'], { status: 'failed' })] });
    expect(item).toMatchObject({ state: 'failed', changed: false });
    // A staff resend (a second, delivered row for the same assignment) settles it.
    const [after] = planBoothTexts({ rows: [row('r1', 'a', 'V7')], booths, log: [told('a', 'r1', ['V7'], { status: 'failed' }), told('a', 'r1', ['V7'], { created_at: T(2) })] });
    expect(after!.state).toBe('sent');
  });

  it('a changed assignment is owed one corrective text ("is now"), keyed on the new row', () => {
    const [item] = planBoothTexts({ rows: [row('r9', 'a', 'V6', T(5))], booths, log: [told('a', 'r1', ['V7'])] });
    expect(item).toMatchObject({ type: 'assignment', assignment_id: 'r9', booth_labels: ['V6'], state: 'owed', changed: true });
    expect(item!.seq).toBeGreaterThan(1);
  });

  it('changed and changed back before anything was sent owes nothing: what the vendor was told is still true', () => {
    const [item] = planBoothTexts({ rows: [row('r7', 'a', 'V7', T(9))], booths, log: [told('a', 'r1', ['V7'])] });
    expect(item).toMatchObject({ assignment_id: 'r7', state: 'sent', changed: false });
  });

  it('a vendor who was told a booth and removed is owed one release notice; one never told gets nothing', () => {
    const plan = planBoothTexts({ rows: [], booths, log: [told('a', 'r1', ['V7', 'V8']), told('b', 'r2', ['V1'], { status: 'failed' })] });
    expect(plan).toEqual([expect.objectContaining({ producer_id: 'a', type: 'release', assignment_id: 'r1', booth_ids: [], booth_labels: ['V7', 'V8'], state: 'owed' })]);
  });

  it('a delivered release is `sent`, a failed one is `failed`, and a vendor seated again afterwards is owed a new text', () => {
    const log = [told('a', 'r1', ['V7']), released('a', 'r1', ['V7'], { created_at: T(3) })];
    expect(planBoothTexts({ rows: [], booths, log })).toEqual([expect.objectContaining({ type: 'release', state: 'sent' })]);
    const failed = [told('a', 'r1', ['V7']), released('a', 'r1', ['V7'], { created_at: T(3), status: 'failed' })];
    expect(planBoothTexts({ rows: [], booths, log: failed })).toEqual([expect.objectContaining({ type: 'release', assignment_id: 'r1', state: 'failed' })]);
    const [again] = planBoothTexts({ rows: [row('r5', 'a', 'V7', T(6))], booths, log });
    expect(again).toMatchObject({ type: 'assignment', assignment_id: 'r5', state: 'owed', changed: true });
  });
});

describe('boothTextsSettled / boothTextsAllowedAt', () => {
  const state = (extra: Record<string, unknown>) => assignmentCycleFromData({ approved_at: new Date('2026-09-22T15:00:00Z'), ...extra });
  const SENT = new Date('2026-09-22T15:00:01Z');

  it('nothing is owed before approval', () => {
    expect(boothTextsSettled(assignmentCycleFromData({}))).toBe(true);
    expect(boothTextsSettled(assignmentCycleFromData(null))).toBe(true);
  });

  it('an approved cycle is owed its first pass, and is settled once it ran', () => {
    expect(boothTextsSettled(state({}))).toBe(false);
    expect(boothTextsSettled(state({ booth_texts_sent_at: SENT }))).toBe(true); // a cycle nobody changed carries no token at all
    expect(boothTextsSettled(state({ booth_texts_sent_at: SENT, assignments_rev: 'a', booth_texts_rev: 'a' }))).toBe(true);
  });

  it('a staff change (a new assignments_rev) makes it owed again, sent or not', () => {
    expect(boothTextsSettled(state({ booth_texts_sent_at: SENT, assignments_rev: 'b', booth_texts_rev: 'a' }))).toBe(false);
    expect(boothTextsSettled(state({ booth_texts_sent_at: SENT, assignments_rev: 'b' }))).toBe(false);
  });

  it('a recorded conflict or a started target is settled until the assignments change; a cancelled target is re-checked', () => {
    expect(boothTextsSettled(state({ booth_texts_blocked: 'conflict', assignments_rev: 'a', booth_texts_rev: 'a' }))).toBe(true);
    expect(boothTextsSettled(state({ booth_texts_blocked: 'conflict', assignments_rev: 'b', booth_texts_rev: 'a' }))).toBe(false);
    expect(boothTextsSettled(state({ booth_texts_blocked: 'started' }))).toBe(true);
    expect(boothTextsSettled(state({ booth_texts_blocked: 'cancelled' }))).toBe(false);
    expect(boothTextsSettled(state({ booth_texts_blocked: 'cancelled', booth_texts_sent_at: SENT }))).toBe(false);
  });

  it('texts wait for the end of quiet hours, counted from the approval and from now', () => {
    const market = { quiet_hours: { start: '21:00', end: '08:00' }, timezone: 'America/Chicago' };
    const morning = new Date('2026-09-22T15:00:00Z'); // 10:00 CDT
    const night = new Date('2026-09-23T03:30:00Z'); // 22:30 CDT
    const eight = new Date('2026-09-23T13:00:00Z');
    expect(boothTextsAllowedAt(morning, morning, market)).toEqual(morning);
    expect(boothTextsAllowedAt(night, night, market)).toEqual(eight);
    expect(boothTextsAllowedAt(morning, night, market)).toEqual(eight); // approved in the morning, retried at night
    expect(boothTextsAllowedAt(night, new Date('2026-09-23T14:00:00Z'), market)).toEqual(new Date('2026-09-23T14:00:00Z'));
  });
});

describe('seasonOpenerOf', () => {
  const version = (vid: string, start: string, end: string) => ({
    id: vid, effective_from: start, season_start: start, season_end: end, days_of_week: ['saturday' as const], start_time: '08:00', end_time: '12:00', created_at: D, created_by: 't',
  });
  const md = (date: string, status = 'collecting') =>
    marketDateFromData(`wlrfm_${date}`, { market_id: 'wlrfm', date, status, start_at: new Date(`${date}T13:00:00Z`), end_at: new Date(`${date}T17:00:00Z`), actions: {} });
  const dates = [md('2026-10-24'), md('2026-10-31'), md('2027-04-03', 'cancelled'), md('2027-04-10'), md('2027-04-17')];
  const schedule = { versions: [version('v26', '2026-04-04', '2026-10-31'), version('v27', '2027-04-03', '2027-11-27')], skipped_dates: [], special_dates: [] };

  it('is the earliest non-cancelled date of the season the market names', () => {
    const market = { schedule, season: { label: '2027', application_open: null, application_close: null, schedule_version_id: 'v27' } };
    expect(seasonOpenerOf(market, dates)?.id).toBe('wlrfm_2027-04-10'); // Apr 3 is cancelled
    expect(seasonOpenerOf({ ...market, season: { ...market.season, schedule_version_id: 'v26' } }, dates)?.id).toBe('wlrfm_2026-10-24');
  });

  it('falls back to the version that starts last, and is null with no schedule version or no date in the season', () => {
    expect(seasonOpenerOf({ schedule, season: null }, dates)?.id).toBe('wlrfm_2027-04-10');
    expect(seasonOpenerOf({ schedule: { versions: [], skipped_dates: [], special_dates: [] }, season: null }, dates)).toBeNull();
    expect(seasonOpenerOf({ schedule, season: null }, dates.slice(0, 2))).toBeNull();
  });
});
