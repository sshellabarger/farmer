import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { boothRoutes } from '../src/routes/booths.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { boothDocId, boothSlug } from '../src/services/booths.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { Env } from '../src/config/env.js';

// Same mocked authenticate as tests/market-dates-routes.test.ts (see tests/helpers/staff-auth.ts).
vi.mock('../src/middleware/rbac.js', () => ({
  authenticate: (app: any) => async (request: any, reply: any) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer test:')) return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    const userId = header.slice('Bearer test:'.length);
    const userDoc = await app.db.collection('users').doc(userId).get();
    if (!userDoc.exists) return reply.status(401).send({ error: 'User not found' });
    const user = userDoc.data();
    request.authUser = {
      id: userDoc.id,
      name: user.name ?? null,
      role: user.role,
      phone: user.phone ?? null,
      assigned_market_ids: user.assigned_market_ids ?? [],
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
  APP_URL: 'https://test.example', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function market(id: string) {
  return {
    id, name: `Market ${id}`, slug: id, location: { name: '', address: '' }, timezone: 'America/Chicago',
    schedule: { versions: [], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
    active: true, created_by: 'test', created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
  };
}

function seed(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  return fakeDb({
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', assigned_market_ids: ['argenta'] },
    },
    farmers_markets: { wlrfm: market('wlrfm'), argenta: market('argenta') },
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(boothRoutes, { prefix: '/api/markets' });
  await app.ready();
  return app;
}

const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

const WLRFM_LAYOUT = {
  rows: [
    { row: 'west', labels: Array.from({ length: 11 }, (_, i) => `V${i + 1}`) },
    { row: 'east', labels: Array.from({ length: 11 }, (_, i) => `V${i + 12}`) },
  ],
  food_truck: { label: 'Food truck', row: 'center', order: 8 },
};

describe('boothSlug / boothDocId', () => {
  it('lower-cases and collapses punctuation', () => {
    expect(boothSlug('V7')).toBe('v7');
    expect(boothSlug('Food truck')).toBe('food-truck');
    expect(boothSlug(' -A / B- ')).toBe('a-b');
    expect(boothSlug('---')).toBe('');
    expect(boothDocId('wlrfm', 'V7')).toBe('wlrfm_v7');
  });
});

describe('POST /api/markets/:id/booths', () => {
  it('creates a booth with id wlrfm_v7 and audits it', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'),
      payload: { label: 'V7', row: 'west', order: 7, power: true },
    });
    expect(res.statusCode).toBe(201);
    const { booth } = res.json();
    expect(booth).toMatchObject({ id: 'wlrfm_v7', market_id: 'wlrfm', label: 'V7', row: 'west', order: 7, kind: 'stall', power: true, size: '12x12', active: true });
    expect(db.dump('booths').wlrfm_v7).toBeTruthy();
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'booth.create' && a.target.id === 'wlrfm_v7')).toBe(true);
  });

  it('409s a duplicate label (case and punctuation insensitive) and keeps the original', async () => {
    const db = seed();
    const app = await buildApp(db);
    const first = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'V7', row: 'west', order: 7 } });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'v7', row: 'east', order: 1 } });
    expect(dup.statusCode).toBe(409);
    expect(db.dump('booths').wlrfm_v7).toMatchObject({ label: 'V7', row: 'west' });
  });

  it('is admin-only, validates the body and 404s an unknown market', async () => {
    const db = seed();
    const app = await buildApp(db);
    const asManager = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('mgr_w'), payload: { label: 'V1', row: 'west', order: 1 } });
    expect(asManager.statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: '', row: 'west', order: 1 } });
    expect(bad.statusCode).toBe(400);
    const nolabel = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: '---', row: 'west', order: 1 } });
    expect(nolabel.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/markets/nope/booths', headers: auth('admin1'), payload: { label: 'V1', row: 'west', order: 1 } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/markets/:id/booths/seed', () => {
  it('creates 22 stalls plus the food truck, then skips what exists', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: WLRFM_LAYOUT });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 23, existing: 0 });
    expect(db.count('booths')).toBe(23);
    expect(db.dump('booths').wlrfm_v1).toMatchObject({ row: 'west', order: 1, kind: 'stall' });
    expect(db.dump('booths').wlrfm_v12).toMatchObject({ row: 'east', order: 1 });
    expect(db.dump('booths')['wlrfm_food-truck']).toMatchObject({ kind: 'food_truck', row: 'center', order: 8, label: 'Food truck' });

    // Edit one, seed again: nothing is overwritten.
    await db.collection('booths').doc('wlrfm_v1').update({ power: true });
    const again = await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: WLRFM_LAYOUT });
    expect(again.json()).toEqual({ created: 0, existing: 23 });
    expect(db.dump('booths').wlrfm_v1).toMatchObject({ power: true });
  });
});

describe('GET /api/markets/:id/booths', () => {
  it('lists active booths sorted by row then order; include_inactive adds retired ones', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: WLRFM_LAYOUT });
    await db.collection('booths').doc('wlrfm_v2').update({ active: false });

    const res = await app.inject({ method: 'GET', url: '/api/markets/wlrfm/booths', headers: auth('mgr_w') });
    expect(res.statusCode).toBe(200);
    const labels = res.json().booths.map((b: any) => b.label);
    expect(labels).toHaveLength(22);
    expect(labels).not.toContain('V2');
    // center < east < west alphabetically; within a row ascending order
    expect(labels[0]).toBe('Food truck');
    expect(labels.slice(1, 4)).toEqual(['V12', 'V13', 'V14']);

    const all = await app.inject({ method: 'GET', url: '/api/markets/wlrfm/booths?include_inactive=true', headers: auth('admin1') });
    expect(all.json().booths).toHaveLength(23);
  });

  it('403s a manager of another market and 401s without auth', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await app.inject({ method: 'GET', url: '/api/markets/wlrfm/booths', headers: auth('mgr_a') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/markets/wlrfm/booths' })).statusCode).toBe(401);
  });
});

describe('PATCH /api/markets/:id/booths/:booth_id', () => {
  it('renames without changing the id, toggles power and audits', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'V7', row: 'west', order: 7 } });
    const res = await app.inject({
      method: 'PATCH', url: '/api/markets/wlrfm/booths/wlrfm_v7', headers: auth('admin1'), payload: { label: 'V7A', power: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().booth).toMatchObject({ id: 'wlrfm_v7', label: 'V7A', power: true });
    expect(db.dump('booths').wlrfm_v7).toMatchObject({ label: 'V7A', power: true });
    expect(db.count('booths')).toBe(1);
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'booth.update')).toBe(true);
  });

  it('409s a rename onto another booth\'s label and 404s a booth of another market', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: { rows: [{ row: 'west', labels: ['V1', 'V2'] }] } });
    const clash = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm/booths/wlrfm_v1', headers: auth('admin1'), payload: { label: 'v2' } });
    expect(clash.statusCode).toBe(409);
    const wrongMarket = await app.inject({ method: 'PATCH', url: '/api/markets/argenta/booths/wlrfm_v1', headers: auth('admin1'), payload: { power: true } });
    expect(wrongMarket.statusCode).toBe(404);
    const empty = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm/booths/wlrfm_v1', headers: auth('admin1'), payload: {} });
    expect(empty.statusCode).toBe(400);
  });
});

describe('DELETE /api/markets/:id/booths/:booth_id', () => {
  it('retires the booth (active false, doc kept)', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'V7', row: 'west', order: 7 } });
    const res = await app.inject({ method: 'DELETE', url: '/api/markets/wlrfm/booths/wlrfm_v7', headers: auth('admin1') });
    expect(res.statusCode).toBe(200);
    expect(res.json().booth).toMatchObject({ id: 'wlrfm_v7', active: false });
    expect(db.dump('booths').wlrfm_v7).toMatchObject({ active: false });
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'booth.delete')).toBe(true);
  });

  it('409s while a current-season membership has it as the usual booth', async () => {
    const db = seed({
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', usual_booth_id: 'wlrfm_v7' },
      },
    });
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'V7', row: 'west', order: 7 } });
    const res = await app.inject({ method: 'DELETE', url: '/api/markets/wlrfm/booths/wlrfm_v7', headers: auth('admin1') });
    expect(res.statusCode).toBe(409);
    expect(db.dump('booths').wlrfm_v7).toMatchObject({ active: true });
    const viaPatch = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm/booths/wlrfm_v7', headers: auth('admin1'), payload: { active: false } });
    expect(viaPatch.statusCode).toBe(409);
  });

  it('does not count a previous season\'s usual booth', async () => {
    const db = seed({
      producer_memberships: {
        old: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', season: '2025', usual_booth_id: 'wlrfm_v7' },
      },
    });
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths', headers: auth('admin1'), payload: { label: 'V7', row: 'west', order: 7 } });
    const res = await app.inject({ method: 'DELETE', url: '/api/markets/wlrfm/booths/wlrfm_v7', headers: auth('admin1') });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /api/markets/:id/booths/reorder', () => {
  it('rewrites row and order per list', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: { rows: [{ row: 'west', labels: ['V1', 'V2', 'V3'] }] } });
    const res = await app.inject({
      method: 'PUT', url: '/api/markets/wlrfm/booths/reorder', headers: auth('admin1'),
      payload: { rows: [{ row: 'west', booth_ids: ['wlrfm_v3', 'wlrfm_v1'] }, { row: 'east', booth_ids: ['wlrfm_v2'] }] },
    });
    expect(res.statusCode).toBe(200);
    expect(db.dump('booths').wlrfm_v3).toMatchObject({ row: 'west', order: 1 });
    expect(db.dump('booths').wlrfm_v1).toMatchObject({ row: 'west', order: 2 });
    expect(db.dump('booths').wlrfm_v2).toMatchObject({ row: 'east', order: 1 });
    expect(res.json().booths.map((b: any) => b.label)).toEqual(['V2', 'V3', 'V1']);
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'booth.reorder')).toBe(true);
  });

  it('400s an unknown or repeated booth and writes nothing', async () => {
    const db = seed();
    const app = await buildApp(db);
    await app.inject({ method: 'POST', url: '/api/markets/wlrfm/booths/seed', headers: auth('admin1'), payload: { rows: [{ row: 'west', labels: ['V1', 'V2'] }] } });
    const unknown = await app.inject({ method: 'PUT', url: '/api/markets/wlrfm/booths/reorder', headers: auth('admin1'), payload: { rows: [{ row: 'x', booth_ids: ['wlrfm_v1', 'nope'] }] } });
    expect(unknown.statusCode).toBe(400);
    const twice = await app.inject({ method: 'PUT', url: '/api/markets/wlrfm/booths/reorder', headers: auth('admin1'), payload: { rows: [{ row: 'x', booth_ids: ['wlrfm_v1'] }, { row: 'y', booth_ids: ['wlrfm_v1'] }] } });
    expect(twice.statusCode).toBe(400);
    expect(db.dump('booths').wlrfm_v1).toMatchObject({ row: 'west', order: 1 });
  });
});
