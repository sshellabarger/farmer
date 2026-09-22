import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { adminUserRoutes } from '../src/routes/admin-users.js';
import { authRoutes } from '../src/routes/auth.js';
import { signJwt } from '../src/utils/jwt.js';
import { fakeDb } from './helpers/fake-db.js';
import { createErrorHandler } from '../src/utils/http-error-handler.js';

const SECRET = 'test-secret';
const ENV = { JWT_SECRET: SECRET, NODE_ENV: 'development', APP_URL: 'http://test' } as never;

const sendSms = vi.fn(async () => 'msg-id');
vi.mock('../src/services/sms.js', () => ({
  sendSms: (...args: unknown[]) => sendSms(...(args as [])),
}));

beforeEach(() => {
  sendSms.mockClear();
  sendSms.mockImplementation(async () => 'msg-id');
});

function seededDb(extraUsers: Record<string, Record<string, unknown>> = {}) {
  return fakeDb({
    users: { u_admin: { name: 'Ann', role: 'admin', phone: '+15015550100' }, ...extraUsers },
  });
}

async function buildApp(db = seededDb()) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', ENV);
  app.setErrorHandler(createErrorHandler({ env: ENV, notify: false }));
  await app.register(adminUserRoutes, { prefix: '/api/admin/users' });
  await app.ready();
  return { app, db };
}

function auth(sub: string, role = 'admin') {
  return { authorization: `Bearer ${signJwt({ sub, role }, SECRET)}` };
}

describe('POST /api/admin/users/invite', () => {
  it('creates the user + invites row and calls sendSms with kind admin_invite', async () => {
    const { app, db } = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/admin/users/invite', headers: auth('u_admin'),
      payload: { phone: '5015550199', name: 'New Mgr', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sms.status).toBe('simulated');
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0]![0]).toMatchObject({ kind: 'admin_invite' });

    const invites = Object.values(db.dump('invites'));
    expect(invites).toHaveLength(1);
    expect((invites[0] as any).kind).toBe('admin_user');
  });

  it('still returns 201 with sms.status failed when sendSms throws', async () => {
    sendSms.mockImplementation(async () => { throw new Error('voip.ms down'); });
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/admin/users/invite', headers: auth('u_admin'),
      payload: { phone: '5015550199', name: 'New Mgr', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sms.status).toBe('failed');
  });

  it('400s a market_manager invite with no markets', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/admin/users/invite', headers: auth('u_admin'),
      payload: { phone: '5015550199', name: 'New Mgr', role: 'market_manager', assigned_market_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409s a duplicate phone', async () => {
    const db = seededDb({ u2: { name: 'Existing', role: 'farmer', phone: '+15015550199' } });
    const { app } = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/admin/users/invite', headers: auth('u_admin'),
      payload: { phone: '5015550199', name: 'New Mgr', role: 'admin', assigned_market_ids: [] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /api/admin/users/:id', () => {
  it('a self-demotion is 409', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users/u_admin', headers: auth('u_admin'), payload: { role: 'market_manager' } });
    expect(res.statusCode).toBe(409);
  });

  it('self-deactivation is 409', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users/u_admin', headers: auth('u_admin'), payload: { active: false } });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/admin/users', () => {
  it('lists includes assigned_market_ids', async () => {
    const db = seededDb({ u2: { name: 'Mia', role: 'market_manager', phone: '+15015550101', assigned_market_ids: ['wlrfm'] } });
    const { app } = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth('u_admin') });
    expect(res.statusCode).toBe(200);
    const u2 = res.json().users.find((u: any) => u.id === 'u2');
    expect(u2.assigned_market_ids).toEqual(['wlrfm']);
  });
});

describe('GET /api/auth/me', () => {
  it('returns assigned_market_ids', async () => {
    const db = seededDb({ u2: { name: 'Mia', role: 'market_manager', phone: '+15015550101', assigned_market_ids: ['wlrfm'] } });
    const app = Fastify();
    app.decorate('db', db as never);
    app.decorate('env', ENV);
    app.setErrorHandler(createErrorHandler({ env: ENV, notify: false }));
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth('u2', 'market_manager') });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.assigned_market_ids).toEqual(['wlrfm']);
  });
});
