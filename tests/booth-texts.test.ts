import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { marketDateRoutes } from '../src/routes/market-dates.js';
import { processMarketDates, DEDUPE_KEYS, TEMPLATES } from '../src/services/checkin-workflow.js';
import { splitMessage } from '../src/services/sms.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
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

const approve = (app: Awaited<ReturnType<typeof buildApp>>, user = 'mgr_w') =>
  app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/approve`, headers: auth(user), payload: {} });
const tick = (db: ReturnType<typeof fakeDb>, t: Date) => processMarketDates(db as never, env, { now: t });

function boothMessages(db: ReturnType<typeof fakeDb>) {
  return Object.entries(db.dump('messages'))
    .map(([id, m]) => ({ id, ...(m as any) }))
    .filter((m) => m.kind === 'booth');
}
function consoleBoothTexts(): number {
  return logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith('[sms:console]') && c[2] === 'booth').length;
}

const T_QUIET = new Date('2026-09-23T03:00:00Z'); // Tue 22:00 CDT
const T_WINDOW_EDGE = new Date('2026-09-23T12:59:00Z'); // Wed 07:59 CDT
const T_WINDOW_OPEN = new Date('2026-09-23T13:00:00Z'); // Wed 08:00 CDT

async function drafted(opts: SeedOpts = {}, mutate?: (db: ReturnType<typeof fakeDb>) => Promise<void>) {
  const db = seed(opts);
  if (mutate) await mutate(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: `/api/market-dates/${SOURCE}/assignments/draft`, headers: auth('mgr_w'), payload: {} });
  expect(res.statusCode).toBe(200);
  return { db, app };
}

describe('approving outside quiet hours', () => {
  it('texts each seated vendor once, keyed booth:<target>:<producer>, naming every booth they hold', async () => {
    const { db, app } = await drafted();
    const res = await approve(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().texts).toEqual({ attempted: true, sent: 4, failed: 0, excluded: 0, deferred_until: null });

    const msgs = boothMessages(db);
    expect(msgs.map((m) => m.id).sort()).toEqual([
      `booth:${TARGET}:p1`, `booth:${TARGET}:p2`, `booth:${TARGET}:p3`, `booth:${TARGET}:p6`,
    ]);
    for (const m of msgs) {
      expect(m).toMatchObject({ direction: 'outbound', kind: 'booth', market_date_id: TARGET, status: 'simulated', source_date_id: SOURCE });
      expect(m.body).toContain('Sat Sep 26'); // the TARGET date, not the date being closed out
      expect(m.body.endsWith('Reply STOP to opt out.')).toBe(true);
    }
    const p1 = msgs.find((m) => m.producer_id === 'p1')!;
    expect(p1.to).toBe('+15015550101');
    expect(p1.body).toBe(
      'SJCA Markets: Alice, your booth at West Little Rock Farmers Market on Sat Sep 26 is V1 and V2. Please check in at the table when you arrive.\nReply STOP to opt out.',
    );
    expect(p1.booth_labels).toEqual(['V1', 'V2']);
    expect(msgs.find((m) => m.producer_id === 'p6')!.body).toContain('is Food truck.');
    expect(msgs.find((m) => m.producer_id === 'p3')!.body).toContain('is V7.');
    expect(consoleBoothTexts()).toBe(4);

    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.booth_texts_sent_at).toEqual(T_MORNING);
    expect(actions).toMatchObject({ booth_text_recipients: 4, booth_text_failed: 0, booth_text_excluded: 0 });
    expect(Object.keys(db.dump('workflow_locks')).sort()).toEqual([`${SOURCE}__approve`, `${SOURCE}__booth_texts`, `${SOURCE}__drafts`]);
  });

  it('counts a vendor with no phone or who opted out as excluded and texts nobody else twice', async () => {
    const { db, app } = await drafted({}, async (d) => {
      await d.collection('producers').doc('p3').update({ phone: null });
      await d.collection('producers').doc('p2').update({ sms_opt_out_at: new Date('2026-09-01T00:00:00Z') });
    });
    const res = await approve(app);
    expect(res.json().texts).toEqual({ attempted: true, sent: 2, failed: 0, excluded: 2, deferred_until: null });
    expect(boothMessages(db).map((m) => m.producer_id).sort()).toEqual(['p1', 'p6']);
    // The assignments themselves are untouched.
    expect(Object.values(db.dump('booth_assignments')).filter((r: any) => r.superseded_by === null)).toHaveLength(5);
    expect((db.dump('market_dates')[SOURCE] as any).actions.booth_text_excluded).toBe(2);
  });

  it('treats an already-sent keyed text as sent, never re-sending it', async () => {
    const { db, app } = await drafted({}, async (d) => {
      await d.collection('messages').doc(`booth:${TARGET}:p1`).set({ direction: 'outbound', kind: 'booth', producer_id: 'p1', market_date_id: TARGET, status: 'sent', created_at: new Date(), to: '+15015550101', body: 'x' });
    });
    const res = await approve(app);
    expect(res.json().texts.sent).toBe(3);
    expect(consoleBoothTexts()).toBe(3);
    expect((db.dump('market_dates')[SOURCE] as any).actions.booth_text_recipients).toBe(4);
  });

  it('excludes a vendor whose only membership is a different season', async () => {
    const { db, app } = await drafted({}, async (d) => {
      await d.collection('producer_memberships').doc('p3_wlrfm').update({ season: '2025' });
    });
    // p3 is no longer a current-season vendor, so the draft left them out of the booth plan altogether.
    const res = await approve(app);
    expect(res.json().texts.sent).toBe(3);
    expect(boothMessages(db).map((m) => m.producer_id).sort()).toEqual(['p1', 'p2', 'p6']);
  });
});

describe('approving in quiet hours', () => {
  it('defers to the window end, texts nothing now, and the engine sends exactly at 08:00', async () => {
    const { db, app } = await drafted();
    vi.setSystemTime(T_QUIET);
    const res = await approve(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().texts).toEqual({ attempted: false, sent: 0, failed: 0, excluded: 0, deferred_until: '2026-09-23T13:00:00.000Z' });
    expect(res.json().assignments.booth_texts_due_at).toBe('2026-09-23T13:00:00.000Z');
    expect(boothMessages(db)).toHaveLength(0);
    expect((db.dump('market_dates')[SOURCE] as any).actions.approved_at).toEqual(T_QUIET);
    expect((db.dump('market_dates')[SOURCE] as any).actions.booth_texts_sent_at).toBeNull();
    expect(db.dump('workflow_locks')[`${SOURCE}__booth_texts`]).toBeUndefined(); // a deferral takes no lock

    const early = await tick(db, T_WINDOW_EDGE);
    expect(early.errors).toEqual([]);
    expect(early.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);

    vi.setSystemTime(T_WINDOW_OPEN);
    const open = await tick(db, T_WINDOW_OPEN);
    expect(open.errors).toEqual([]);
    expect(open.booth_texts_sent).toBe(4);
    expect(boothMessages(db)).toHaveLength(4);
    expect((db.dump('market_dates')[SOURCE] as any).actions.booth_texts_sent_at).toEqual(T_WINDOW_OPEN);

    // Later ticks and a second approval change nothing.
    const later = await tick(db, new Date('2026-09-23T13:05:00Z'));
    expect(later.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(4);
    expect((await approve(app)).statusCode).toBe(409);
    expect(boothMessages(db)).toHaveLength(4);
    expect(consoleBoothTexts()).toBe(4);
  });

  it('never texts during quiet hours even when the approval itself was outside them (a retry at 22:30)', async () => {
    const { db } = await drafted();
    await db.collection('market_dates').doc(SOURCE).update({ 'actions.approved_at': T_MORNING, 'actions.approved_by': 'mgr_w' });
    const late = await tick(db, new Date('2026-09-23T03:30:00Z')); // 22:30 CDT
    expect(late.booth_texts_sent).toBe(0);
    expect(boothMessages(db)).toHaveLength(0);
    const morning = await tick(db, T_WINDOW_OPEN);
    expect(morning.booth_texts_sent).toBe(4);
  });

  it('three simultaneous ticks send one text per vendor under one booth_texts lock', async () => {
    const { db, app } = await drafted();
    vi.setSystemTime(T_QUIET);
    await approve(app);
    vi.setSystemTime(T_WINDOW_OPEN);
    const results = await Promise.all([tick(db, T_WINDOW_OPEN), tick(db, T_WINDOW_OPEN), tick(db, T_WINDOW_OPEN)]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.reduce((n, r) => n + r.booth_texts_sent, 0)).toBe(4);
    expect(boothMessages(db)).toHaveLength(4);
    expect(consoleBoothTexts()).toBe(4);
    expect(Object.keys(db.dump('workflow_locks')).filter((k) => k.endsWith('__booth_texts'))).toEqual([`${SOURCE}__booth_texts`]);
  });

  it('takes over a stale booth_texts lock without re-texting vendors already sent', async () => {
    const { db, app } = await drafted();
    vi.setSystemTime(T_QUIET);
    await approve(app);
    // A run died after texting p1 but before writing booth_texts_sent_at.
    await db.collection('workflow_locks').doc(`${SOURCE}__booth_texts`).set({ market_date_id: SOURCE, key: 'booth_texts', claimed_at: new Date('2026-09-23T12:00:00Z'), run_id: 'dead', created_at: new Date('2026-09-23T12:00:00Z') });
    await db.collection('messages').doc(`booth:${TARGET}:p1`).set({ direction: 'outbound', kind: 'booth', producer_id: 'p1', market_date_id: TARGET, status: 'sent', created_at: new Date('2026-09-23T12:00:01Z'), to: '+15015550101', body: 'x' });
    vi.setSystemTime(T_WINDOW_OPEN);
    const r = await tick(db, T_WINDOW_OPEN);
    expect(r.booth_texts_sent).toBe(3);
    expect(boothMessages(db)).toHaveLength(4);
    expect(consoleBoothTexts()).toBe(3);
  });
});

describe('two simultaneous approvals', () => {
  it('approve once: one approved_at, the loser is refused, vendors are texted once', async () => {
    const { db, app } = await drafted();
    const [a, b] = await Promise.all([approve(app), approve(app, 'admin1')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? 'mgr_w' : 'admin1';
    expect((db.dump('market_dates')[SOURCE] as any).actions.approved_by).toBe(winner);
    expect(boothMessages(db)).toHaveLength(4);
    expect(consoleBoothTexts()).toBe(4);
    expect(Object.keys(db.dump('workflow_locks')).filter((k) => k.endsWith('__approve'))).toHaveLength(1);
  });
});

describe('the engine drafts step', () => {
  const T_BEFORE = new Date('2026-09-22T17:59:00Z');
  const T_DRAFTS = new Date('2026-09-22T18:00:00Z'); // end 12:00 CDT + 4380 min

  it('waits for drafts_at, drafts once, and does not text anyone before approval', async () => {
    const db = seed();
    const before = await tick(db, T_BEFORE);
    expect(before.drafts_generated).toBe(0);
    expect(db.count('booth_assignments')).toBe(0);

    const at = await tick(db, T_DRAFTS);
    expect(at.errors).toEqual([]);
    expect(at.drafts_generated).toBe(1);
    const rows = Object.values(db.dump('booth_assignments')) as any[];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.assigned_by === 'engine' && r.market_date_id === TARGET && r.source_date_id === SOURCE)).toBe(true);
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.drafts_generated_at).toEqual(T_DRAFTS);
    expect(actions.assignments_target_date_id).toBe(TARGET);
    expect(actions.approved_at).toBeNull();
    expect(boothMessages(db)).toHaveLength(0);
    expect(consoleBoothTexts()).toBe(0);

    const again = await tick(db, new Date('2026-09-22T18:05:00Z'));
    expect(again.drafts_generated).toBe(0);
    expect(db.count('booth_assignments')).toBe(5);
  });

  it('three simultaneous ticks produce one set of assignments', async () => {
    const db = seed();
    const results = await Promise.all([tick(db, T_DRAFTS), tick(db, T_DRAFTS), tick(db, T_DRAFTS)]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.reduce((n, r) => n + r.drafts_generated, 0)).toBe(1);
    expect(db.count('booth_assignments')).toBe(5);
  });

  it.each([
    ['no_booths', { booths: false }],
    ['no_next_date', { target: false }],
    ['no_attendees', { attendees: false }],
  ] as const)('records %s once and does not retry every five minutes', async (reason, opts) => {
    const db = seed(opts);
    const r = await tick(db, T_DRAFTS);
    expect(r.errors).toEqual([]);
    expect(r.drafts_generated).toBe(0);
    const actions = (db.dump('market_dates')[SOURCE] as any).actions;
    expect(actions.drafts_skipped).toBe(reason);
    expect(actions.drafts_generated_at).toEqual(T_DRAFTS);
    expect(db.count('booth_assignments')).toBe(0);
    const claim = (db.dump('workflow_locks')[`${SOURCE}__drafts`] as any).claimed_at;
    await tick(db, new Date('2026-09-22T18:10:00Z'));
    expect((db.dump('workflow_locks')[`${SOURCE}__drafts`] as any).claimed_at).toEqual(claim); // no second claim
  });

  it('is then approved by staff and texted by the same engine', async () => {
    const db = seed();
    await tick(db, T_DRAFTS);
    const app = await buildApp(db);
    vi.setSystemTime(T_QUIET);
    const res = await approve(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().texts.deferred_until).toBe('2026-09-23T13:00:00.000Z');
    const open = await tick(db, T_WINDOW_OPEN);
    expect(open.booth_texts_sent).toBe(4);
  });
});

describe('TEMPLATES.booth and DEDUPE_KEYS.booth', () => {
  const base = { market_name: 'West Little Rock Farmers Market', date_short: 'Sat Sep 26', first_name: 'Alice' };

  it('lists one, two and three booths', () => {
    expect(TEMPLATES.booth({ ...base, labels: ['V7'] })).toContain('is V7. Please');
    expect(TEMPLATES.booth({ ...base, labels: ['V7', 'V8'] })).toContain('is V7 and V8. Please');
    expect(TEMPLATES.booth({ ...base, labels: ['V7', 'V8', 'V9'] })).toContain('is V7, V8 and V9. Please');
    expect(TEMPLATES.booth({ ...base, first_name: '', labels: ['V7'] }).startsWith('SJCA Markets: your booth at')).toBe(true);
  });

  it('stays within two SMS segments with a 40-character market name, ASCII only', () => {
    // The contract's wording is kept verbatim; with a 40-character name it runs to 172 characters, i.e. two segments
    // (the contract's "<= 160" note does not hold for the wording it prescribes - see the A2 notes).
    const body = TEMPLATES.booth({ market_name: 'M'.repeat(40), date_short: 'Sat Sep 26', labels: ['V7', 'V8'], first_name: 'Alice' });
    expect(body.length).toBe(172);
    expect(splitMessage(body).length).toBeLessThanOrEqual(2);
    expect(/^[\x20-\x7e\n]+$/.test(body)).toBe(true);
  });

  it('keys by target date and producer, and refuses a part containing a colon', () => {
    expect(DEDUPE_KEYS.booth('wlrfm_2026-09-26', 'p1')).toBe('booth:wlrfm_2026-09-26:p1');
    expect(() => DEDUPE_KEYS.booth('a:b', 'p1')).toThrow();
  });
});
