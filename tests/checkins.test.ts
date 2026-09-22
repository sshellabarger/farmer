import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { checkinRoutes } from '../src/routes/checkins.js';
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
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', {} as never);
  await app.register(checkinRoutes, { prefix: '/api/checkins' });
  await app.ready();
  return app;
}

function auth(userId: string) {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

describe('GET /api/checkins', () => {
  it('400s when neither or both of market_date_id/producer_id are given', async () => {
    const app = await buildApp(seed());
    const res = await app.inject({ method: 'GET', url: '/api/checkins', headers: auth('admin1') });
    expect(res.statusCode).toBe(400);
  });

  it('shows estimated_sales and raw_import only to admins', async () => {
    const db = seed({
      checkins: {
        c1: {
          producer_id: 'p1',
          market_id: 'wlrfm',
          market_date_id: 'wlrfm_2026-04-18',
          submitted_at: new Date('2026-04-18T13:30:00Z'),
          estimated_sales: { value: 500, raw: '$500', kind: 'exact' },
          raw_import: null,
        },
      },
    });
    const app = await buildApp(db);

    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/checkins?market_date_id=wlrfm_2026-04-18',
      headers: auth('admin1'),
    });
    expect(adminRes.json().checkins[0].estimated_sales.value).toBe(500);

    const managerRes = await app.inject({
      method: 'GET',
      url: '/api/checkins?market_date_id=wlrfm_2026-04-18',
      headers: auth('mgr_wlrfm'),
    });
    expect(managerRes.json().checkins[0].estimated_sales).toBeUndefined();
    expect(managerRes.json().checkins[0].raw_import).toBeUndefined();
  });

  it('scopes a market_manager to their assigned markets', async () => {
    const db = seed({
      checkins: {
        c1: { producer_id: 'p1', market_id: 'argenta', market_date_id: 'argenta_2026-04-18', submitted_at: new Date() },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/checkins?market_date_id=argenta_2026-04-18',
      headers: auth('mgr_wlrfm'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().checkins).toHaveLength(0);
  });

  it('sorts by submitted_at descending', async () => {
    const db = seed({
      checkins: {
        c1: { producer_id: 'p1', market_id: 'wlrfm', submitted_at: new Date('2026-04-18T13:00:00Z') },
        c2: { producer_id: 'p1', market_id: 'wlrfm', submitted_at: new Date('2026-04-25T13:00:00Z') },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/checkins?producer_id=p1', headers: auth('admin1') });
    const checkins = res.json().checkins;
    expect(checkins[0].id).toBe('c2');
    expect(checkins[1].id).toBe('c1');
  });
});
