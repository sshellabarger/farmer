import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { producerRoutes } from '../src/routes/producers.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';

// See tests/helpers/staff-auth.ts: authenticate() on this branch doesn't yet
// project assigned_market_ids (that lands with A1's rbac.ts). Mock it here so
// A2's market-scoping logic can be exercised against the contracted shape.
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
      mgr_argenta: { name: 'Argenta Manager', role: 'market_manager', phone: '+15015550003', assigned_market_ids: ['argenta'] },
    },
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', {} as never);
  await app.register(producerRoutes, { prefix: '/api/producers' });
  await app.ready();
  return app;
}

function auth(userId: string) {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

describe('GET /api/producers', () => {
  it('400s a market_manager who sends no market_id', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({ method: 'GET', url: '/api/producers', headers: auth('mgr_wlrfm') });
    expect(res.statusCode).toBe(400);
  });

  it('403s a market_manager scoped to a different market', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: auth('mgr_argenta') });
    expect(res.statusCode).toBe(403);
  });

  it('returns only producers with a membership at the assigned market, hiding notes', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Testfield Farm', notes: 'secret note', active: true, aliases: [] },
        p2: { business_name: 'Sample Produce', notes: 'other note', active: true, aliases: [] },
      },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
        p2_argenta: { producer_id: 'p2', market_id: 'argenta', status: 'active' },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: auth('mgr_wlrfm') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.producers).toHaveLength(1);
    expect(body.producers[0].business_name).toBe('Testfield Farm');
    expect(body.producers[0].notes).toBeUndefined();
  });

  it('admin sees notes and all producers without a market_id', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Testfield Farm', notes: 'secret note', active: true, aliases: [] },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/producers', headers: auth('admin1') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.producers[0].notes).toBe('secret note');
  });
});

describe('POST /api/producers', () => {
  it('rejects a duplicate email with 409 and the existing producer_id', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], aliases: [], active: true },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/producers',
      headers: auth('admin1'),
      payload: { business_name: 'Someone Else', email: 'owner@testfield.example' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().producer_id).toBe('p1');
  });

  it('creates a producer and its memberships', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/producers',
      headers: auth('admin1'),
      payload: {
        business_name: 'New Farm',
        email: 'new@testfield.example',
        memberships: [{ market_id: 'wlrfm' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.producer.business_name).toBe('New Farm');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].status).toBe('approved');
    expect(db.dump('audit_log')).not.toEqual({});
  });
});

describe('PATCH /api/producers/:id', () => {
  it('renaming moves the old name to aliases and recomputes name_key', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Terry Testfield', name_key: 'terry', aliases: [], active: true },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/producers/p1',
      headers: auth('admin1'),
      payload: { business_name: 'Testfield Farm' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.producer.business_name).toBe('Testfield Farm');
    expect(body.producer.name_key).toBe('testfield');
    expect(body.producer.aliases).toContain('Terry Testfield');
  });
});

describe('GET /api/producers/:id', () => {
  it('404s a market_manager for a producer with no membership at an assigned market', async () => {
    const db = seed({
      producers: { p1: { business_name: 'Testfield Farm', aliases: [], active: true } },
      producer_memberships: { p1_argenta: { producer_id: 'p1', market_id: 'argenta', status: 'active' } },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/producers/p1', headers: auth('mgr_wlrfm') });
    expect(res.statusCode).toBe(404);
  });
});
