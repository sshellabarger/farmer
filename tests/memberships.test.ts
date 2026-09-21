import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { membershipRoutes } from '../src/routes/memberships.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';

// See tests/helpers/staff-auth.ts.
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

function seed(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  return fakeDb({
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
      mgr_wlrfm: { name: 'WLRFM Manager', role: 'market_manager', phone: '+15015550002', assigned_market_ids: ['wlrfm'] },
    },
    farmers_markets: {
      wlrfm: { name: 'WLRFM', slug: 'wlrfm', active: true },
    },
    producers: {
      p1: { business_name: 'Testfield Farm', aliases: [], active: true },
    },
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', {} as never);
  await app.register(membershipRoutes, { prefix: '/api/memberships' });
  await app.ready();
  return app;
}

function auth(userId: string) {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

describe('GET /api/memberships', () => {
  it('400s when neither or both of market_id/producer_id are given', async () => {
    const app = await buildApp(seed());
    const res1 = await app.inject({ method: 'GET', url: '/api/memberships', headers: auth('admin1') });
    expect(res1.statusCode).toBe(400);
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/memberships?market_id=wlrfm&producer_id=p1',
      headers: auth('admin1'),
    });
    expect(res2.statusCode).toBe(400);
  });

  it('includes the producer business name', async () => {
    const db = seed({ producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' } } });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/memberships?market_id=wlrfm', headers: auth('admin1') });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships[0].producer.business_name).toBe('Testfield Farm');
  });
});

describe('POST /api/memberships', () => {
  it('404s an unknown producer or market', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({
      method: 'POST',
      url: '/api/memberships',
      headers: auth('admin1'),
      payload: { producer_id: 'nope', market_id: 'wlrfm' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409s a duplicate membership', async () => {
    const db = seed({ producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' } } });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/memberships',
      headers: auth('admin1'),
      payload: { producer_id: 'p1', market_id: 'wlrfm' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('creates approved with approved_at/by set', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({
      method: 'POST',
      url: '/api/memberships',
      headers: auth('admin1'),
      payload: { producer_id: 'p1', market_id: 'wlrfm' },
    });
    expect(res.statusCode).toBe(201);
    const membership = res.json().membership;
    expect(membership.status).toBe('approved');
    expect(membership.approved_at).toBeTruthy();
    expect(membership.approved_by).toBe('admin1');
  });
});

describe('PATCH /api/memberships/:id', () => {
  it('applies every allowed transition and appends history', async () => {
    const db = seed({ producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'applied', history: [] } } });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/memberships/p1_wlrfm',
      headers: auth('admin1'),
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(200);
    const membership = res.json().membership;
    expect(membership.status).toBe('approved');
    expect(membership.history).toHaveLength(1);
    expect(membership.approved_at).toBeTruthy();
  });

  it('409s an illegal transition (active -> approved)', async () => {
    const db = seed({ producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', history: [] } } });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/memberships/p1_wlrfm',
      headers: auth('admin1'),
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.from).toBe('active');
    expect(body.to).toBe('approved');
  });

  it('403s a market_manager patching a membership at another market', async () => {
    const db = seed({
      farmers_markets: { argenta: { name: 'Argenta', slug: 'argenta', active: true } },
      producer_memberships: { p1_argenta: { producer_id: 'p1', market_id: 'argenta', status: 'applied', history: [] } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/memberships/p1_argenta',
      headers: auth('mgr_wlrfm'),
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(403);
  });
});
