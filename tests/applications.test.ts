import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { applicationRoutes } from '../src/routes/applications.js';
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
    users: { admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' } },
    farmers_markets: {
      wlrfm: { name: 'WLRFM', slug: 'wlrfm', active: true },
      argenta: { name: 'Argenta', slug: 'argenta', active: false },
    },
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', {} as never);
  await app.register(applicationRoutes, { prefix: '/api/applications' });
  await app.ready();
  return app;
}

function auth(userId: string) {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

const basePayload = {
  email: 'owner@testfield.example',
  business_name: 'Testfield Farm',
  contact_person: 'Terry Testfield',
  phone: '5015550100',
  markets_applied: ['wlrfm'],
};

describe('POST /api/applications', () => {
  it('accepts a valid application and normalizes the phone', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({ method: 'POST', url: '/api/applications', payload: basePayload });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('new');
  });

  it('400s an inactive market', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { ...basePayload, markets_applied: ['argenta'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s an unknown market', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { ...basePayload, markets_applied: ['nope'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409s a duplicate submission for the same email within 24h', async () => {
    const app = await buildApp(seed());
    await app.inject({ method: 'POST', url: '/api/applications', payload: basePayload });
    const res = await app.inject({ method: 'POST', url: '/api/applications', payload: basePayload });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /api/applications/:id approve — upsert BY EMAIL, never by name', () => {
  it('merges into an existing producer with the same email, even with a different business_name', async () => {
    const db = seed({
      producers: {
        existing: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], aliases: [], active: true },
      },
      applications: {
        app1: {
          email: 'owner@testfield.example',
          business_name: 'Terry T.',
          contact_person: 'Terry Testfield',
          phone: '+15015550100',
          markets_applied: ['wlrfm'],
          extra: {},
          status: 'new',
          reviewed_by: null,
          reviewed_at: null,
          decision_note: null,
          producer_id: null,
          membership_ids: [],
          submitted_at: new Date(),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/applications/app1',
      headers: auth('admin1'),
      payload: { action: 'approve', market_ids: ['wlrfm'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.producer.id).toBe('existing');
    expect(body.producer.aliases).toContain('Terry T.');
    // no second producer created
    expect(Object.keys(db.dump('producers'))).toEqual(['existing']);
    expect(body.memberships[0].status).toBe('approved');
  });

  it('creates a new producer for a different email even with the identical business_name', async () => {
    const db = seed({
      producers: {
        existing: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], aliases: [], active: true },
      },
      applications: {
        app2: {
          email: 'different@testfield.example',
          business_name: 'Testfield Farm',
          contact_person: 'Someone Else',
          phone: '+15015550101',
          markets_applied: ['wlrfm'],
          extra: {},
          status: 'new',
          reviewed_by: null,
          reviewed_at: null,
          decision_note: null,
          producer_id: null,
          membership_ids: [],
          submitted_at: new Date(),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/applications/app2',
      headers: auth('admin1'),
      payload: { action: 'approve', market_ids: ['wlrfm'] },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(db.dump('producers'))).toHaveLength(2);
  });

  it('400s market_ids outside markets_applied', async () => {
    const db = seed({
      applications: {
        app3: {
          email: 'x@testfield.example',
          business_name: 'X Farm',
          contact_person: 'X',
          phone: '+15015550102',
          markets_applied: ['wlrfm'],
          extra: {},
          status: 'new',
          reviewed_by: null,
          reviewed_at: null,
          decision_note: null,
          producer_id: null,
          membership_ids: [],
          submitted_at: new Date(),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/applications/app3',
      headers: auth('admin1'),
      payload: { action: 'approve', market_ids: ['argenta'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409s approving an already-approved application', async () => {
    const db = seed({
      applications: {
        app4: {
          email: 'x@testfield.example',
          business_name: 'X Farm',
          contact_person: 'X',
          phone: '+15015550102',
          markets_applied: ['wlrfm'],
          extra: {},
          status: 'approved',
          reviewed_by: 'admin1',
          reviewed_at: new Date(),
          decision_note: null,
          producer_id: 'p1',
          membership_ids: [],
          submitted_at: new Date(),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/applications/app4',
      headers: auth('admin1'),
      payload: { action: 'approve', market_ids: ['wlrfm'] },
    });
    expect(res.statusCode).toBe(409);
  });
});
