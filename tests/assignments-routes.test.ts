import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { marketDateRoutes } from '../src/routes/market-dates.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { FarmersMarket } from '../src/services/markets.js';
import { marketDateFromData } from '../src/services/market-dates.js';
import { applyAssignmentChanges } from '../src/services/booth-assignments.js';
import type { Env } from '../src/config/env.js';

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

const env = {
  NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example', ALERT_EMAIL: '', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

const SOURCE = 'wlrfm_2026-09-19';
const TARGET = 'wlrfm_2026-09-26';
const T_MORNING = new Date('2026-09-22T15:00:00Z'); // Tue 10:00 CDT, outside quiet hours

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_MORNING);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const D0 = new Date('2026-01-01T00:00:00Z');

function boothDoc(label: string, row: string, order: number, extra: Record<string, unknown> = {}) {
  return { market_id: 'wlrfm', label, row, order, kind: 'stall', power: false, size: '12x12', notes: '', active: true, created_at: D0, updated_at: D0, ...extra };
}

function dateDoc(date: string, end: string, actions: Record<string, unknown>) {
  return {
    market_id: 'wlrfm', date, start_time: '08:00', end_time: '12:00',
    start_at: new Date(`${date}T13:00:00Z`), end_at: new Date(end),
    status: 'collecting', schedule_version: 'v1', special: false, note: '',
    actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date(end), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null, ...actions },
    extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
    generated_at: D0, source: 'import', created_at: D0, updated_at: D0,
  };
}

const SOURCE_DONE = {
  checkin_sent_at: new Date('2026-09-19T18:00:00Z'), deadline_processed_at: new Date('2026-09-22T17:00:00Z'), summary_sent_at: new Date('2026-09-22T17:05:00Z'),
  reminder_state: {
    offset_1440: { offset_min: 1440, sent_at: new Date('2026-09-20T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
    offset_2880: { offset_min: 2880, sent_at: new Date('2026-09-21T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' },
  },
};

function checkin(date: string, producer: string, attending: boolean | null) {
  return { market_date_id: `wlrfm_${date}`, producer_id: producer, attending_next: attending, submitted_at: new Date('2026-09-20T12:00:00Z'), source: 'form', partial: false };
}

interface SeedOpts {
  booths?: boolean;
  target?: boolean;
  attendees?: boolean;
  sourceActions?: Record<string, unknown>;
}

function seed(opts: SeedOpts = {}) {
  const { booths = true, target = true, attendees = true, sourceActions = {} } = opts;
  const boothDocs: Record<string, Record<string, unknown>> = {};
  if (booths) {
    boothDocs.wlrfm_v1 = boothDoc('V1', 'west', 1);
    boothDocs.wlrfm_v2 = boothDoc('V2', 'west', 2);
    boothDocs.wlrfm_v3 = boothDoc('V3', 'west', 3, { power: true });
    boothDocs.wlrfm_v4 = boothDoc('V4', 'west', 4, { power: true });
    boothDocs.wlrfm_v5 = boothDoc('V5', 'west', 5);
    boothDocs.wlrfm_v6 = boothDoc('V6', 'west', 6);
    boothDocs.wlrfm_v7 = boothDoc('V7', 'east', 1);
    boothDocs.wlrfm_v8 = boothDoc('V8', 'east', 2, { active: false });
    boothDocs['wlrfm_food-truck'] = boothDoc('Food truck', 'center', 1, { kind: 'food_truck' });
  }
  const dates: Record<string, Record<string, unknown>> = {
    [SOURCE]: dateDoc('2026-09-19', '2026-09-19T17:00:00Z', { ...SOURCE_DONE, ...sourceActions }),
  };
  if (target) dates[TARGET] = dateDoc('2026-09-26', '2026-09-26T17:00:00Z', {});
  return fakeDb({
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', assigned_market_ids: ['argenta'] },
    },
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' }, timezone: 'America/Chicago',
        schedule: { versions: [], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
        active: true, created_by: 'test', created_at: D0, updated_at: D0,
      },
    },
    market_dates: dates,
    booths: boothDocs,
    producers: {
      p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
      p2: { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: '+15015550102', active: true },
      p3: { business_name: 'Gamma Farm', contact_name: 'Gus Grape', phone: '+15015550103', active: true },
      p4: { business_name: 'Delta Farm', contact_name: 'Dee Date', phone: '+15015550104', active: true },
      p5: { business_name: 'Epsilon Farm', contact_name: 'Eve Elder', phone: '+15015550105', active: true },
      p6: { business_name: 'Zeta Truck', contact_name: 'Zed Zest', phone: '+15015550106', active: true },
    },
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', spaces: 2, usual_booth_id: 'wlrfm_v1' },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active', electric: true, usual_booth_id: 'wlrfm_v3' },
      p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
      p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', status: 'active' },
      p5_wlrfm: { producer_id: 'p5', market_id: 'wlrfm', status: 'active' },
      p6_wlrfm: { producer_id: 'p6', market_id: 'wlrfm', status: 'active', booth_kind: 'food_truck' },
    },
    checkins: attendees
      ? {
          [`${SOURCE}_p1`]: checkin('2026-09-19', 'p1', true),
          [`${SOURCE}_p2`]: checkin('2026-09-19', 'p2', true),
          [`${SOURCE}_p3`]: checkin('2026-09-19', 'p3', true),
          [`${SOURCE}_p4`]: checkin('2026-09-19', 'p4', false),
          [`${SOURCE}_p6`]: checkin('2026-09-19', 'p6', true),
        }
      : { [`${SOURCE}_p4`]: checkin('2026-09-19', 'p4', false) },
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
  await app.ready();
  return app;
}

const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });
const draft = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown = {}, user = 'mgr_w') =>
  app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/draft`, headers: auth(user), payload: payload as never });

function currentRows(db: ReturnType<typeof fakeDb>) {
  return Object.entries(db.dump('booth_assignments'))
    .map(([id, r]) => ({ id, ...(r as any) }))
    .filter((r) => r.market_date_id === TARGET && r.superseded_by === null);
}
const boothsOf = (rows: any[], producer: string) => rows.filter((r) => r.producer_id === producer).map((r) => r.booth_id).sort();

describe('POST /api/market-dates/:id/assignments/draft', () => {
  it('drafts booths for the NEXT market date from the attending check-ins', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await draft(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const rows = currentRows(db);
    expect(boothsOf(rows, 'p1')).toEqual(['wlrfm_v1', 'wlrfm_v2']); // usual + neighbour
    expect(boothsOf(rows, 'p2')).toEqual(['wlrfm_v3']);
    // Unpowered, so V4 stays free for someone who needs power. Rows sort alphabetically: east (V7) before west.
    expect(boothsOf(rows, 'p3')).toEqual(['wlrfm_v7']);
    expect(boothsOf(rows, 'p6')).toEqual(['wlrfm_food-truck']);
    expect(boothsOf(rows, 'p4')).toEqual([]); // not attending
    expect(boothsOf(rows, 'p5')).toEqual([]); // never answered
    for (const r of rows) {
      expect(r.market_id).toBe('wlrfm');
      expect(r.source_date_id).toBe(SOURCE);
      expect(r.assigned_by).toBe('mgr_w');
    }
    expect(rows.find((r) => r.producer_id === 'p1')!.source).toBe('usual');
    expect(rows.find((r) => r.producer_id === 'p3')!.source).toBe('suggested');

    expect(body.draft).toMatchObject({ skipped: null, target_date_id: TARGET, vendors_placed: 4, vendors_unassigned: 0 });
    expect(body.assignments.target_date).toMatchObject({ id: TARGET, date: '2026-09-26', date_label: 'Saturday, Sep 26, 2026' });
    expect(body.assignments.summary).toEqual({ assigned: 4, unassigned: 0, booths_total: 8, booths_free: 3, conflicts: 0 });
    expect(body.assignments.not_attending.map((v: any) => v.producer_id)).toEqual(['p4']);
    expect(body.assignments.no_answer.map((v: any) => v.producer_id)).toEqual(['p5']);
    expect(body.assignments.booths).toHaveLength(8); // the retired V8 is hidden
    const v1 = body.assignments.booths.find((b: any) => b.booth.label === 'V1');
    expect(v1.assignment).toMatchObject({ producer_id: 'p1', business_name: 'Acme Farm', source: 'usual' });

    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'market_date.assignments.draft')).toBe(true);
  });

  it('writes actions field paths and leaves the other flags alone', async () => {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.checkin_sent_at).toEqual(SOURCE_DONE.checkin_sent_at);
    expect(actions.deadline_processed_at).toEqual(SOURCE_DONE.deadline_processed_at);
    expect(actions.summary_sent_at).toEqual(SOURCE_DONE.summary_sent_at);
    expect(actions.drafts_generated_at).toEqual(T_MORNING);
    expect(actions.assignments_draft_at).toEqual(T_MORNING);
    expect(actions.assignments_target_date_id).toBe(TARGET);
    expect(actions.drafts_skipped).toBeNull();
    expect(actions.booth_summary).toEqual({ assigned: 4, unassigned: 0, booths_total: 8, booths_free: 3 });
    expect(actions.claims.drafts).toEqual(T_MORNING);
    // The target date is untouched.
    expect((db.dump('market_dates')[TARGET] as any).actions.drafts_generated_at).toBeNull();
  });

  it('409s a second draft without redraft and does not duplicate rows', async () => {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    const before = db.count('booth_assignments');
    const second = await draft(app);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('Already drafted');
    expect(db.count('booth_assignments')).toBe(before);
  });

  it('redraft supersedes the non-manual rows only and keeps manual ones as fixed', async () => {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    // Manager moves p3 to V6 (manual).
    const moved = await app.inject({
      method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth('mgr_w'), payload: { changes: [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }] },
    });
    expect(moved.statusCode).toBe(200);
    // The data changes: p3 is the only one whose answer matters here; make p5 attend and redraft.
    await db.collection('checkins').doc(`${SOURCE}_p5`).set(checkin('2026-09-19', 'p5', true));
    vi.setSystemTime(new Date('2026-09-22T16:00:00Z'));
    const res = await draft(app, { redraft: true });
    expect(res.statusCode).toBe(200);

    const rows = currentRows(db);
    expect(boothsOf(rows, 'p3')).toEqual(['wlrfm_v6']); // manual stayed
    expect(rows.find((r) => r.producer_id === 'p3')!.source).toBe('manual');
    expect(boothsOf(rows, 'p5')).toEqual(['wlrfm_v7']); // the newly attending vendor was seated (p3's V7 is free again)
    expect(boothsOf(rows, 'p1')).toEqual(['wlrfm_v1', 'wlrfm_v2']);

    const all = Object.values(db.dump('booth_assignments')) as any[];
    const superseded = all.filter((r) => r.superseded_by !== null);
    // original p1 x2, p2, p6 (non-manual) + p3's original V5 (superseded by the manual move)
    expect(superseded.length).toBe(5);
    expect(all.filter((r) => r.producer_id === 'p3' && r.booth_id === 'wlrfm_v7')[0].superseded_by).toBeTruthy();
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.assignments_draft_at).toEqual(new Date('2026-09-22T16:00:00Z'));
    expect(actions.drafts_generated_at).toEqual(T_MORNING); // first draft time is kept
  });

  it('two concurrent first drafts produce one set of assignments', async () => {
    const db = seed();
    const app = await buildApp(db);
    const [a, b] = await Promise.all([draft(app), draft(app)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const rows = currentRows(db);
    expect(rows).toHaveLength(5); // p1 x2, p2, p3, p6
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([`${SOURCE}__drafts`]);
  });

  it('409s with a reason and writes nothing when there is nothing to draft onto', async () => {
    const noTarget = seed({ target: false });
    expect((await draft(await buildApp(noTarget))).json()).toMatchObject({ error: 'No upcoming market date to assign', reason: 'no_next_date' });
    const noBooths = seed({ booths: false });
    const res = await draft(await buildApp(noBooths));
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('no_booths');
    for (const db of [noTarget, noBooths]) {
      expect(db.count('booth_assignments')).toBe(0);
      expect(db.count('workflow_locks')).toBe(0);
      expect((db.dump('market_dates')[SOURCE] as any).actions.drafts_generated_at).toBeNull();
    }
  });

  it('drafts an empty list when nobody said they are attending, so staff can add vendors by hand', async () => {
    const db = seed({ attendees: false });
    const app = await buildApp(db);
    const res = await draft(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().draft).toMatchObject({ skipped: null, target_date_id: TARGET, vendors_placed: 0, rows_written: 0 });
    expect(db.count('booth_assignments')).toBe(0);
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.assignments_target_date_id).toBe(TARGET);
    expect(actions.drafts_generated_at).toEqual(T_MORNING);
    const view = res.json().assignments;
    expect(view.attending).toEqual([]);
    expect(view.can_add.map((v: any) => [v.producer_id, v.reason])).toEqual([
      ['p1', 'no_answer'], ['p2', 'no_answer'], ['p4', 'not_attending'], ['p5', 'no_answer'], ['p3', 'no_answer'], ['p6', 'no_answer'],
    ]);

    const added = await app.inject({
      method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth('mgr_w'), payload: { changes: [{ producer_id: 'p5', booth_ids: ['wlrfm_v5'] }] },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().assignments.attending).toEqual([expect.objectContaining({ producer_id: 'p5', booth_ids: ['wlrfm_v5'], added_by_staff: true })]);
  });

  it('refuses once approved, a cancelled date, an unknown date and a manager of another market', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await draft(app, {}, 'mgr_a')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/market-dates/bogus/assignments/draft', headers: auth('admin1'), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/draft` , payload: {} })).statusCode).toBe(401);

    await draft(app);
    await app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/approve`, headers: auth('mgr_w'), payload: {} });
    const closed = await draft(app, { redraft: true });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('Assignments are approved; redraft is closed');

    const db2 = seed();
    await db2.collection('market_dates').doc(SOURCE).update({ status: 'cancelled' });
    expect((await draft(await buildApp(db2))).statusCode).toBe(409);
  });

  it('lets staff draft after the engine recorded a skip (no_attendees), once check-ins arrive', async () => {
    const db = seed({ sourceActions: { drafts_generated_at: new Date('2026-09-22T18:00:00Z'), drafts_skipped: 'no_attendees' } });
    const app = await buildApp(db);
    const res = await draft(app);
    expect(res.statusCode).toBe(200);
    expect(currentRows(db).length).toBe(5);
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.drafts_skipped).toBeNull();
    expect(actions.drafts_generated_at).toEqual(new Date('2026-09-22T18:00:00Z'));
    expect(actions.assignments_draft_at).toEqual(T_MORNING);
  });
});

describe('PATCH /api/market-dates/:id/assignments', () => {
  async function drafted() {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    return { db, app };
  }
  const patch = (app: Awaited<ReturnType<typeof buildApp>>, changes: unknown, user = 'mgr_w') =>
    app.inject({ method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth(user), payload: { changes } as never });

  it('moves a vendor: the old row is superseded, the new one is manual', async () => {
    const { db, app } = await drafted();
    const res = await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().warning).toBeUndefined();
    const all = Object.entries(db.dump('booth_assignments')) as [string, any][];
    const old = all.find(([, r]) => r.producer_id === 'p3' && r.booth_id === 'wlrfm_v7')!;
    const fresh = all.find(([, r]) => r.producer_id === 'p3' && r.booth_id === 'wlrfm_v6')!;
    expect(old[1].superseded_by).toBe(fresh[0]);
    expect(old[1].superseded_at).toEqual(T_MORNING);
    expect(fresh[1]).toMatchObject({ source: 'manual', assigned_by: 'mgr_w', superseded_by: null, market_date_id: TARGET, source_date_id: SOURCE });
    expect(res.json().assignments.booths.find((b: any) => b.booth.label === 'V6').assignment.producer_id).toBe('p3');
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'market_date.assignments.update')).toBe(true);
  });

  it('unassigns with an empty list and gives a two-space vendor two booths', async () => {
    const { db, app } = await drafted();
    await patch(app, [{ producer_id: 'p3', booth_ids: [] }, { producer_id: 'p2', booth_ids: ['wlrfm_v3', 'wlrfm_v4'] }]);
    const rows = currentRows(db);
    expect(boothsOf(rows, 'p3')).toEqual([]);
    expect(boothsOf(rows, 'p2')).toEqual(['wlrfm_v3', 'wlrfm_v4']);
    const view = (await app.inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('mgr_w') })).json().assignments;
    expect(view.unassigned.map((u: any) => u.producer_id)).toEqual(['p3']);
    expect(view.summary.assigned).toBe(3);
  });

  it('an unchanged set is a no-op (no new rows)', async () => {
    const { db, app } = await drafted();
    const before = db.count('booth_assignments');
    const res = await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v7'] }]);
    expect(res.statusCode).toBe(200);
    expect(db.count('booth_assignments')).toBe(before);
  });

  it('400s an unknown booth, a retired booth, a producer outside the rotation, and a repeated producer; writes nothing', async () => {
    const { db, app } = await drafted();
    // p4 leaves the rotation (inactive membership); p5 has only a previous-season membership; p9 does not exist.
    await db.collection('producer_memberships').doc('p4_wlrfm').update({ status: 'inactive' });
    await db.collection('producer_memberships').doc('p5_wlrfm').update({ season: '2025' });
    const before = JSON.stringify(db.dump('booth_assignments'));
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['nope'] }])).statusCode).toBe(400);
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v8'] }])).statusCode).toBe(400);
    const outside = await patch(app, [{ producer_id: 'p4', booth_ids: ['wlrfm_v6'] }]);
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toBe('That producer is not an active vendor of this market this season');
    expect((await patch(app, [{ producer_id: 'p5', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(400);
    expect((await patch(app, [{ producer_id: 'p9', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(400);
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }, { producer_id: 'p3', booth_ids: [] }])).statusCode).toBe(400);
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6', 'wlrfm_v6'] }])).statusCode).toBe(400);
    expect((await patch(app, [])).statusCode).toBe(400);
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v5', 'wlrfm_v6', 'wlrfm_v7'] }])).statusCode).toBe(400); // at most two booths
    expect(JSON.stringify(db.dump('booth_assignments'))).toBe(before);
    expect(db.count('workflow_locks')).toBe(1); // the drafts lock only: a refused change leaves no mutex behind
  });

  it('lets staff add a current-season vendor with no attending check-in by hand (manual, marked as added by staff)', async () => {
    const { db, app } = await drafted();
    // p4 answered "not attending", p5 never answered.
    const res = await patch(app, [{ producer_id: 'p4', booth_ids: ['wlrfm_v5'] }, { producer_id: 'p5', booth_ids: ['wlrfm_v6'] }]);
    expect(res.statusCode).toBe(200);
    const rows = currentRows(db);
    expect(rows.find((r) => r.producer_id === 'p4')).toMatchObject({ booth_id: 'wlrfm_v5', source: 'manual', assigned_by: 'mgr_w' });
    expect(rows.find((r) => r.producer_id === 'p5')).toMatchObject({ booth_id: 'wlrfm_v6', source: 'manual' });
    const view = res.json().assignments;
    expect(view.attending.map((v: any) => [v.producer_id, v.added_by_staff])).toEqual([
      ['p1', false], ['p2', false], ['p4', true], ['p5', true], ['p3', false], ['p6', false],
    ]);
    expect(view.can_add).toEqual([]);
    expect(view.not_attending).toEqual([]); // they hold a booth now
    expect(view.no_answer).toEqual([]);
    expect(view.summary).toMatchObject({ assigned: 6, unassigned: 0 });
    // Taking the booth away again puts them back on the "can add" list.
    const back = await patch(app, [{ producer_id: 'p4', booth_ids: [] }]);
    expect(back.json().assignments.can_add.map((v: any) => [v.producer_id, v.reason])).toEqual([['p4', 'not_attending']]);
    expect(back.json().assignments.not_attending.map((v: any) => v.producer_id)).toEqual(['p4']);
  });

  it('two simultaneous changes cannot both land: one is saved, the other is told to retry', async () => {
    const { db, app } = await drafted();
    // The service is called directly: two awaits race step by step (requests through inject() run one after the other).
    const market = { id: 'wlrfm', ...(db.dump('farmers_markets').wlrfm as any) } as FarmersMarket;
    const date = marketDateFromData(SOURCE, db.dump('market_dates')[SOURCE] as any);
    const [a, b] = await Promise.all([
      applyAssignmentChanges(db as never, market, date, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }], 'mgr_w', T_MORNING),
      applyAssignmentChanges(db as never, market, date, [{ producer_id: 'p4', booth_ids: ['wlrfm_v6'] }], 'admin1', T_MORNING),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(a.ok ? b : a).toMatchObject({ ok: false, status: 409, code: 'in_progress' });
    expect(currentRows(db).filter((r) => r.booth_id === 'wlrfm_v6')).toHaveLength(1);
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([`${SOURCE}__drafts`]); // the mutex is released

    // A change whose request died leaves its mutex behind: refused while fresh (409 in_progress), taken over once stale.
    await db.collection('workflow_locks').doc(`${SOURCE}__assignments_change`).set({ market_date_id: SOURCE, key: 'assignments_change', claimed_at: T_MORNING, run_id: 'dead', created_at: T_MORNING });
    const held = await patch(app, [{ producer_id: 'p2', booth_ids: ['wlrfm_v4'] }]);
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ code: 'in_progress', reason: 'in_progress' });
    expect((db.dump('workflow_locks')[`${SOURCE}__assignments_change`] as any).run_id).toBe('dead'); // a refused request never deletes another's lock
    vi.setSystemTime(new Date(T_MORNING.getTime() + 4 * 60_000));
    expect((await patch(app, [{ producer_id: 'p2', booth_ids: ['wlrfm_v4'] }])).statusCode).toBe(200);
    expect(db.dump('workflow_locks')[`${SOURCE}__assignments_change`]).toBeUndefined();
  });

  it('409s before any draft exists', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }])).statusCode).toBe(409);
  });

  it('allows a change after approval and after the booth texts went out, with a warning (the vendor is texted the new booth)', async () => {
    const { db, app } = await drafted();
    // Approve in quiet hours so the texts are deferred and the date is approved but unsent.
    vi.setSystemTime(new Date('2026-09-23T03:00:00Z'));
    const approve = await app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/approve`, headers: auth('mgr_w'), payload: {} });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().texts.deferred_until).toBe('2026-09-23T13:00:00.000Z');

    const warned = await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v6'] }]);
    expect(warned.statusCode).toBe(200);
    expect(warned.json().warning).toBe('approved');
    const rev = (db.dump('market_dates')[SOURCE] as any).actions.assignments_rev;
    expect(rev).toMatch(/^[0-9a-f]{32}$/); // a fresh token per change: what makes the engine look again

    await db.collection('market_dates').doc(SOURCE).update({ 'actions.booth_texts_sent_at': new Date('2026-09-23T13:00:00Z'), 'actions.booth_texts_rev': rev });
    const after = await patch(app, [{ producer_id: 'p3', booth_ids: ['wlrfm_v7'] }]);
    expect(after.statusCode).toBe(200); // no longer refused with `texts_sent`
    expect(after.json().warning).toBe('approved');
    expect((db.dump('market_dates')[SOURCE] as any).actions.assignments_rev).not.toBe(rev);
    expect((db.dump('market_dates')[SOURCE] as any).actions.booth_texts_sent_at).toEqual(new Date('2026-09-23T13:00:00Z')); // untouched
  });

  it('403s a manager of another market', async () => {
    const { app } = await drafted();
    expect((await patch(app, [{ producer_id: 'p3', booth_ids: [] }], 'mgr_a')).statusCode).toBe(403);
  });
});

describe('POST /api/market-dates/:id/assignments/approve', () => {
  const approve = (app: Awaited<ReturnType<typeof buildApp>>, user = 'mgr_w') =>
    app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/approve`, headers: auth(user), payload: {} });

  it('409s with no draft', async () => {
    const app = await buildApp(seed());
    const res = await approve(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('no_draft');
    expect((await buildApp(seed()).then((a) => approve(a, 'mgr_a'))).statusCode).toBe(403);
  });

  it('409s on a double booking, names no flag, and works once the conflict is resolved', async () => {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    // p3 is moved onto V3, which p2 holds.
    const clash = await app.inject({
      method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth('mgr_w'), payload: { changes: [{ producer_id: 'p3', booth_ids: ['wlrfm_v3'] }] },
    });
    expect(clash.statusCode).toBe(200);
    expect(clash.json().assignments.summary.conflicts).toBe(1);

    const res = await approve(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('conflicts');
    expect((db.dump('market_dates')[SOURCE] as any).actions.approved_at).toBeNull();
    expect(db.count('workflow_locks')).toBe(1); // only the drafts lock: a refused approval takes none

    await app.inject({
      method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth('mgr_w'), payload: { changes: [{ producer_id: 'p2', booth_ids: ['wlrfm_v4'] }] },
    });
    const ok = await approve(app);
    expect(ok.statusCode).toBe(200);
  });

  it('sets approved_at/by and the summary, attempts the texts, and audits', async () => {
    const db = seed();
    const app = await buildApp(db);
    await draft(app);
    const res = await approve(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.texts).toEqual({ attempted: true, sent: 4, failed: 0, excluded: 0, deferred_until: null });
    expect(body.assignments.approved_at).toBe(T_MORNING.toISOString());
    expect(body.assignments.approved_by).toBe('mgr_w');
    expect(body.assignments.booth_texts_sent_at).toBe(T_MORNING.toISOString());
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.approved_at).toEqual(T_MORNING);
    expect(actions.approved_by).toBe('mgr_w');
    expect(actions.booth_summary).toEqual({ assigned: 4, unassigned: 0, booths_total: 8, booths_free: 3 });
    expect(actions.booth_text_recipients).toBe(4);
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'market_date.assignments.approve')).toBe(true);

    const again = await approve(app);
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe('already_approved');
  });
});

describe('GET /api/market-dates/:id/status — assignments', () => {
  it('carries the assignments view and announces the drafts step only for a market with booths', async () => {
    const db = seed();
    const app = await buildApp(db);
    const before = (await app.inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('mgr_w') })).json();
    expect(before.next_due.action).toBe('drafts');
    expect(before.assignments.target_date.id).toBe(TARGET); // a preview before any draft
    expect(before.assignments.drafted_at).toBeNull();
    expect(before.assignments.booths.every((b: any) => b.assignment === null)).toBe(true);
    expect(before.assignments.attending.map((v: any) => v.producer_id)).toEqual(['p1', 'p2', 'p3', 'p6']);

    await draft(app);
    const after = (await app.inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('mgr_w') })).json();
    expect(after.next_due).toEqual({ action: 'none', at: null });
    expect(after.assignments.drafted_at).toBe(T_MORNING.toISOString());
    expect(after.assignments.attending.find((v: any) => v.producer_id === 'p1').booth_ids).toEqual(['wlrfm_v1', 'wlrfm_v2']);

    const bare = seed({ booths: false });
    const none = (await (await buildApp(bare)).inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('mgr_w') })).json();
    expect(none.next_due.action).toBe('none');
  });

  describe('next_due once the deadline is over (an idle engine never recorded a reminder slot)', () => {
    const nextDue = async (db: ReturnType<typeof fakeDb>) =>
      (await (await buildApp(db)).inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('mgr_w') })).json().next_due;
    const NO_REMINDERS = { reminder_state: {} };

    it('a processed deadline is never followed by an unrecorded reminder: the drafts step is announced', async () => {
      expect(await nextDue(seed({ sourceActions: NO_REMINDERS }))).toEqual({ action: 'drafts', at: '2026-09-22T18:00:00.000Z' });
      expect(await nextDue(seed({ sourceActions: NO_REMINDERS, booths: false }))).toEqual({ action: 'none', at: null });
    });

    it('the summary, then the booth texts, are not hidden behind that reminder either', async () => {
      const db = seed({ sourceActions: { ...NO_REMINDERS, summary_sent_at: null } });
      expect((await nextDue(db)).action).toBe('summary');

      const approved = seed({ sourceActions: NO_REMINDERS });
      const app = await buildApp(approved);
      await draft(app);
      vi.setSystemTime(new Date('2026-09-23T03:00:00Z')); // approve at 22:00: the texts wait for 08:00
      await app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/approve`, headers: auth('mgr_w'), payload: {} });
      expect(await nextDue(approved)).toEqual({ action: 'booth_texts', at: '2026-09-23T13:00:00.000Z' });
    });

    it('a deadline that has passed but was not processed is next, not a reminder or the check-in text', async () => {
      vi.setSystemTime(new Date('2026-09-22T17:30:00Z')); // 30 min after the deadline
      const idle = seed({ sourceActions: { ...NO_REMINDERS, deadline_processed_at: null, summary_sent_at: null } });
      expect(await nextDue(idle)).toEqual({ action: 'deadline', at: '2026-09-22T17:00:00.000Z' });
      const neverTexted = seed({ sourceActions: { ...NO_REMINDERS, checkin_sent_at: null, deadline_processed_at: null, summary_sent_at: null } });
      expect((await nextDue(neverTexted)).action).toBe('deadline');
    });

    it('an early admin close ends the check-in text too', async () => {
      const closed = seed({ sourceActions: { ...NO_REMINDERS, checkin_sent_at: null, deadline_processed_at: new Date('2026-09-22T14:00:00Z'), summary_skipped: 'notify_false', summary_sent_at: null } });
      expect((await nextDue(closed)).action).toBe('drafts');
    });

    it('before the deadline an unrecorded reminder is still what comes next', async () => {
      const open = seed({ sourceActions: { ...NO_REMINDERS, deadline_processed_at: null, summary_sent_at: null } });
      expect(await nextDue(open)).toEqual({ action: 'reminder', at: '2026-09-20T17:00:00.000Z', offset_min: 1440 });
      const fresh = seed({ sourceActions: { ...NO_REMINDERS, checkin_sent_at: null, deadline_processed_at: null, summary_sent_at: null } });
      expect((await nextDue(fresh)).action).toBe('checkin');
    });
  });

  it('explains why a vendor is unplaced', async () => {
    const db = seed();
    // Only the unpowered V1/V2 and the truck exist besides V3 (powered, usual of p2).
    for (const id of ['wlrfm_v4', 'wlrfm_v5', 'wlrfm_v6', 'wlrfm_v7']) await db.collection('booths').doc(id).update({ active: false });
    await db.collection('producer_memberships').doc('p2_wlrfm').update({ usual_booth_id: null });
    await db.collection('producer_memberships').doc('p1_wlrfm').update({ spaces: 1 });
    const app = await buildApp(db);
    await draft(app);
    const view = (await app.inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('admin1') })).json().assignments;
    // p2 (electric) takes V3; p1 V1; p3 V2; the truck has its slot. Everyone is seated.
    expect(view.unassigned).toEqual([]);
    // Take V3 away from p2 manually: electric with no powered stall free -> no_power_stall.
    await app.inject({ method: 'PATCH', url: `/api/market-dates/${SOURCE}/assignments`, headers: auth('admin1'), payload: { changes: [{ producer_id: 'p2', booth_ids: [] }, { producer_id: 'p3', booth_ids: ['wlrfm_v3'] }] } });
    const after = (await app.inject({ method: 'GET', url: `/api/market-dates/${SOURCE}/status`, headers: auth('admin1') })).json().assignments;
    expect(after.unassigned).toEqual([{ producer_id: 'p2', business_name: 'Beta Farm', reason: 'no_power_stall' }]);
  });
});
