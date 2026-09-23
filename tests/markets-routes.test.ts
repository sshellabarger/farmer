import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { marketRoutes } from '../src/routes/markets.js';
import { signJwt } from '../src/utils/jwt.js';
import { fakeDb } from './helpers/fake-db.js';
import { createErrorHandler } from '../src/utils/http-error-handler.js';

const SECRET = 'test-secret';
const ENV = { JWT_SECRET: SECRET, NODE_ENV: 'test' } as never;

// The market routes generate the rolling date window from the real clock and
// the fixture's season ends 2026-10-31: pin the clock inside the season so the
// suite does not turn red in November.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function seededDb(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  return fakeDb({
    users: {
      u_admin: { name: 'Ann', role: 'admin', phone: '+15015550100' },
      u_mgr: { name: 'Mia', role: 'market_manager', phone: '+15015550101', assigned_market_ids: ['wlrfm'] },
    },
    ...extra,
  });
}

async function buildApp(db = seededDb()) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', ENV);
  app.setErrorHandler(createErrorHandler({ env: ENV, notify: false }));
  await app.register(marketRoutes, { prefix: '/api/markets' });
  await app.ready();
  return { app, db };
}

function auth(sub: string, role = 'admin') {
  return { authorization: `Bearer ${signJwt({ sub, role }, SECRET)}` };
}

const validCreate = {
  slug: 'wlrfm',
  name: 'West Little Rock Farmers Market',
  location: { name: 'Breckenridge Village', address: '' },
  timezone: 'America/Chicago',
  schedule: {
    versions: [
      { effective_from: '2026-04-18', season_start: '2026-04-18', season_end: '2026-10-31', days_of_week: ['saturday'], start_time: '08:00', end_time: '12:00' },
    ],
  },
};

describe('POST /api/markets', () => {
  it('creates a market and generates its window', async () => {
    const { app, db } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.market.slug).toBe('wlrfm');
    expect(body.generation.created).toBeGreaterThan(0);
    expect(Object.keys(db.dump('market_dates')).length).toBeGreaterThan(0);

    const audit = Object.values(db.dump('audit_log'));
    expect(audit.some((a: any) => a.action === 'market.create')).toBe(true);
  });

  it('409s on a duplicate slug', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const res = await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    expect(res.statusCode).toBe(409);
  });

  it('403s for a market_manager', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_mgr', 'market_manager'), payload: validCreate });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/markets', () => {
  it('filters the list for a market_manager', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: { ...validCreate, slug: 'argenta', name: 'Argenta Farmers Market' } });

    const res = await app.inject({ method: 'GET', url: '/api/markets', headers: auth('u_mgr', 'market_manager') });
    expect(res.statusCode).toBe(200);
    const { markets } = res.json();
    expect(markets.map((m: any) => m.id)).toEqual(['wlrfm']);
  });
});

describe('GET /api/markets/public', () => {
  it('lists only active markets and omits mailchimp', async () => {
    const { app } = await buildApp();
    await app.inject({
      method: 'POST', url: '/api/markets', headers: auth('u_admin'),
      payload: { ...validCreate, mailchimp: { audience_id: 'a', template_id: 't' } },
    });
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: { ...validCreate, slug: 'argenta', name: 'Argenta', active: false } });

    const res = await app.inject({ method: 'GET', url: '/api/markets/public' });
    expect(res.statusCode).toBe(200);
    const { markets } = res.json();
    expect(markets).toHaveLength(1);
    expect(markets[0].id).toBe('wlrfm');
    expect(markets[0].mailchimp).toBeUndefined();
  });
});

describe('PATCH /api/markets/:id', () => {
  it('regenerates dates when the timezone changes', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });

    const res = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: auth('u_admin'), payload: { timezone: 'America/New_York' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market.timezone).toBe('America/New_York');
    expect(body.generation).toBeDefined();
  });

  it('does not regenerate for a plain name change', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const res = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: auth('u_admin'), payload: { name: 'New Name' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().generation).toBeUndefined();
  });
});

describe('schedule/skipped and schedule/special', () => {
  it('validates and 409s on an overlapping skip/special date', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });

    const skip = await app.inject({
      method: 'PUT', url: '/api/markets/wlrfm/schedule/skipped', headers: auth('u_admin'),
      payload: { skipped_dates: [{ date: '2026-07-04', reason: 'Holiday' }] },
    });
    expect(skip.statusCode).toBe(200);

    const special = await app.inject({
      method: 'PUT', url: '/api/markets/wlrfm/schedule/special', headers: auth('u_admin'),
      payload: { special_dates: [{ date: '2026-07-04', start_time: '10:00', end_time: '14:00', note: 'x' }] },
    });
    expect(special.statusCode).toBe(409);
  });

  it('rejects a malformed date with 400', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const res = await app.inject({
      method: 'PUT', url: '/api/markets/wlrfm/schedule/skipped', headers: auth('u_admin'),
      payload: { skipped_dates: [{ date: 'not-a-date', reason: 'x' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/markets/:id/schedule/versions/:version_id', () => {
  it('409s deleting the only version', async () => {
    const { app, db } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const versionId = (db.dump('farmers_markets').wlrfm as any).schedule.versions[0].id;

    const res = await app.inject({ method: 'DELETE', url: `/api/markets/wlrfm/schedule/versions/${versionId}`, headers: auth('u_admin') });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /api/markets/:id/dates/:date_id', () => {
  it('requires a reason to cancel', async () => {
    const { app, db } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const dateId = Object.keys(db.dump('market_dates'))[0]!;

    const res = await app.inject({ method: 'PATCH', url: `/api/markets/wlrfm/dates/${dateId}`, headers: auth('u_admin'), payload: { status: 'cancelled' } });
    expect(res.statusCode).toBe(400);
  });

  it('cancels with a reason and writes one audit row', async () => {
    const { app, db } = await buildApp();
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
    const dateId = Object.keys(db.dump('market_dates'))[0]!;

    const res = await app.inject({
      method: 'PATCH', url: `/api/markets/wlrfm/dates/${dateId}`, headers: auth('u_admin'),
      payload: { status: 'cancelled', cancellation_reason: 'Rain' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().date.status).toBe('cancelled');

    const audit = Object.values(db.dump('audit_log')).filter((a: any) => a.target.id === dateId);
    expect(audit).toHaveLength(1);
    expect((audit[0] as any).action).toBe('market_date.cancel');
  });
});

describe('every mutating market route writes exactly one audit_log row', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let db: Awaited<ReturnType<typeof buildApp>>['db'];

  beforeEach(async () => {
    ({ app, db } = await buildApp());
    await app.inject({ method: 'POST', url: '/api/markets', headers: auth('u_admin'), payload: validCreate });
  });

  it('market.schedule_version.add', async () => {
    const before = Object.keys(db.dump('audit_log')).length;
    await app.inject({
      method: 'POST', url: '/api/markets/wlrfm/schedule/versions', headers: auth('u_admin'),
      payload: { effective_from: '2026-11-01', season_start: '2026-11-01', season_end: '2026-12-01', days_of_week: ['sunday'], start_time: '09:00', end_time: '11:00' },
    });
    const rows = Object.values(db.dump('audit_log')).filter((a: any) => a.action === 'market.schedule_version.add');
    expect(rows).toHaveLength(1);
    expect(Object.keys(db.dump('audit_log')).length).toBe(before + 1);
  });
});
