// Phase 4 fix (booth side), items Y1-Y4: no booth text for a double-booked booth, booth texts
// that follow the CURRENT assignment (corrective texts, release notices, staff resend), a target
// date that is validated, and approved dates that are never stranded outside the 7-day window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEDUPE_KEYS } from '../src/services/checkin-workflow.js';
import { applyAssignmentChanges } from '../src/services/booth-assignments.js';
import { marketDateFromData } from '../src/services/market-dates.js';
import type { FarmersMarket } from '../src/services/markets.js';
import { fakeDb } from './helpers/fake-db.js';
import {
  PRODUCERS, USERS, actionsOf, boothMessages, boothsOf, buildApp, checkin, currentRows, dateDoc, marketDoc, newestRowId, routes, standardBooths, tick,
} from './helpers/booth-fixtures.js';
import type { App, Db } from './helpers/booth-fixtures.js';

vi.mock('../src/middleware/rbac.js', () => ({
  authenticate: (app: any) => async (request: any, reply: any) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer test:')) return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    const userId = header.slice('Bearer test:'.length);
    const userDoc = await app.db.collection('users').doc(userId).get();
    if (!userDoc.exists) return reply.status(401).send({ error: 'User not found' });
    const user = userDoc.data();
    request.authUser = {
      id: userDoc.id, name: user.name ?? null, role: user.role, phone: user.phone ?? null, assigned_market_ids: user.assigned_market_ids ?? [],
    };
  },
  requireRole: (...roles: string[]) => async (request: any, reply: any) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;
    if (!roles.includes(user.role)) return reply.status(403).send({ error: 'Forbidden: insufficient role' });
  },
}));

const SOURCE = 'wlrfm_2026-09-19';
const TARGET = 'wlrfm_2026-09-26'; // Sat 08:00-12:00 CDT = 13:00-17:00Z
const T_MORNING = new Date('2026-09-22T15:00:00Z'); // Tue 10:00 CDT
const T_QUIET = new Date('2026-09-23T03:00:00Z'); // Tue 22:00 CDT
const T_0759 = new Date('2026-09-23T12:59:00Z');
const T_0800 = new Date('2026-09-23T13:00:00Z'); // Wed 08:00 CDT
const T_WED_10 = new Date('2026-09-23T15:00:00Z');
const T_WED_1005 = new Date('2026-09-23T15:05:00Z');
const T_WED_1010 = new Date('2026-09-23T15:10:00Z');

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_MORNING);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const consoleBoothTexts = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith('[sms:console]') && c[2] === 'booth').length;

const SOURCE_DONE = {
  checkin_sent_at: new Date('2026-09-19T18:00:00Z'), deadline_processed_at: new Date('2026-09-22T17:00:00Z'), summary_sent_at: new Date('2026-09-22T17:05:00Z'),
  reminder_state: {
    offset_1440: { offset_min: 1440, sent_at: new Date('2026-09-20T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
    offset_2880: { offset_min: 2880, sent_at: new Date('2026-09-21T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
  },
};

function seed(): Db {
  return fakeDb({
    users: USERS,
    farmers_markets: { wlrfm: marketDoc() },
    market_dates: { [SOURCE]: dateDoc('2026-09-19', SOURCE_DONE), [TARGET]: dateDoc('2026-09-26') },
    booths: standardBooths(),
    producers: PRODUCERS,
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', spaces: 2, usual_booth_id: 'wlrfm_v1' },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active', electric: true, usual_booth_id: 'wlrfm_v3' },
      p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
      p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', status: 'active' },
      p5_wlrfm: { producer_id: 'p5', market_id: 'wlrfm', status: 'active' },
      p6_wlrfm: { producer_id: 'p6', market_id: 'wlrfm', status: 'active', booth_kind: 'food_truck' },
    },
    checkins: {
      [`${SOURCE}_p1`]: checkin(SOURCE, 'p1', true),
      [`${SOURCE}_p2`]: checkin(SOURCE, 'p2', true),
      [`${SOURCE}_p3`]: checkin(SOURCE, 'p3', true),
      [`${SOURCE}_p4`]: checkin(SOURCE, 'p4', false),
      [`${SOURCE}_p6`]: checkin(SOURCE, 'p6', true),
    },
  });
}

// Drafted: p1 V1+V2 (usual), p2 V3 (usual, power), p3 V7 (suggested), p6 the food-truck slot.
async function drafted() {
  const db = seed();
  const app = await buildApp(db);
  const r = routes(app, SOURCE);
  expect((await r.draft()).statusCode).toBe(200);
  return { db, app, r };
}

/** Drafted, approved at 10:00 and texted: four first texts are out. */
async function texted() {
  const ctx = await drafted();
  const res = await ctx.r.approve();
  expect(res.json().texts).toMatchObject({ attempted: true, sent: 4 });
  vi.setSystemTime(T_WED_10);
  return ctx;
}

/** Drafted and approved at 22:00: the first texts wait for 08:00. */
async function approvedInQuietHours() {
  const ctx = await drafted();
  vi.setSystemTime(T_QUIET);
  const res = await ctx.r.approve();
  expect(res.json().texts).toMatchObject({ attempted: false, deferred_until: T_0800.toISOString() });
  return ctx;
}

const textsTo = (db: Db, producer: string) => boothMessages(db).filter((m) => m.producer_id === producer);
const lockKeys = (db: Db) => Object.keys(db.dump('workflow_locks')).sort();

describe('Y1 — no booth text for a double-booked booth', () => {
  it('after approval a change that would put a second vendor on an occupied booth is refused (409 conflict, naming the booth)', async () => {
    const { db, r } = await approvedInQuietHours();
    const before = JSON.stringify(db.dump('booth_assignments'));
    const res = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v3'] }]); // V3 is Beta Farm's
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'conflict', reason: 'conflict', booth_id: 'wlrfm_v3', booth_label: 'V3' });
    expect(res.json().error).toContain('Booth V3 is assigned to Beta Farm');
    expect(JSON.stringify(db.dump('booth_assignments'))).toBe(before);
    expect(actionsOf(db, SOURCE).assignments_rev).toBeUndefined(); // nothing moved, so nothing new is owed
    expect(Object.values(db.dump('audit_log')).filter((a: any) => a.action === 'market_date.assignments.update')).toHaveLength(0);

    // 08:00: every vendor is texted their own booth, and no two vendors the same one.
    const open = await tick(db, T_0800);
    expect(open.booth_texts_sent).toBe(4);
    const labels = boothMessages(db).flatMap((m) => m.booth_labels);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.sort()).toEqual(['Food truck', 'V1', 'V2', 'V3', 'V7']);
  });

  it('a swap sent as one change is not a conflict, and a change onto a free booth is fine', async () => {
    const { db, r } = await approvedInQuietHours();
    const swap = await r.patch([{ producer_id: 'p2', booth_ids: ['wlrfm_v7'] }, { producer_id: 'p3', booth_ids: ['wlrfm_v3'] }]);
    expect(swap.statusCode).toBe(200);
    expect(swap.json().assignments.summary.conflicts).toBe(0);
    expect(boothsOf(currentRows(db, TARGET), 'p3')).toEqual(['wlrfm_v3']);
    // Half of the swap alone is refused: p3 would join p2 on V7.
    const half = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v7'] }]);
    expect(half.statusCode).toBe(409);
    expect(half.json()).toMatchObject({ code: 'conflict', booth_label: 'V7' });
    expect((await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(200);
  });

  it('before approval a double booking is still allowed (and blocks approval), exactly as before', async () => {
    const { r } = await drafted();
    const clash = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v3'] }]);
    expect(clash.statusCode).toBe(200);
    expect(clash.json().assignments).toMatchObject({
      summary: { conflicts: 1 },
      conflict_booth_ids: ['wlrfm_v3'],
      // The grid shows one vendor per booth, so the view names everyone on a double-booked one.
      conflicts: [{ booth_id: 'wlrfm_v3', booth_label: 'V3', producers: [{ producer_id: 'p2', business_name: 'Beta Farm' }, { producer_id: 'p3', business_name: 'Gamma Farm' }] }],
    });
    expect((await r.approve()).json().reason).toBe('conflicts');
  });

  it('the booth-text step re-checks the rows: with a double booking it sends nothing and records why, then sends once it is resolved', async () => {
    const { db, r } = await approvedInQuietHours();
    // Two vendors on V3 despite the approval (two changes that raced, or rows written by an older build).
    await db.collection('booth_assignments').doc('stray').set({
      id: 'stray', market_id: 'wlrfm', market_date_id: TARGET, source_date_id: SOURCE, booth_id: 'wlrfm_v3', producer_id: 'p4',
      source: 'manual', assigned_by: 'mgr_w', assigned_at: T_QUIET, superseded_by: null, superseded_at: null,
    });

    vi.setSystemTime(T_0800);
    const open = await tick(db, T_0800);
    expect(open.errors).toEqual([]);
    expect(open.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);
    expect(consoleBoothTexts()).toBe(0);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_blocked: 'conflict', booth_texts_sent_at: null });

    const view = await r.view();
    expect(view.booth_texts_blocked).toBe('conflict');
    expect(view.booth_texts_due_at).toBeNull();
    expect(view.conflict_booth_ids).toEqual(['wlrfm_v3']);
    expect(view.texts.every((t: any) => t.status === 'blocked' && t.can_resend === false)).toBe(true);
    expect((await r.status()).next_due).toEqual({ action: 'none', at: null });
    expect((await r.resend('p2')).json()).toMatchObject({ code: 'conflict' });

    // Later ticks neither text nor take a new lock: only a staff change can resolve it.
    const locks = lockKeys(db);
    expect((await tick(db, new Date('2026-09-23T13:05:00Z'))).booth_texts_sent).toBe(0);
    expect(lockKeys(db)).toEqual(locks);

    // Staff take the second vendor off V3 (a change that makes an existing double booking no worse is accepted).
    const fixed = await r.patch([{ producer_id: 'p4', booth_ids: ['wlrfm_v5'] }]);
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().assignments.booth_texts_blocked).toBeNull();
    const sent = await tick(db, new Date('2026-09-23T13:10:00Z'));
    expect(sent.booth_texts_sent).toBe(5);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_blocked: null, booth_texts_sent_at: new Date('2026-09-23T13:10:00Z') });
    expect(boothMessages(db).map((m) => m.producer_id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p6']);
    expect((await tick(db, new Date('2026-09-23T13:15:00Z'))).booth_texts_sent).toBe(0);
  });
});

describe('Y2 — booth texts follow the current assignment', () => {
  it('a change after approval and before the texts: at 08:00 every vendor is texted once, with the booth they hold then', async () => {
    const { db, r } = await approvedInQuietHours();
    const res = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ warning: 'approved' });
    expect(res.json().assignments.texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ status: 'pending', booth_labels: ['V6'] });
    expect((await tick(db, T_0759)).booth_texts_sent).toBe(0);

    const open = await tick(db, T_0800);
    expect(open.booth_texts_sent).toBe(4);
    expect(boothMessages(db)).toHaveLength(4);
    const p3 = textsTo(db, 'p3');
    expect(p3).toHaveLength(1);
    expect(p3[0]!.id).toBe(DEDUPE_KEYS.booth(TARGET, 'p3', newestRowId(db, TARGET, 'p3')));
    expect(p3[0]!.body).toContain('is V6. Please'); // the first thing they are told: not "is now"
    expect((await tick(db, new Date('2026-09-23T13:05:00Z'))).booth_texts_sent).toBe(0);
    expect(consoleBoothTexts()).toBe(4);
  });

  it('a change after the texts went out sends exactly one corrective text to the vendor whose booth changed', async () => {
    const { db, r } = await texted();
    const res = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(res.statusCode).toBe(200); // no longer 409 texts_sent
    expect(res.json().warning).toBe('approved');
    expect(res.json().assignments.texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ status: 'pending', can_resend: false });
    expect(res.json().assignments.booth_texts_due_at).toBe(T_WED_10.toISOString());
    expect(boothMessages(db)).toHaveLength(4); // the change itself texts nobody: the engine does

    const next = await tick(db, T_WED_1005);
    expect(next.errors).toEqual([]);
    expect(next.booth_texts_sent).toBe(1);
    const p3 = textsTo(db, 'p3');
    expect(p3).toHaveLength(2);
    expect(p3[1]).toMatchObject({
      id: DEDUPE_KEYS.booth(TARGET, 'p3', newestRowId(db, TARGET, 'p3')), booth_text: 'assignment', booth_labels: ['V6'], booth_ids: ['wlrfm_v6'], seq: 2, segments: 1, status: 'simulated',
    });
    expect(p3[1]!.body).toBe('SJCA Markets: Gus, your booth at West Little Rock Farmers Market on Sat Sep 26 is now V6. Please check in at the table when you arrive.');
    for (const p of ['p1', 'p2', 'p6']) expect(textsTo(db, p)).toHaveLength(1);

    // Nothing more on later ticks; the first pass's stamp and counts are untouched.
    expect((await tick(db, T_WED_1010)).booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(5);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_sent_at: T_MORNING, booth_text_recipients: 4, booth_texts_blocked: null });
    expect(actionsOf(db, SOURCE).booth_texts_rev).toBe(actionsOf(db, SOURCE).assignments_rev);
    const view = await r.view();
    expect(view.texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ status: 'sent', booth_labels: ['V6'], can_resend: true });
    expect(view.text_counts).toMatchObject({ sent: 4, pending: 0, failed: 0 });
    expect(view.messages).toHaveLength(5);
  });

  it('a vendor removed from the date after being texted gets one short release notice; a vendor added gets a first text', async () => {
    const { db, r } = await texted();
    const toldRow = newestRowId(db, TARGET, 'p3');
    expect((await r.patch([{ producer_id: 'p3', booth_ids: [] }, { producer_id: 'p5', booth_ids: ['wlrfm_v5'] }])).statusCode).toBe(200);

    const next = await tick(db, T_WED_1005);
    expect(next.booth_texts_sent).toBe(2);
    const release = textsTo(db, 'p3')[1]!;
    expect(release).toMatchObject({ id: DEDUPE_KEYS.booth_release(TARGET, 'p3', toldRow), booth_text: 'release', booth_ids: [], booth_labels: ['V7'], segments: 1 });
    expect(release.body).toBe('SJCA Markets: Gus, you are no longer assigned a booth at West Little Rock Farmers Market on Sat Sep 26. Questions? Reply to this text.');
    const added = textsTo(db, 'p5');
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toContain('is V5. Please'); // never told anything before: not "is now"

    expect((await tick(db, T_WED_1010)).booth_texts_sent).toBe(0);
    const view = await r.view();
    expect(view.texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ type: 'release', status: 'sent', booth_labels: ['V7'] });
    expect(view.attending.find((v: any) => v.producer_id === 'p5')).toMatchObject({ added_by_staff: true });

    // Seated again later: a new text ("is now"), keyed on the new row.
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v7'] }]);
    expect((await tick(db, new Date('2026-09-23T15:15:00Z'))).booth_texts_sent).toBe(1);
    expect(textsTo(db, 'p3')[2]!.body).toContain('is now V7.');
  });

  it('a vendor removed before any text went out is told nothing', async () => {
    const { db, r } = await approvedInQuietHours();
    await r.patch([{ producer_id: 'p3', booth_ids: [] }]);
    const open = await tick(db, T_0800);
    expect(open.booth_texts_sent).toBe(3);
    expect(textsTo(db, 'p3')).toHaveLength(0);
  });

  it('changed and changed back before the engine ran: nobody is texted the same assignment twice', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v7'] }]);
    const next = await tick(db, T_WED_1005);
    expect(next.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(4);
    expect(actionsOf(db, SOURCE).booth_texts_rev).toBe(actionsOf(db, SOURCE).assignments_rev); // settled again
    expect((await r.view()).texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ status: 'sent' });
  });

  it('a two-space vendor who loses one booth is told the booth they keep', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p1', booth_ids: ['wlrfm_v1'] }]);
    expect((await tick(db, T_WED_1005)).booth_texts_sent).toBe(1);
    expect(textsTo(db, 'p1')[1]!.body).toContain('is now V1. Please');
    expect((await r.view()).unassigned).toEqual([{ producer_id: 'p1', business_name: 'Acme Farm', reason: 'no_pair' }]);
  });

  it('corrective texts wait for the end of quiet hours exactly like the first send', async () => {
    const { db, r } = await texted();
    vi.setSystemTime(T_QUIET);
    const res = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(res.json().assignments.booth_texts_due_at).toBe(T_0800.toISOString());
    expect((await r.status()).next_due).toEqual({ action: 'booth_texts', at: T_0800.toISOString() });
    const locks = lockKeys(db);
    expect((await tick(db, new Date('2026-09-23T03:05:00Z'))).booth_texts_sent).toBe(0);
    expect((await tick(db, T_0759)).booth_texts_sent).toBe(0);
    expect(lockKeys(db)).toEqual(locks); // a deferral takes no lock
    expect(textsTo(db, 'p3')).toHaveLength(1);
    vi.setSystemTime(T_0800);
    expect((await tick(db, T_0800)).booth_texts_sent).toBe(1);
    expect(textsTo(db, 'p3')[1]).toMatchObject({ created_at: T_0800, booth_labels: ['V6'] });
    expect((await r.status()).next_due).toEqual({ action: 'none', at: null });
  });

  it('three overlapping engine runs after a change send one corrective text, under one lock for that version', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    const rev = actionsOf(db, SOURCE).assignments_rev;
    const results = await Promise.all([tick(db, T_WED_1005), tick(db, T_WED_1005), tick(db, T_WED_1005)]);
    expect(results.flatMap((x) => x.errors)).toEqual([]);
    expect(results.reduce((n, x) => n + x.booth_texts_sent, 0)).toBe(1);
    expect(textsTo(db, 'p3')).toHaveLength(2);
    expect(consoleBoothTexts()).toBe(5);
    expect(lockKeys(db)).toEqual([`${SOURCE}__approve`, `${SOURCE}__booth_texts`, `${SOURCE}__booth_texts_${rev}`, `${SOURCE}__drafts`]);
  });

  it('a stale-lock takeover after a run died mid-pass texts nobody twice', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }, { producer_id: 'p2', booth_ids: ['wlrfm_v4'] }]);
    const rev = actionsOf(db, SOURCE).assignments_rev;
    // A run took the lock, texted p2 and died before recording the version.
    await db.collection('workflow_locks').doc(`${SOURCE}__booth_texts_${rev}`).set({ market_date_id: SOURCE, key: `booth_texts_${rev}`, claimed_at: T_WED_10, run_id: 'dead', created_at: T_WED_10 });
    await db.collection('messages').doc(DEDUPE_KEYS.booth(TARGET, 'p2', newestRowId(db, TARGET, 'p2'))).set({
      direction: 'outbound', kind: 'booth', producer_id: 'p2', market_date_id: TARGET, status: 'sent', created_at: T_WED_10, to: '+15015550102', body: 'x',
      booth_text: 'assignment', assignment_id: newestRowId(db, TARGET, 'p2'), booth_ids: ['wlrfm_v4'], booth_labels: ['V4'], source_date_id: SOURCE, seq: 2,
    });
    expect((await tick(db, T_WED_1005)).skipped_claimed).toBe(1); // the dead run's lock is still fresh
    const takeover = await tick(db, new Date('2026-09-23T15:11:00Z'));
    expect(takeover.booth_texts_sent).toBe(1); // p3 only
    expect(textsTo(db, 'p2')).toHaveLength(2);
    expect(textsTo(db, 'p3')).toHaveLength(2);
  });

  it('a change racing an engine run never produces a text from a half-applied change', async () => {
    const { db } = await texted();
    const market = { id: 'wlrfm', ...(db.dump('farmers_markets').wlrfm as any) } as FarmersMarket;
    const date = marketDateFromData(SOURCE, db.dump('market_dates')[SOURCE] as any);
    // A first change makes a text owed, so the racing run really reads the rows while the second change moves them.
    expect((await applyAssignmentChanges(db as never, market, date, [{ producer_id: 'p2', booth_ids: ['wlrfm_v4'] }], 'mgr_w', T_WED_10)).ok).toBe(true);
    const [change] = await Promise.all([
      applyAssignmentChanges(db as never, market, date, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }], 'mgr_w', T_WED_10),
      tick(db, T_WED_10),
      tick(db, T_WED_10),
    ]);
    expect(change.ok).toBe(true);
    await tick(db, T_WED_1005);
    await tick(db, T_WED_1010);

    // Whatever the interleaving: one corrective each, no release notice, and what each vendor was last told is true.
    expect(boothMessages(db).filter((m) => m.booth_text === 'release')).toEqual([]);
    expect(textsTo(db, 'p3').map((m) => m.booth_labels)).toEqual([['V7'], ['V6']]);
    expect(textsTo(db, 'p2').map((m) => m.booth_labels)).toEqual([['V3'], ['V4']]);
    expect(boothMessages(db)).toHaveLength(6);
    expect(actionsOf(db, SOURCE).booth_texts_rev).toBe(actionsOf(db, SOURCE).assignments_rev);
    expect(db.dump('workflow_locks')[`${SOURCE}__assignments_change`]).toBeUndefined();
  });

  it('a change that lands while the engine is reading makes that run send nothing; the next run sends what is true then', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p2', booth_ids: ['wlrfm_v4'] }]); // one corrective text is owed
    const market = { id: 'wlrfm', ...(db.dump('farmers_markets').wlrfm as any) } as FarmersMarket;
    const date = marketDateFromData(SOURCE, db.dump('market_dates')[SOURCE] as any);
    // The run has read the assignment rows; before it reads the message log, staff move p3 (a whole change, start to end).
    let fired = false;
    const racing = {
      ...db,
      collection(name: string) {
        const col = db.collection(name);
        if (name !== 'messages' || fired) return col;
        const where = col.where.bind(col);
        col.where = ((field: string, op: string, value: unknown) => {
          const query = where(field, op, value);
          const get = query.get.bind(query);
          query.get = async () => {
            if (!fired) {
              fired = true;
              const change = await applyAssignmentChanges(db as never, market, date, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }], 'mgr_w', T_WED_10);
              expect(change.ok).toBe(true);
            }
            return get();
          };
          return query;
        }) as typeof col.where;
        return col;
      },
    } as Db;

    const overlapped = await tick(racing, T_WED_10);
    expect(fired).toBe(true);
    expect(overlapped.errors).toEqual([]);
    expect(overlapped.booth_texts_sent).toBe(0); // it had read rows that were about to change: nothing leaves
    expect(boothMessages(db)).toHaveLength(4);
    expect(actionsOf(db, SOURCE).booth_texts_rev).not.toBe(actionsOf(db, SOURCE).assignments_rev); // still owed

    const next = await tick(db, T_WED_1005);
    expect(next.booth_texts_sent).toBe(2);
    expect(textsTo(db, 'p2').map((m) => m.booth_labels)).toEqual([['V3'], ['V4']]);
    expect(textsTo(db, 'p3').map((m) => m.booth_labels)).toEqual([['V7'], ['V6']]);
    expect(boothMessages(db).filter((m) => m.booth_text === 'release')).toEqual([]);
  });

  it('while a staff change is being written the engine sends nothing; a change that died is picked up once its lock is stale', async () => {
    const { db, r } = await texted();
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    await db.collection('workflow_locks').doc(`${SOURCE}__assignments_change`).set({ market_date_id: SOURCE, key: 'assignments_change', claimed_at: T_WED_10, run_id: 'x', created_at: T_WED_10 });
    expect((await tick(db, new Date('2026-09-23T15:01:00Z'))).booth_texts_sent).toBe(0);
    expect(textsTo(db, 'p3')).toHaveLength(1);
    expect((await tick(db, T_WED_1005)).booth_texts_sent).toBe(1); // older than the change-lock TTL
  });

  it('once the target market has started, approved assignments can no longer be changed', async () => {
    const { db, r } = await texted();
    vi.setSystemTime(new Date('2026-09-26T13:00:00Z'));
    const res = await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'target_started' });
    expect(boothsOf(currentRows(db, TARGET), 'p3')).toEqual(['wlrfm_v7']);
    expect((await r.view()).target_started).toBe(true);
  });
});

describe('Y2 — per-vendor text status and the staff resend', () => {
  /** p1's first text failed at the provider (the row the engine would have left behind). */
  async function withFailedText() {
    const ctx = await drafted();
    await ctx.db.collection('messages').doc(DEDUPE_KEYS.booth(TARGET, 'p1', newestRowId(ctx.db, TARGET, 'p1'))).set({
      direction: 'outbound', kind: 'booth', producer_id: 'p1', market_date_id: TARGET, status: 'failed', error: 'provider down', created_at: T_MORNING, to: '+15015550101', body: 'x',
      booth_text: 'assignment', assignment_id: newestRowId(ctx.db, TARGET, 'p1'), booth_ids: ['wlrfm_v1', 'wlrfm_v2'], booth_labels: ['V1', 'V2'], source_date_id: SOURCE, seq: 1,
    });
    expect((await ctx.r.approve()).json().texts).toMatchObject({ sent: 3 });
    return ctx;
  }

  it('shows none before approval, then sent / failed / excluded per vendor', async () => {
    const { db, r } = await drafted();
    await db.collection('producers').doc('p6').update({ sms_opt_out_at: new Date('2026-09-01T00:00:00Z') });
    const before = await r.view();
    expect(before.texts.map((t: any) => [t.producer_id, t.status, t.can_resend])).toEqual([
      ['p1', 'none', false], ['p2', 'none', false], ['p3', 'none', false], ['p6', 'none', false],
    ]);
    await db.collection('messages').doc(DEDUPE_KEYS.booth(TARGET, 'p1', newestRowId(db, TARGET, 'p1'))).set({
      direction: 'outbound', kind: 'booth', producer_id: 'p1', market_date_id: TARGET, status: 'failed', created_at: T_MORNING, to: '+15015550101', body: 'x',
      booth_text: 'assignment', assignment_id: newestRowId(db, TARGET, 'p1'), booth_ids: ['wlrfm_v1', 'wlrfm_v2'], booth_labels: ['V1', 'V2'], seq: 1,
    });
    await r.approve();
    const view = await r.view();
    expect(view.texts.map((t: any) => [t.business_name, t.type, t.booth_labels.join('+'), t.status, t.reason, t.can_resend])).toEqual([
      ['Acme Farm', 'assignment', 'V1+V2', 'failed', null, true],
      ['Beta Farm', 'assignment', 'V3', 'sent', null, true],
      ['Gamma Farm', 'assignment', 'V7', 'sent', null, true],
      ['Zeta Truck', 'assignment', 'Food truck', 'excluded', 'opted_out', false],
    ]);
    expect(view.text_counts).toEqual({ pending: 0, sent: 2, failed: 1, blocked: 0, excluded: 1, skipped: 0 });
    expect(view.texts[0].last_message).toMatchObject({ status: 'failed' });
  });

  it('a failed text is not retried by the engine; the staff resend sends it, unkeyed and audited', async () => {
    const { db, r } = await withFailedText();
    expect((await tick(db, new Date('2026-09-22T15:05:00Z'))).booth_texts_sent).toBe(0);
    expect(textsTo(db, 'p1')).toHaveLength(1);

    const res = await r.resend('p1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sms: { status: 'simulated' }, type: 'assignment' });
    const rows = textsTo(db, 'p1');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'simulated', sent_by: 'mgr_w', resend: true, booth_labels: ['V1', 'V2'], seq: 2, segments: 1 });
    expect(rows[1]!.id).toBe(res.json().message_id);
    expect(rows[1]!.id).not.toContain('booth:'); // no dedupe key: a resend is an intentional second text
    expect(rows[1]!.body).toContain('is V1 and V2. Please');
    expect(res.json().assignments.texts.find((t: any) => t.producer_id === 'p1')).toMatchObject({ status: 'sent' });
    const audit = Object.values(db.dump('audit_log')).filter((a: any) => a.action === 'market_date.assignments.resend_text') as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'mgr_w', after: { producer_id: 'p1', type: 'assignment', status: 'simulated', cycle: 'next' } });
    expect(JSON.stringify(audit[0])).not.toContain('+1501555');

    // A second resend is a second text again (deliberately repeatable).
    expect((await r.resend('p1')).statusCode).toBe(200);
    expect(textsTo(db, 'p1')).toHaveLength(3);
  });

  it('the resend is refused inside quiet hours (409 quiet_hours) and sends nothing', async () => {
    const { db, r } = await withFailedText();
    vi.setSystemTime(T_QUIET);
    const res = await r.resend('p1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'quiet_hours', reason: 'quiet_hours', allowed_at: T_0800.toISOString() });
    expect(textsTo(db, 'p1')).toHaveLength(1);
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'market_date.assignments.resend_text')).toBe(false);
  });

  it('refuses a resend before approval, for a vendor with no booth text, while the engine is about to send it, and for another market', async () => {
    const { db, r } = await drafted();
    expect((await r.resend('p1')).json()).toMatchObject({ code: 'not_approved' });
    vi.setSystemTime(T_QUIET);
    await r.approve();
    vi.setSystemTime(T_0759);
    expect((await r.resend('p1')).json()).toMatchObject({ code: 'quiet_hours' });
    vi.setSystemTime(T_0800);
    const pending = await r.resend('p1'); // approved, the 08:00 engine run has not happened yet
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ code: 'pending' });
    await tick(db, T_0800);
    expect((await r.resend('p5')).json()).toMatchObject({ code: 'nothing_to_send' });
    expect((await r.resend('p1', 'mgr_a')).statusCode).toBe(403);
    expect((await routes(await buildApp(db), SOURCE).resend('')).statusCode).toBe(400);
    expect((await routes(await buildApp(db), 'bogus').resend('p1', 'admin1')).statusCode).toBe(404);
    expect(boothMessages(db)).toHaveLength(4);
  });

  it('a vendor who could not be texted when the texts went out shows excluded, then skipped once they can be - and the resend reaches them', async () => {
    const ctx = await drafted();
    await ctx.db.collection('producers').doc('p3').update({ phone: null });
    expect((await ctx.r.approve()).json().texts).toMatchObject({ sent: 3, excluded: 1 });
    let row = (await ctx.r.view()).texts.find((t: any) => t.producer_id === 'p3');
    expect(row).toMatchObject({ status: 'excluded', reason: 'no_phone', can_resend: false });
    expect((await ctx.r.resend('p3')).json()).toMatchObject({ code: 'not_textable', reason: 'no_phone' });

    await ctx.db.collection('producers').doc('p3').update({ phone: '+15015550103' });
    row = (await ctx.r.view()).texts.find((t: any) => t.producer_id === 'p3');
    expect(row).toMatchObject({ status: 'skipped', can_resend: true });
    expect((await tick(ctx.db, new Date('2026-09-22T15:05:00Z'))).booth_texts_sent).toBe(0); // the engine does not go back for them
    expect((await ctx.r.resend('p3')).statusCode).toBe(200);
    expect((await ctx.r.view()).texts.find((t: any) => t.producer_id === 'p3')).toMatchObject({ status: 'sent' });
  });
});

describe('Y3 — the target date is validated', () => {
  it('approval is refused when the target date is cancelled, and nothing is written', async () => {
    const { db, r } = await drafted();
    await db.collection('market_dates').doc(TARGET).update({ status: 'cancelled', cancellation_reason: 'storm' });
    const res = await r.approve();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'target_cancelled', code: 'target_cancelled' });
    expect(actionsOf(db, SOURCE).approved_at).toBeNull();
    expect(lockKeys(db)).toEqual([`${SOURCE}__drafts`]);
    expect((await r.view()).target_cancelled).toBe(true);
    expect(boothMessages(db)).toHaveLength(0);
  });

  it('approval is refused once the target market has started', async () => {
    const { db, r } = await drafted();
    vi.setSystemTime(new Date('2026-09-26T13:00:00Z')); // 08:00 on the target Saturday
    const res = await r.approve();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'target_started', code: 'target_started' });
    expect(actionsOf(db, SOURCE).approved_at).toBeNull();
    expect(lockKeys(db)).toEqual([`${SOURCE}__drafts`]);
  });

  it('a target cancelled after approval is never texted ("your booth on Sat Sep 26 is V1"); un-cancelling releases the texts', async () => {
    const { db, r } = await approvedInQuietHours();
    await db.collection('market_dates').doc(TARGET).update({ status: 'cancelled', cancellation_reason: 'storm' });
    const open = await tick(db, T_0800);
    expect(open.errors).toEqual([]);
    expect(open.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_blocked: 'cancelled', booth_texts_sent_at: null });
    expect(lockKeys(db)).toEqual([`${SOURCE}__approve`, `${SOURCE}__drafts`]); // re-checked every tick without burning a lock
    vi.setSystemTime(T_0800);
    const view = await r.view();
    expect(view).toMatchObject({ booth_texts_blocked: 'cancelled', booth_texts_due_at: null, target_cancelled: true });
    expect(view.texts.every((t: any) => t.status === 'blocked')).toBe(true);
    expect((await r.resend('p1')).json()).toMatchObject({ code: 'cancelled' });
    expect((await tick(db, new Date('2026-09-23T13:05:00Z'))).booth_texts_sent).toBe(0);

    await db.collection('market_dates').doc(TARGET).update({ status: 'collecting', cancellation_reason: null });
    const back = await tick(db, new Date('2026-09-23T13:10:00Z'));
    expect(back.booth_texts_sent).toBe(4);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_blocked: null, booth_texts_sent_at: new Date('2026-09-23T13:10:00Z') });
  });

  it('texts whose quiet hours end when the market starts are never sent, and the panel is told so in advance', async () => {
    const { db, r } = await drafted();
    vi.setSystemTime(new Date('2026-09-26T03:00:00Z')); // Fri 22:00 CDT, the night before the target market
    const res = await r.approve();
    expect(res.statusCode).toBe(200);
    expect(res.json().texts.deferred_until).toBe('2026-09-26T13:00:00.000Z'); // 08:00 = the market's start
    expect(res.json().assignments).toMatchObject({ booth_texts_too_late: true, booth_texts_blocked: null });

    const atStart = new Date('2026-09-26T13:00:00Z');
    const run = await tick(db, atStart);
    expect(run.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);
    expect(actionsOf(db, SOURCE)).toMatchObject({ booth_texts_blocked: 'started', booth_texts_sent_at: null });
    vi.setSystemTime(atStart);
    expect(await r.view()).toMatchObject({ booth_texts_blocked: 'started', target_started: true, booth_texts_too_late: false });
    // Final: the engine stops looking (no further write, no lock).
    const stamp = (db.dump('market_dates')[SOURCE] as any).updated_at;
    await tick(db, new Date('2026-09-26T13:05:00Z'));
    expect((db.dump('market_dates')[SOURCE] as any).updated_at).toEqual(stamp);
    expect(lockKeys(db)).toEqual([`${SOURCE}__approve`, `${SOURCE}__drafts`]);
  });
});

describe('Y4 — approved dates are never stranded outside the 7-day window', () => {
  const OLD = 'wlrfm_2026-09-12';

  async function oldSource(): Promise<{ db: Db; app: App }> {
    const db = seed();
    // An older collecting date whose next market is still TARGET (the Saturday between was cancelled).
    await db.collection('market_dates').doc(OLD).set(dateDoc('2026-09-12', SOURCE_DONE));
    await db.collection('market_dates').doc(SOURCE).update({ status: 'cancelled' });
    for (const p of ['p1', 'p2', 'p3', 'p6']) await db.collection('checkins').doc(`${OLD}_${p}`).set(checkin(OLD, p, true));
    return { db, app: await buildApp(db) };
  }

  it('an approval in quiet hours for a date older than the window is texted at 08:00 by the engine', async () => {
    const { db, app } = await oldSource();
    const r = routes(app, OLD);
    vi.setSystemTime(T_QUIET); // the old date closed 10 days ago
    expect((await r.draft()).statusCode).toBe(200);
    const res = await r.approve();
    expect(res.statusCode).toBe(200);
    expect(res.json().texts.deferred_until).toBe(T_0800.toISOString());
    expect((await r.status()).in_window).toBe(false);

    const early = await tick(db, T_0759);
    expect(early.booth_texts_sent).toBe(0);
    const open = await tick(db, T_0800);
    expect(open.errors).toEqual([]);
    expect(open.considered).toBe(0); // no date is inside the automatic window...
    expect(open.booth_texts_sent).toBe(4); // ...and the approved one is texted all the same
    expect(boothMessages(db).every((m) => m.market_date_id === TARGET && m.source_date_id === OLD)).toBe(true);
    expect(actionsOf(db, OLD).booth_texts_sent_at).toEqual(T_0800);
    expect(actionsOf(db, OLD).checkin_sent_at).toEqual(SOURCE_DONE.checkin_sent_at); // no other step ran for it
    expect((await tick(db, new Date('2026-09-23T13:05:00Z'))).booth_texts_sent).toBe(0);
  });

  it('a corrective text for a date older than the window is sent too, and the other steps stay inside the window', async () => {
    const { db, app } = await oldSource();
    const r = routes(app, OLD);
    await db.collection('market_dates').doc(OLD).update({ 'actions.checkin_sent_at': null }); // would be due if the window did not apply
    vi.setSystemTime(T_WED_10);
    await r.draft();
    expect((await r.approve()).json().texts).toMatchObject({ sent: 4 });
    await r.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    const run = await tick(db, T_WED_1005);
    expect(run.booth_texts_sent).toBe(1);
    expect(run.checkin_sent).toBe(0);
    expect(actionsOf(db, OLD).checkin_sent_at).toBeNull();
    expect(Object.values(db.dump('messages')).filter((m: any) => m.kind !== 'booth')).toEqual([]);
  });

  it('a settled date is left alone: no write, no lock, no text', async () => {
    const { db } = await texted();
    const before = JSON.stringify([db.dump('market_dates'), db.dump('workflow_locks'), db.dump('messages')]);
    const run = await tick(db, T_WED_1005);
    expect(run.booth_texts_sent).toBe(0);
    expect(run.skipped_claimed).toBe(0);
    expect(JSON.stringify([db.dump('market_dates'), db.dump('workflow_locks'), db.dump('messages')])).toBe(before);
  });

  it('an inactive market is left alone', async () => {
    const { db } = await approvedInQuietHours();
    await db.collection('farmers_markets').doc('wlrfm').update({ active: false });
    expect((await tick(db, T_0800)).booth_texts_sent).toBe(0);
  });
});
