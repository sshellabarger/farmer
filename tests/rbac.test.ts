import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { authenticate, requireRole } from '../src/middleware/rbac.js';
import { requireMarketAccess, marketIdFromParams } from '../src/middleware/market-scope.js';
import { signJwt } from '../src/utils/jwt.js';
import { fakeDb } from './helpers/fake-db.js';

const SECRET = 'test-secret';

function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', { JWT_SECRET: SECRET } as never);
  return app;
}

describe('authenticate', () => {
  it('populates assigned_market_ids as [] when the user doc lacks it', async () => {
    const db = fakeDb({ users: { u1: { name: 'Ann', role: 'admin', phone: '+15015550100' } } });
    const app = buildApp(db);
    app.get('/whoami', { preHandler: authenticate(app) }, async (req) => req.authUser);
    await app.ready();

    const token = signJwt({ sub: 'u1', role: 'admin' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'u1', assigned_market_ids: [] });
  });

  it('rejects an active:false user with 401', async () => {
    const db = fakeDb({ users: { u1: { name: 'Ann', role: 'admin', phone: '+15015550100', active: false } } });
    const app = buildApp(db);
    app.get('/whoami', { preHandler: authenticate(app) }, async () => ({ ok: true }));
    await app.ready();

    const token = signJwt({ sub: 'u1', role: 'admin' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('requireRole', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    const db = fakeDb({
      users: {
        u_admin: { name: 'Ann', role: 'admin', phone: '+15015550100' },
        u_mgr: { name: 'Mia', role: 'market_manager', phone: '+15015550101', assigned_market_ids: ['wlrfm'] },
        u_farmer: { name: 'Fred', role: 'farmer', phone: '+15015550102' },
      },
    });
    app = buildApp(db);
    app.get('/admin-only', { preHandler: [authenticate(app), requireRole('admin')] }, async () => ({ ok: true }));
    await app.ready();
  });

  it('rejects market_manager with 403', async () => {
    const token = signJwt({ sub: 'u_mgr', role: 'market_manager' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the legacy farmer role with 403', async () => {
    const token = signJwt({ sub: 'u_farmer', role: 'farmer' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('allows admin', async () => {
    const token = signJwt({ sub: 'u_admin', role: 'admin' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('requireMarketAccess', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    const db = fakeDb({
      users: {
        u_admin: { name: 'Ann', role: 'admin', phone: '+15015550100' },
        u_mgr: { name: 'Mia', role: 'market_manager', phone: '+15015550101', assigned_market_ids: ['argenta'] },
      },
    });
    app = buildApp(db);
    app.get(
      '/markets/:id',
      { preHandler: [authenticate(app), requireMarketAccess(marketIdFromParams('id'))] },
      async () => ({ ok: true }),
    );
    app.get('/no-id', { preHandler: [authenticate(app), requireMarketAccess(() => undefined)] }, async () => ({ ok: true }));
    await app.ready();
  });

  it('admin passes for any market id', async () => {
    const token = signJwt({ sub: 'u_admin', role: 'admin' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/markets/wlrfm', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('market_manager gets 403 on a market outside their assignment', async () => {
    const token = signJwt({ sub: 'u_mgr', role: 'market_manager' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/markets/wlrfm', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('market_manager gets 200 on their assigned market', async () => {
    const token = signJwt({ sub: 'u_mgr', role: 'market_manager' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/markets/argenta', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('missing market id is 400', async () => {
    const token = signJwt({ sub: 'u_admin', role: 'admin' }, SECRET);
    const res = await app.inject({ method: 'GET', url: '/no-id', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
  });
});
