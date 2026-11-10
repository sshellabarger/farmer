import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { insuranceRoutes } from '../src/routes/insurance.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import { resolvePurposeToken, purposeTokensFor } from '../src/services/purpose-tokens.js';
import { insuranceExpiresOn, insuranceExpiryInstant, insuranceStatusAt, membershipFromData } from '../src/services/seasons.js';
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

const NOW = new Date('2027-03-01T16:00:00Z');
const D0 = new Date('2026-01-01T00:00:00Z');
const UPLOAD = '3f0f4c0e-6c1f-4b0f-9a52-0c3f0a1d2e11';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seed(membership: Record<string, unknown> = {}, producer: Record<string, unknown> = {}) {
  return fakeDb({
    users: {
      admin1: { name: 'Admin', role: 'admin' },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', assigned_market_ids: ['argenta'] },
    },
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' }, timezone: 'America/Chicago',
        schedule: { versions: [], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
        active: true, created_by: 'test', created_at: D0, updated_at: D0, season: { label: '2027' },
      },
    },
    producers: { p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true, ...producer } },
    producer_memberships: {
      p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', spaces: 1, history: [], created_at: D0, updated_at: D0, ...membership },
    },
    application_uploads: { [UPLOAD]: { draft_id: 'd', kind: 'insurance', storage_path: 'x', uploaded_at: D0 } },
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(insuranceRoutes, { prefix: '/api/memberships' });
  await app.ready();
  return app;
}

const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });
const patch = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown, user = 'mgr_w', id = 'p1_wlrfm_2027') =>
  app.inject({ method: 'PATCH', url: `/api/memberships/${id}/insurance`, headers: auth(user), payload: payload as never });
const link = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown = {}, user = 'mgr_w', id = 'p1_wlrfm_2027') =>
  app.inject({ method: 'POST', url: `/api/memberships/${id}/agreement-link`, headers: auth(user), payload: payload as never });
const stored = (db: ReturnType<typeof fakeDb>) => db.dump('producer_memberships').p1_wlrfm_2027 as any;
const acceptanceTexts = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith('[sms:console]') && c[2] === 'acceptance');

describe('PATCH /api/memberships/:id/insurance', () => {
  it('missing -> on_file: records the expiry (valid through that day), who verified it and when', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await patch(app, { status: 'on_file', expires_on: '2027-12-31', upload_id: UPLOAD, note: 'Certificate from the carrier' });
    expect(res.statusCode).toBe(200);
    const ins = stored(db).insurance;
    expect(ins).toMatchObject({ status: 'on_file', upload_id: UPLOAD, verified_by: 'mgr_w', verified_at: NOW, note: 'Certificate from the carrier' });
    // The calendar date is stored as typed; the instant is market-local midnight at the start of the next day (CST, UTC-6).
    expect(ins.expires_on).toBe('2027-12-31');
    expect(ins.expires_at).toEqual(new Date('2028-01-01T06:00:00.000Z'));
    expect(res.json().membership.insurance).toMatchObject({ status: 'on_file', verified_by: 'mgr_w', expires_on: '2027-12-31' });
    expect(res.json().membership.id).toBe('p1_wlrfm_2027');
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'membership.insurance' && a.actor_id === 'mgr_w')).toBe(true);
  });

  it('on_file -> waived keeps verification; -> missing clears it', async () => {
    const db = seed();
    const app = await buildApp(db);
    await patch(app, { status: 'on_file', expires_on: '2027-12-31' });
    await patch(app, { status: 'waived', note: 'Covered by the market policy' }, 'admin1');
    expect(stored(db).insurance).toMatchObject({ status: 'waived', verified_by: 'admin1', verified_at: NOW, expires_on: null, expires_at: null, note: 'Covered by the market policy' });
    await patch(app, { status: 'missing' });
    expect(stored(db).insurance).toMatchObject({ status: 'missing', verified_by: null, verified_at: null });
  });

  it('keeps the attached certificate when a later update does not mention it', async () => {
    const db = seed();
    const app = await buildApp(db);
    await patch(app, { status: 'on_file', expires_on: '2027-12-31', upload_id: UPLOAD });
    await patch(app, { status: 'on_file', expires_on: '2028-12-31' });
    expect(stored(db).insurance.upload_id).toBe(UPLOAD);
    await patch(app, { status: 'on_file', expires_on: '2028-12-31', upload_id: null });
    expect(stored(db).insurance.upload_id).toBeNull();
  });

  it('reads an on_file certificate past its expiry as expired, in the response and via insuranceStatusAt', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await patch(app, { status: 'on_file', expires_on: '2027-02-28' }); // expired yesterday (NOW is 2027-03-01)
    expect(res.json().membership.insurance.status).toBe('expired');
    expect(stored(db).insurance.status).toBe('on_file'); // the stored fact is unchanged; expiry is derived
    const view = membershipFromData('p1_wlrfm_2027', stored(db));
    expect(insuranceStatusAt(view.insurance, NOW)).toBe('expired');
    expect(insuranceStatusAt(view.insurance, new Date('2027-02-28T12:00:00Z'))).toBe('on_file'); // still valid on the expiry day
    expect(insuranceStatusAt({ ...view.insurance, status: 'waived' }, NOW)).toBe('waived');
  });

  it('400s a bad date, an impossible date, an unknown status and an unknown upload; writes nothing', async () => {
    const db = seed();
    const app = await buildApp(db);
    for (const payload of [
      { status: 'on_file', expires_on: '12/31/2027' },
      { status: 'on_file', expires_on: '2027-02-30' },
      { status: 'on_file', expires_on: '2027-12-31T00:00:00.000Z' },
      { status: 'great' },
      {},
      { status: 'on_file', upload_id: 'not-a-uuid' },
      { status: 'on_file', upload_id: '11111111-2222-4333-8444-555555555555' },
    ]) {
      expect((await patch(app, payload)).statusCode).toBe(400);
    }
    expect(stored(db).insurance).toBeUndefined();
  });

  it('404s an unknown membership, 403s a manager of another market, 401s without auth', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await patch(app, { status: 'waived' }, 'mgr_w', 'ghost')).statusCode).toBe(404);
    expect((await patch(app, { status: 'waived' }, 'mgr_a')).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/memberships/p1_wlrfm_2027/insurance', payload: { status: 'waived' } })).statusCode).toBe(401);
    expect(stored(db).insurance).toBeUndefined();
  });

  it('works on a Phase 2 membership that has no season and no insurance field', async () => {
    const db = fakeDb({
      users: { admin1: { name: 'Admin', role: 'admin' } },
      producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' } },
    });
    const app = await buildApp(db);
    const res = await patch(app, { status: 'on_file' }, 'admin1', 'p1_wlrfm');
    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toMatchObject({ season: '2026', fee_plan: 'daily' });
    expect((db.dump('producer_memberships').p1_wlrfm as any).insurance.status).toBe('on_file');
  });
});

// Fix X11. The expiry of a certificate is a calendar date in the market's own
// calendar. It used to be stored as the instant of market-local midnight at the
// start of D + 1 and shown as that instant's UTC date, i.e. D + 1: every
// unchanged save from the admin page pushed a compliance date one day later.
describe('PATCH /api/memberships/:id/insurance — the expiry is a calendar date', () => {
  const view = (res: { json: () => any }) => res.json().membership.insurance;

  it('enter 2027-06-30, read back 2027-06-30; re-saved unchanged three times it is still 2027-06-30', async () => {
    const db = seed();
    const app = await buildApp(db);
    let res = await patch(app, { status: 'on_file', expires_on: '2027-06-30', note: 'From the carrier' });
    expect(res.statusCode).toBe(200);
    expect(view(res).expires_on).toBe('2027-06-30');
    expect(stored(db).insurance.expires_on).toBe('2027-06-30');
    // Valid through June 30 in Chicago (CDT, UTC-5): it lapses at the first moment of July 1 there.
    expect(stored(db).insurance.expires_at).toEqual(new Date('2027-07-01T05:00:00.000Z'));

    for (let i = 0; i < 3; i += 1) {
      // What the admin page does: pre-fill the form from the response, save it unchanged.
      const shown = view(res);
      res = await patch(app, { status: shown.status, expires_on: shown.expires_on, upload_id: shown.upload_id, note: shown.note });
      expect(res.statusCode).toBe(200);
      expect(view(res).expires_on).toBe('2027-06-30');
    }
    expect(stored(db).insurance.expires_on).toBe('2027-06-30');
    expect(stored(db).insurance.expires_at).toEqual(new Date('2027-07-01T05:00:00.000Z'));
  });

  it('refuses the old request shape instead of guessing: expires_at is a 400 and the stored date does not move', async () => {
    const db = seed();
    const app = await buildApp(db);
    const saved = await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    // What the page did before the fix: show the instant's UTC date (the NEXT day) and send it back.
    const drifted = String(view(saved).expires_at).slice(0, 10);
    expect(drifted).toBe('2027-07-01');
    const res = await patch(app, { status: 'on_file', expires_at: drifted });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('expires_on_required');
    expect(stored(db).insurance.expires_on).toBe('2027-06-30');
    expect(stored(db).insurance.expires_at).toEqual(new Date('2027-07-01T05:00:00.000Z'));
    // An explicit null (no date) is not the old shape.
    expect((await patch(app, { status: 'waived', expires_at: null })).statusCode).toBe(200);
  });

  it('is valid through the whole of its last day and expired exactly at the start of the next, market-local', async () => {
    const db = seed();
    const app = await buildApp(db);
    await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    const insurance = membershipFromData('p1_wlrfm_2027', stored(db)).insurance;
    const lastMoment = new Date('2027-07-01T04:59:59.999Z'); // 23:59:59.999 on June 30 in Chicago
    const firstMoment = new Date('2027-07-01T05:00:00.000Z'); // 00:00:00.000 on July 1 in Chicago
    expect(insuranceStatusAt(insurance, lastMoment)).toBe('on_file');
    expect(insuranceStatusAt(insurance, firstMoment)).toBe('expired');
    // It is already July 1 in UTC for five hours before it lapses: the market's calendar decides, not UTC.
    expect(insuranceStatusAt(insurance, new Date('2027-07-01T00:00:00.000Z'))).toBe('on_file');

    // The route's own answer follows the same clock, and the date it shows never changes with it.
    vi.setSystemTime(lastMoment);
    let res = await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    expect(view(res)).toMatchObject({ status: 'on_file', expires_on: '2027-06-30' });
    vi.setSystemTime(firstMoment);
    res = await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    expect(view(res)).toMatchObject({ status: 'expired', expires_on: '2027-06-30' });
  });

  it('daylight-saving boundaries: the day before and the day of each change keep their date and lapse at local midnight', async () => {
    const db = seed();
    const app = await buildApp(db);
    for (const [day, lapses] of [
      ['2027-03-13', '2027-03-14T06:00:00.000Z'], // midnight is still CST; clocks go forward two hours later
      ['2027-03-14', '2027-03-15T05:00:00.000Z'], // a 23-hour day: the next midnight is CDT
      ['2027-11-06', '2027-11-07T05:00:00.000Z'], // midnight is still CDT; clocks go back an hour later
      ['2027-11-07', '2027-11-08T06:00:00.000Z'], // a 25-hour day: the next midnight is CST
    ] as const) {
      let res = await patch(app, { status: 'on_file', expires_on: day });
      expect(view(res).expires_on, day).toBe(day);
      expect(stored(db).insurance.expires_at, day).toEqual(new Date(lapses));
      res = await patch(app, { status: 'on_file', expires_on: view(res).expires_on });
      expect(view(res).expires_on, day).toBe(day);
      const insurance = membershipFromData('p1_wlrfm_2027', stored(db)).insurance;
      expect(insuranceStatusAt(insurance, new Date(new Date(lapses).getTime() - 1)), day).toBe('on_file');
      expect(insuranceStatusAt(insurance, new Date(lapses)), day).toBe('expired');
    }
  });

  it('the calendar is the market\'s own: the same date lapses at a different instant in another timezone', async () => {
    const db = seed();
    await db.collection('farmers_markets').doc('wlrfm').update({ timezone: 'America/Los_Angeles' });
    const app = await buildApp(db);
    const res = await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    expect(view(res).expires_on).toBe('2027-06-30');
    expect(stored(db).insurance.expires_at).toEqual(new Date('2027-07-01T07:00:00.000Z')); // midnight PDT
  });

  it('a document that only has the instant reads as the market-local day just before it (both older shapes)', async () => {
    for (const expires_at of [
      new Date('2027-07-01T05:00:00.000Z'), // "start of D + 1", what this route wrote before the fix
      new Date('2027-07-01T04:59:00.000Z'), // "23:59 on D", what the approval wrote before the fix
    ]) {
      const db = seed({ insurance: { status: 'on_file', expires_at, upload_id: null, verified_by: 'admin1', verified_at: D0, note: '' } });
      const app = await buildApp(db);
      const insurance = membershipFromData('p1_wlrfm_2027', stored(db)).insurance;
      expect(insurance.expires_on).toBeNull(); // nothing is stored: it is derived, with the market's timezone
      expect(insuranceExpiresOn(insurance, 'America/Chicago')).toBe('2027-06-30');

      // Saved back unchanged from what the API showed, it settles on that day and stays there.
      let res = await patch(app, { status: 'on_file', expires_on: '2027-06-30', note: '' });
      for (let i = 0; i < 3; i += 1) res = await patch(app, { status: 'on_file', expires_on: view(res).expires_on, note: '' });
      expect(view(res).expires_on).toBe('2027-06-30');
      expect(stored(db).insurance).toMatchObject({ expires_on: '2027-06-30', expires_at: new Date('2027-07-01T05:00:00.000Z') });
    }
    expect(insuranceExpiresOn({ expires_on: null, expires_at: null }, 'America/Chicago')).toBeNull();
    expect(insuranceExpiresOn({ expires_on: '2027-01-05', expires_at: new Date('2030-01-01') }, 'UTC')).toBe('2027-01-05'); // the stored date wins
  });

  it('insuranceExpiryInstant and insuranceExpiresOn are inverses in every timezone tried', () => {
    for (const tz of ['America/Chicago', 'America/Los_Angeles', 'UTC', 'Pacific/Auckland', 'America/St_Johns', 'Asia/Kolkata']) {
      for (const day of ['2027-01-01', '2027-03-14', '2027-06-30', '2027-11-07', '2027-12-31', '2028-02-29']) {
        expect(insuranceExpiresOn({ expires_on: null, expires_at: insuranceExpiryInstant(day, tz) }, tz), `${day} ${tz}`).toBe(day);
      }
    }
  });

  it('the audit row records the calendar date before and after', async () => {
    const db = seed();
    const app = await buildApp(db);
    await patch(app, { status: 'on_file', expires_on: '2027-06-30' });
    await patch(app, { status: 'on_file', expires_on: '2027-12-31' });
    const audits = Object.values(db.dump('audit_log')).filter((a: any) => a.action === 'membership.insurance') as any[];
    expect(audits.map((a) => [a.before.expires_on, a.after.expires_on])).toEqual([
      [null, '2027-06-30'],
      ['2027-06-30', '2027-12-31'],
    ]);
  });
});

describe('POST /api/memberships/:id/agreement-link', () => {
  it('mints a fresh agreement token and texts it as one acceptance-kind message with no dedupe key', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await link(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sms).toBe('simulated');
    expect(body.url).toMatch(/^https:\/\/test\.example\/agreement\?t=[A-Za-z0-9_-]{43}$/);
    expect(body.expires_at).toBe(new Date(NOW.getTime() + 60 * 86_400_000).toISOString());

    const token = new URL(body.url).searchParams.get('t')!;
    const resolved = await resolvePurposeToken(db as never, token, 'agreement', NOW);
    expect(resolved.status).toBe('ok');
    if (resolved.status === 'ok') {
      expect(resolved.token).toMatchObject({ membership_id: 'p1_wlrfm_2027', producer_id: 'p1', market_id: 'wlrfm', season: '2027', created_by: 'mgr_w', max_uses: 1 });
      expect(resolved.token.sent_message_id).toBeTruthy();
    }

    const msgs = Object.entries(db.dump('messages')) as [string, any][];
    expect(msgs).toHaveLength(1);
    const [id, m] = msgs[0]!;
    expect(m).toMatchObject({ kind: 'acceptance', producer_id: 'p1', to: '+15015550101', sent_by: 'mgr_w', membership_id: 'p1_wlrfm_2027', status: 'simulated' });
    expect(id).not.toContain(':'); // a uuid: no dedupe key
    expect(m.body).toContain(body.url);
    expect(m.body).toContain('Alice, please sign the 2027 West Little Rock Farmers Market Hold Harmless agreement');
    expect(m.body.endsWith('Reply STOP to opt out.')).toBe(true);
    expect(acceptanceTexts()).toHaveLength(1);
    expect(Object.values(db.dump('audit_log')).some((a: any) => a.action === 'membership.agreement_link')).toBe(true);
  });

  it('a resend mints another token and sends another text; the earlier link keeps working', async () => {
    const db = seed();
    const app = await buildApp(db);
    const first = (await link(app)).json();
    vi.setSystemTime(new Date(NOW.getTime() + 3600_000));
    const second = (await link(app)).json();
    expect(second.url).not.toBe(first.url);
    expect(Object.keys(db.dump('messages'))).toHaveLength(2);
    expect(acceptanceTexts()).toHaveLength(2);
    const tokens = await purposeTokensFor(db as never, 'p1', 'agreement', { market_id: 'wlrfm', season: '2027' });
    expect(tokens).toHaveLength(2);
    const firstToken = new URL(first.url).searchParams.get('t')!;
    expect((await resolvePurposeToken(db as never, firstToken, 'agreement', new Date(NOW.getTime() + 7200_000))).status).toBe('ok');
  });

  it('send: false mints the link and texts nothing', async () => {
    const db = seed();
    const res = await link(await buildApp(db), { send: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().sms).toBe('skipped_not_requested');
    expect(db.count('messages')).toBe(0);
    expect(db.count('link_tokens')).toBe(1);
  });

  it.each([
    ['no phone', { phone: null }, 'skipped_no_phone'],
    ['a malformed phone', { phone: '501-555-0101' }, 'skipped_invalid_phone'],
    ['an opt-out', { sms_opt_out_at: new Date('2027-01-01') }, 'skipped_opted_out'],
    ['an inactive producer', { active: false }, 'skipped_inactive_producer'],
  ])('does not text a producer with %s, but still returns the link', async (_label, producer, expected) => {
    const db = seed({}, producer);
    const res = await link(await buildApp(db));
    expect(res.statusCode).toBe(200);
    expect(res.json().sms).toBe(expected);
    expect(res.json().url).toContain('/agreement?t=');
    expect(db.count('messages')).toBe(0);
  });

  it('409s once the agreement is signed, and for a membership that is not approved yet', async () => {
    const signed = seed({ status: 'active', hold_harmless: { signed_at: NOW, name: 'Alice Apple', ip: '1.2.3.4', version: '2027-1', token: 'x' } });
    const r1 = await link(await buildApp(signed));
    expect(r1.statusCode).toBe(409);
    expect(signed.count('link_tokens')).toBe(0);
    expect(signed.count('messages')).toBe(0);

    const applied = seed({ status: 'applied' });
    expect((await link(await buildApp(applied))).statusCode).toBe(409);
    const inactive = seed({ status: 'inactive' });
    expect((await link(await buildApp(inactive))).statusCode).toBe(409);
  });

  it('is scoped to the membership\'s market', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await link(app, {}, 'mgr_a')).statusCode).toBe(403);
    expect((await link(app, {}, 'mgr_w', 'ghost')).statusCode).toBe(404);
    expect((await link(app, { send: 'yes' })).statusCode).toBe(400);
    expect(db.count('link_tokens')).toBe(0);
  });
});
