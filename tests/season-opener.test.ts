// Phase 4 fix (booth side), item Y5: the first market date of a season is self-sourced.
// It has no earlier market of the same season to ask "are you attending next?", so its own
// document carries a second assignment cycle (actions.opener.*) whose target is itself and
// whose list starts from the season's ACTIVE seasonal-plan vendors. Staff draft it by hand;
// approval and texts then follow the same rules as every other date.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEDUPE_KEYS } from '../src/services/checkin-workflow.js';
import { fakeDb } from './helpers/fake-db.js';
import {
  D0, PRODUCERS, USERS, actionsOf, boothMessages, boothsOf, buildApp, checkin, currentRows, dateDoc, marketDoc, newestRowId, routes, standardBooths, tick,
} from './helpers/booth-fixtures.js';
import type { Db } from './helpers/booth-fixtures.js';

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

// The season is DATA on the market: a schedule version and the season settings that name it.
const LAST_2026 = 'wlrfm_2026-10-31';
const OPENER = 'wlrfm_2027-04-03'; // Sat 08:00-12:00 CDT = 13:00-17:00Z
const SECOND = 'wlrfm_2027-04-10';
const THIRD = 'wlrfm_2027-04-17';

const T_FEB = new Date('2027-02-10T16:00:00Z'); // Wed 10:00 CST, seven weeks before opening day
const T_FEB_QUIET = new Date('2027-02-11T04:00:00Z'); // Wed 22:00 CST
const T_FEB_0759 = new Date('2027-02-11T13:59:00Z');
const T_FEB_0800 = new Date('2027-02-11T14:00:00Z'); // Thu 08:00 CST

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_FEB);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const version = (id: string, start: string, end: string) => ({
  id, effective_from: start, season_start: start, season_end: end, days_of_week: ['saturday'], start_time: '08:00', end_time: '12:00', created_at: D0, created_by: 'test',
});

const member = (producer: string, extra: Record<string, unknown> = {}) => ({
  producer_id: producer, market_id: 'wlrfm', season: '2027', status: 'active', fee_plan: 'seasonal', spaces: 1, electric: false, booth_kind: 'stall', usual_booth_id: null, ...extra,
});

function seed(): Db {
  return fakeDb({
    users: USERS,
    farmers_markets: {
      wlrfm: marketDoc({
        schedule: { versions: [version('v26', '2026-04-04', '2026-10-31'), version('v27', '2027-04-03', '2027-11-27')], skipped_dates: [], special_dates: [] },
        season: { label: '2027', application_open: '2026-12-01', application_close: null, schedule_version_id: 'v27' },
      }),
    },
    market_dates: {
      [LAST_2026]: dateDoc('2026-10-31'),
      [OPENER]: dateDoc('2027-04-03'),
      [SECOND]: dateDoc('2027-04-10'),
      [THIRD]: dateDoc('2027-04-17'),
    },
    booths: standardBooths(),
    producers: { ...PRODUCERS, p7: { business_name: 'Old Timer Farm', contact_name: 'Otto Old', phone: '+15015550107', active: true } },
    producer_memberships: {
      // 2027: p1 two spaces on the usual V1; p2 electric on the powered usual V3; p3 seasonal, no usual booth;
      // p4 on the DAILY plan; p5 approved but not yet active (no signed agreement); p6 the food truck.
      p1_wlrfm_2027: member('p1', { spaces: 2, usual_booth_id: 'wlrfm_v1' }),
      p2_wlrfm_2027: member('p2', { electric: true, usual_booth_id: 'wlrfm_v3' }),
      p3_wlrfm_2027: member('p3'),
      p4_wlrfm_2027: member('p4', { fee_plan: 'daily' }),
      p5_wlrfm_2027: member('p5', { status: 'approved' }),
      p6_wlrfm_2027: member('p6', { booth_kind: 'food_truck' }),
      // Last season's vendors never count for this one.
      p7_wlrfm: { producer_id: 'p7', market_id: 'wlrfm', season: '2026', status: 'active', fee_plan: 'season', usual_booth_id: 'wlrfm_v5' },
      p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', season: '2026', status: 'active', fee_plan: 'season' },
    },
  });
}

async function boot() {
  const db = seed();
  const app = await buildApp(db);
  return { db, app, opener: routes(app, OPENER, 'opener'), next: routes(app, OPENER) };
}

async function draftedOpener() {
  const ctx = await boot();
  const res = await ctx.opener.draft();
  expect(res.statusCode).toBe(200);
  return { ...ctx, draft: res.json() };
}

const textsTo = (db: Db, producer: string) => boothMessages(db).filter((m) => m.producer_id === producer);

describe('the season opener is offered its own, self-sourced assignments', () => {
  it('the status of the opening day carries the opener view: the list starts from seasonal vendors', async () => {
    const { opener, app } = await boot();
    const status = await opener.status();
    expect(status.is_season_opener).toBe(true);
    const view = status.opener_assignments;
    expect(view).toMatchObject({ cycle: 'opener', season: '2027', drafted_at: null, approved_at: null });
    expect(view.target_date).toMatchObject({ id: OPENER, date: '2027-04-03', date_label: 'Saturday, Apr 3, 2027' }); // its own target
    expect(view.attending.map((v: any) => [v.producer_id, v.fee_plan, v.added_by_staff])).toEqual([
      ['p1', 'seasonal', false], ['p2', 'seasonal', false], ['p3', 'seasonal', false], ['p6', 'seasonal', false],
    ]);
    expect(view.can_add.map((v: any) => [v.producer_id, v.fee_plan, v.reason])).toEqual([['p4', 'daily', 'daily_plan']]);
    expect(view.not_attending).toEqual([]);
    expect(view.no_answer).toEqual([]);
    // The cycle every date has is still there: after opening day its check-ins assign the second Saturday.
    expect(status.assignments).toMatchObject({ cycle: 'next', target_date: { id: SECOND } });

    const second = await routes(app, SECOND).status();
    expect(second.is_season_opener).toBe(false);
    expect(second.opener_assignments).toBeNull();
  });

  it('the engine never drafts an opener on its own', async () => {
    const { db } = await boot();
    const run = await tick(db, T_FEB);
    expect(run.errors).toEqual([]);
    expect(run.considered).toBe(0);
    expect(run.drafts_generated).toBe(0);
    expect(db.count('booth_assignments')).toBe(0);
    expect(actionsOf(db, OPENER).opener).toBeUndefined();
  });

  it('only the first market date of the season can be drafted as an opener', async () => {
    const { db, app } = await boot();
    const res = await routes(app, SECOND, 'opener').draft();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'not_opener' });
    expect(db.count('booth_assignments')).toBe(0);
    expect(db.count('workflow_locks')).toBe(0);
    // When opening day is cancelled, the next Saturday becomes the opener.
    await db.collection('market_dates').doc(OPENER).update({ status: 'cancelled', cancellation_reason: 'ice' });
    expect((await routes(app, SECOND, 'opener').draft()).statusCode).toBe(200);
    expect((await routes(app, SECOND).status()).is_season_opener).toBe(true);
  });
});

describe('drafting the opener by hand', () => {
  it('seats seasonal vendors for the opening day itself: usual booths, power, a two-space vendor, the food truck', async () => {
    const { db, draft } = await draftedOpener();
    expect(draft.draft).toMatchObject({ skipped: null, target_date_id: OPENER, vendors_placed: 4, vendors_unassigned: 0, rows_written: 5, warnings: [] });

    const rows = currentRows(db, OPENER);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.market_date_id === OPENER && r.source_date_id === OPENER && r.assigned_by === 'mgr_w')).toBe(true);
    expect(boothsOf(rows, 'p1')).toEqual(['wlrfm_v1', 'wlrfm_v2']); // usual + neighbour
    expect(boothsOf(rows, 'p2')).toEqual(['wlrfm_v3']); // usual, powered
    expect(boothsOf(rows, 'p3')).toEqual(['wlrfm_v7']); // suggested: an unpowered stall
    expect(boothsOf(rows, 'p6')).toEqual(['wlrfm_food-truck']);
    expect(rows.find((r) => r.producer_id === 'p1')!.source).toBe('usual');
    expect(rows.find((r) => r.producer_id === 'p3')!.source).toBe('suggested');
    for (const p of ['p4', 'p5', 'p7']) expect(boothsOf(rows, p)).toEqual([]); // daily plan, not active, last season

    // The opener's state lives under actions.opener (field paths); the date's own "next market" cycle is untouched.
    const actions = actionsOf(db, OPENER);
    expect(actions.opener).toMatchObject({
      drafts_generated_at: T_FEB, assignments_draft_at: T_FEB, assignments_target_date_id: OPENER, drafts_skipped: null,
      booth_summary: { assigned: 4, unassigned: 0, booths_total: 8, booths_free: 3 },
    });
    expect(actions.drafts_generated_at).toBeNull();
    expect(actions.assignments_target_date_id).toBeUndefined();
    expect(actions.checkin_sent_at).toBeNull();
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([`${OPENER}__opener_drafts`]);
    expect(Object.values(db.dump('audit_log')).find((a: any) => a.action === 'market_date.assignments.draft')).toMatchObject({ after: { cycle: 'opener', target_date_id: OPENER } });

    const view = draft.assignments;
    expect(view).toMatchObject({ cycle: 'opener', summary: { assigned: 4, unassigned: 0, conflicts: 0 }, unassigned: [], warnings: [] });
    expect(view.booths.find((b: any) => b.booth.label === 'V1').assignment).toMatchObject({ producer_id: 'p1', source: 'usual' });
  });

  it('an electric seasonal vendor whose usual stall has no power keeps it, and staff are warned', async () => {
    const { db, opener } = await boot();
    await db.collection('producer_memberships').doc('p2_wlrfm_2027').update({ usual_booth_id: 'wlrfm_v5' });
    const res = await opener.draft();
    expect(res.json().draft.warnings).toEqual([{ producer_id: 'p2', reason: 'power_mismatch', booth_ids: ['wlrfm_v5'] }]);
    expect(boothsOf(currentRows(db, OPENER), 'p2')).toEqual(['wlrfm_v5']);
    expect(res.json().assignments.warnings).toEqual([{ producer_id: 'p2', business_name: 'Beta Farm', reason: 'power_mismatch', booth_ids: ['wlrfm_v5'] }]);
  });

  it('a redraft keeps manual placements; a second plain draft is refused', async () => {
    const { db, opener } = await draftedOpener();
    expect((await opener.draft()).json()).toMatchObject({ reason: 'already_drafted' });
    await opener.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    await db.collection('producer_memberships').doc('p5_wlrfm_2027').update({ status: 'active' }); // p5 signs the agreement
    vi.setSystemTime(new Date('2027-02-10T17:00:00Z'));
    const again = await opener.draft({ redraft: true });
    expect(again.statusCode).toBe(200);
    const rows = currentRows(db, OPENER);
    expect(boothsOf(rows, 'p3')).toEqual(['wlrfm_v6']);
    expect(boothsOf(rows, 'p5')).toEqual(['wlrfm_v7']);
    expect(Object.keys(db.dump('workflow_locks')).sort()).toEqual([`${OPENER}__opener_drafts`, `${OPENER}__opener_redraft_${T_FEB.getTime()}`]);
  });

  it('with no seasonal vendor yet the draft is empty, and vendors are added by hand', async () => {
    const { db, opener } = await boot();
    for (const id of ['p1', 'p2', 'p3', 'p6']) await db.collection('producer_memberships').doc(`${id}_wlrfm_2027`).update({ fee_plan: 'daily' });
    const res = await opener.draft();
    expect(res.statusCode).toBe(200);
    expect(res.json().draft).toMatchObject({ vendors_placed: 0, rows_written: 0 });
    expect(res.json().assignments.can_add).toHaveLength(5);
    expect((await opener.patch([{ producer_id: 'p1', booth_ids: ['wlrfm_v1', 'wlrfm_v2'] }])).statusCode).toBe(200);
  });

  it('a daily-plan vendor is added by hand; a vendor outside this season cannot be', async () => {
    const { db, opener } = await draftedOpener();
    const res = await opener.patch([{ producer_id: 'p4', booth_ids: ['wlrfm_v5'] }]);
    expect(res.statusCode).toBe(200);
    expect(currentRows(db, OPENER).find((r) => r.producer_id === 'p4')).toMatchObject({ booth_id: 'wlrfm_v5', source: 'manual', assigned_by: 'mgr_w', source_date_id: OPENER });
    const view = res.json().assignments;
    expect(view.attending.find((v: any) => v.producer_id === 'p4')).toMatchObject({ fee_plan: 'daily', added_by_staff: true, booth_ids: ['wlrfm_v5'] });
    expect(view.can_add).toEqual([]);
    expect(view.summary).toMatchObject({ assigned: 5, unassigned: 0 });
    expect(actionsOf(db, OPENER).opener.booth_summary).toMatchObject({ assigned: 5 });

    expect((await opener.patch([{ producer_id: 'p7', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(400); // a 2026 membership only
    expect((await opener.patch([{ producer_id: 'p5', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(400); // approved, not active
    // The opener's changes never touch the date's "next market" cycle.
    expect(actionsOf(db, OPENER).assignments_rev).toBeUndefined();
  });
});

describe('approving and texting the opener', () => {
  async function approvedOpener() {
    const ctx = await draftedOpener();
    await ctx.opener.patch([{ producer_id: 'p4', booth_ids: ['wlrfm_v5'] }]);
    vi.setSystemTime(T_FEB_QUIET);
    const res = await ctx.opener.approve();
    expect(res.statusCode).toBe(200);
    return { ...ctx, approval: res.json() };
  }

  it('approved in quiet hours, the engine texts at 08:00 although opening day is months outside the 7-day window', async () => {
    const { db, opener, approval } = await approvedOpener();
    expect(approval.texts).toEqual({ attempted: false, sent: 0, failed: 0, excluded: 0, deferred_until: T_FEB_0800.toISOString() });
    expect(approval.assignments).toMatchObject({ approved_by: 'mgr_w', booth_texts_due_at: T_FEB_0800.toISOString(), booth_texts_too_late: false, booth_texts_blocked: null });
    expect(actionsOf(db, OPENER).opener).toMatchObject({ approved_at: T_FEB_QUIET, approved_by: 'mgr_w' });
    expect(actionsOf(db, OPENER).opener.booth_texts_sent_at).toBeUndefined(); // nothing sent yet
    expect(actionsOf(db, OPENER).approved_at).toBeNull(); // the "next market" cycle is not approved
    expect(boothMessages(db)).toHaveLength(0);
    expect((await opener.status()).next_due).toEqual({ action: 'booth_texts', at: T_FEB_0800.toISOString() });

    const early = await tick(db, T_FEB_0759);
    expect(early.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);

    vi.setSystemTime(T_FEB_0800);
    const open = await tick(db, T_FEB_0800);
    expect(open.errors).toEqual([]);
    expect(open.considered).toBe(0); // opening day is seven weeks away: no date is in the automatic window
    expect(open.checkin_sent).toBe(0);
    expect(open.booth_texts_sent).toBe(5);

    const msgs = boothMessages(db);
    expect(msgs.map((m) => m.producer_id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p6']);
    for (const m of msgs) {
      expect(m).toMatchObject({ kind: 'booth', market_date_id: OPENER, source_date_id: OPENER, booth_text: 'assignment', segments: 1, status: 'simulated' });
      expect(m.id).toBe(DEDUPE_KEYS.booth(OPENER, m.producer_id, newestRowId(db, OPENER, m.producer_id)));
      expect(m.body).toContain('on Sat Apr 3 is ');
    }
    expect(textsTo(db, 'p1')[0]!.body).toBe('SJCA Markets: Alice, your booth at West Little Rock Farmers Market on Sat Apr 3 is V1 and V2. Please check in at the table when you arrive.');
    expect(textsTo(db, 'p4')[0]!.body).toContain('is V5.'); // the daily-plan vendor staff added

    const actions = actionsOf(db, OPENER);
    expect(actions.opener).toMatchObject({ booth_texts_sent_at: T_FEB_0800, booth_text_recipients: 5, booth_text_failed: 0, booth_text_excluded: 0, booth_texts_blocked: null });
    expect(actions.booth_texts_sent_at).toBeNull();
    expect(Object.keys(db.dump('workflow_locks')).sort()).toEqual([`${OPENER}__opener_approve`, `${OPENER}__opener_booth_texts_${actions.opener.assignments_rev}`, `${OPENER}__opener_drafts`]);

    // Later ticks and a second approval change nothing.
    expect((await tick(db, new Date('2027-02-11T14:05:00Z'))).booth_texts_sent).toBe(0);
    expect((await opener.approve()).json()).toMatchObject({ reason: 'already_approved' });
    expect(boothMessages(db)).toHaveLength(5);
    expect((await opener.status()).next_due).toEqual({ action: 'checkin', at: '2027-04-03T18:00:00.000Z' });
    expect((await opener.view()).texts.every((t: any) => t.status === 'sent')).toBe(true);
  });

  it('follows the same rules as every other date: no double booking after approval, one corrective text, a release notice', async () => {
    const { db, opener } = await approvedOpener();
    vi.setSystemTime(T_FEB_0800);
    await tick(db, T_FEB_0800);

    const clash = await opener.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v3'] }]);
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: 'conflict', booth_label: 'V3' });

    const moved = await opener.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }, { producer_id: 'p4', booth_ids: [] }]);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().warning).toBe('approved');
    const run = await tick(db, new Date('2027-02-11T14:05:00Z'));
    expect(run.booth_texts_sent).toBe(2);
    expect(textsTo(db, 'p3')[1]!.body).toContain('on Sat Apr 3 is now V6.');
    expect(textsTo(db, 'p4')[1]).toMatchObject({ booth_text: 'release' });
    expect(textsTo(db, 'p4')[1]!.body).toContain('no longer assigned a booth at West Little Rock Farmers Market on Sat Apr 3.');
    expect((await tick(db, new Date('2027-02-11T14:10:00Z'))).booth_texts_sent).toBe(0);

    const resend = await opener.resend('p1');
    expect(resend.statusCode).toBe(200);
    expect(textsTo(db, 'p1')).toHaveLength(2);
    expect(Object.values(db.dump('audit_log')).find((a: any) => a.action === 'market_date.assignments.resend_text')).toMatchObject({ after: { cycle: 'opener', producer_id: 'p1' } });
  });

  it('once opening day has started its assignments can no longer be approved, changed or texted', async () => {
    const { db, opener } = await draftedOpener();
    vi.setSystemTime(new Date('2027-04-03T13:00:00Z'));
    expect((await opener.approve()).json()).toMatchObject({ reason: 'target_started' });
    expect(actionsOf(db, OPENER).opener.approved_at).toBeUndefined();
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([`${OPENER}__opener_drafts`]); // a refused approval takes no lock
    // (Approved earlier, a change after the start is refused as well.)
    await db.collection('market_dates').doc(OPENER).update({ 'actions.opener.approved_at': T_FEB, 'actions.opener.approved_by': 'mgr_w' });
    expect((await opener.patch([{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }])).json()).toMatchObject({ code: 'target_started' });
    expect((await opener.resend('p1')).json()).toMatchObject({ code: 'started' });
    expect((await tick(db, new Date('2027-04-03T13:05:00Z'))).booth_texts_sent).toBe(0);
    expect(actionsOf(db, OPENER).opener.booth_texts_blocked).toBe('started');
    expect(boothMessages(db)).toHaveLength(0);
  });

  it('a cancelled opening day is never texted', async () => {
    const { db } = await approvedOpener();
    await db.collection('market_dates').doc(OPENER).update({ status: 'cancelled', cancellation_reason: 'ice' });
    expect((await tick(db, T_FEB_0800)).booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);
  });
});

describe('the dates around the opener', () => {
  it('the last market of the previous season has nothing to assign: it must not seat last season on opening day', async () => {
    const { db, app } = await boot();
    const last = routes(app, LAST_2026);
    expect((await last.view()).target_date).toBeNull();
    const res = await last.draft();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'no_next_date' });

    // The engine records the same skip once (the date is inside its window three days after it closed).
    const T_DRAFTS = new Date('2026-11-03T18:00:00Z');
    await db.collection('market_dates').doc(LAST_2026).update({
      'actions.checkin_sent_at': new Date('2026-10-31T18:00:00Z'), 'actions.deadline_processed_at': new Date('2026-11-03T17:00:00Z'), 'actions.summary_skipped': 'no_recipients',
    });
    const run = await tick(db, T_DRAFTS);
    expect(run.errors).toEqual([]);
    expect(run.drafts_generated).toBe(0);
    expect(actionsOf(db, LAST_2026)).toMatchObject({ drafts_skipped: 'no_next_date', drafts_generated_at: T_DRAFTS });
    expect(db.count('booth_assignments')).toBe(0);
  });

  it('the second Saturday is still drafted from the opening day check-ins, next to the opener cycle on the same document', async () => {
    const { db, next } = await draftedOpener();
    const openerRows = JSON.stringify(currentRows(db, OPENER));
    const openerState = JSON.stringify(actionsOf(db, OPENER).opener);

    // Opening day happened; the weekly check-in ran; p1 and the daily-plan p4 are coming next week, p2 is not.
    await db.collection('market_dates').doc(OPENER).update({
      'actions.checkin_sent_at': new Date('2027-04-03T18:00:00Z'), 'actions.deadline_processed_at': new Date('2027-04-06T17:00:00Z'), 'actions.summary_sent_at': new Date('2027-04-06T17:05:00Z'),
      'actions.reminder_state.offset_1440': { offset_min: 1440, sent_at: new Date('2027-04-04T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
      'actions.reminder_state.offset_2880': { offset_min: 2880, sent_at: new Date('2027-04-05T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
    });
    await db.collection('checkins').doc(`${OPENER}_p1`).set(checkin(OPENER, 'p1', true));
    await db.collection('checkins').doc(`${OPENER}_p4`).set(checkin(OPENER, 'p4', true));
    await db.collection('checkins').doc(`${OPENER}_p2`).set(checkin(OPENER, 'p2', false));

    const T_DRAFTS = new Date('2027-04-06T18:00:00Z'); // close + 4380 min
    vi.setSystemTime(T_DRAFTS);
    const run = await tick(db, T_DRAFTS);
    expect(run.errors).toEqual([]);
    expect(run.drafts_generated).toBe(1);

    const rows = currentRows(db, SECOND);
    expect(rows.every((r) => r.source_date_id === OPENER && r.assigned_by === 'engine')).toBe(true);
    expect(boothsOf(rows, 'p1')).toEqual(['wlrfm_v1', 'wlrfm_v2']);
    expect(boothsOf(rows, 'p4')).toHaveLength(1);
    expect(boothsOf(rows, 'p2')).toEqual([]);
    const actions = actionsOf(db, OPENER);
    expect(actions).toMatchObject({ drafts_generated_at: T_DRAFTS, assignments_target_date_id: SECOND, drafts_skipped: null });
    // The opener's own cycle and its rows are exactly as they were.
    expect(JSON.stringify(actions.opener)).toBe(openerState);
    expect(JSON.stringify(currentRows(db, OPENER))).toBe(openerRows);

    const view = await next.view();
    expect(view).toMatchObject({ cycle: 'next', target_date: { id: SECOND } });
    expect(view.attending.map((v: any) => v.producer_id)).toEqual(['p1', 'p4']);
    expect(view.not_attending.map((v: any) => v.producer_id)).toEqual(['p2']);
    // The opener panel is still offered afterwards because it was used.
    expect((await next.status()).opener_assignments).toMatchObject({ cycle: 'opener', target_started: true });
  });

  it('refuses to draft opening day while the market is still in last season (no season label yet): it would seat last season', async () => {
    const db = seed();
    // Next year's schedule version exists, but the season was never set: the current season is still inferred as 2026.
    await db.collection('farmers_markets').doc('wlrfm').update({ season: null });
    const app = await buildApp(db);
    const opener = routes(app, OPENER, 'opener');
    expect((await opener.view()).season).toBe('2026');
    const res = await opener.draft();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'season_mismatch' });
    expect(db.count('booth_assignments')).toBe(0);
    expect(db.count('workflow_locks')).toBe(0);
    expect(actionsOf(db, OPENER).opener).toBeUndefined();
  });

  it('a market with no schedule version has no opener at all (Phase 3 fixtures)', async () => {
    const db = seed();
    await db.collection('farmers_markets').doc('wlrfm').update({ schedule: { versions: [], skipped_dates: [], special_dates: [] }, season: null });
    const app = await buildApp(db);
    const status = await routes(app, OPENER).status();
    expect(status.is_season_opener).toBe(false);
    expect(status.opener_assignments).toBeNull();
    expect((await routes(app, OPENER, 'opener').draft()).json()).toMatchObject({ reason: 'not_opener' });
    // And without an opener the last 2026 date simply targets the next date again.
    expect((await routes(app, LAST_2026).view()).target_date).toMatchObject({ id: OPENER });
  });
});
