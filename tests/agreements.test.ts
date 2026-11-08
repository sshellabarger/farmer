import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { agreementRoutes } from '../src/routes/agreements.js';
import { fakeDb } from './helpers/fake-db.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import { mintPurposeToken, resolvePurposeToken } from '../src/services/purpose-tokens.js';
import { generateToken } from '../src/services/link-tokens.js';
import type { Env } from '../src/config/env.js';

const env = {
  NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example', ALERT_EMAIL: 'alerts@example.com', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

const NOW = new Date('2027-02-10T15:00:00Z');
const D0 = new Date('2026-01-01T00:00:00Z');
const HH_TEXT = '# Hold Harmless\n\nThe vendor agrees to hold harmless KBK-Breck, LLC.';

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

function seed(membership: Record<string, unknown> = {}) {
  return fakeDb({
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' }, timezone: 'America/Chicago',
        schedule: { versions: [], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
        active: true, created_by: 'test', created_at: D0, updated_at: D0,
        season: { label: '2027', application_open: null, application_close: null, schedule_version_id: null },
        legal: { hold_harmless_markdown: HH_TEXT, hold_harmless_version: '2027-1', insurance_help_url: 'https://example.test/insurance.pdf' },
      },
    },
    producers: { p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true, email: 'alice@example.test' } },
    producer_memberships: {
      p1_wlrfm_2027: {
        producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', fee_plan: 'seasonal', spaces: 1, history: [{ from: null, to: 'approved', at: D0, by: 'admin1', note: null }],
        created_at: D0, updated_at: D0, ...membership,
      },
    },
  });
}

async function mint(db: ReturnType<typeof fakeDb>, extra: Partial<Parameters<typeof mintPurposeToken>[1]> = {}) {
  return mintPurposeToken(db as never, {
    purpose: 'agreement', producer_id: 'p1', market_id: 'wlrfm', season: '2027', membership_id: 'p1_wlrfm_2027',
    expires_at: new Date(NOW.getTime() + 60 * 86_400_000), now: NOW, created_by: 'admin1', ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(agreementRoutes, { prefix: '/api/agreements' });
  await app.ready();
  return app;
}

const get = (app: Awaited<ReturnType<typeof buildApp>>, token: string) => app.inject({ method: 'GET', url: `/api/agreements/${token}` });
const sign = (app: Awaited<ReturnType<typeof buildApp>>, token: string, payload: unknown = { signature_name: 'Alice Apple', agree: true }) =>
  app.inject({ method: 'POST', url: `/api/agreements/${token}`, payload: payload as never });

describe('GET /api/agreements/:token', () => {
  it('returns the open view with the market\'s text and version', async () => {
    const db = seed();
    const t = await mint(db);
    const res = await get(await buildApp(db), t.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'open', market_name: 'West Little Rock Farmers Market', season: '2027', business_name: 'Acme Farm', contact_name: 'Alice Apple',
      hold_harmless_markdown: HH_TEXT, hold_harmless_version: '2027-1', insurance_help_url: 'https://example.test/insurance.pdf',
      signed: null, expires_at: new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is 404 for a malformed, unknown, check-in or application token; 410 for an expired one', async () => {
    const db = seed();
    const app = await buildApp(db);
    expect((await get(app, 'short')).statusCode).toBe(404);
    expect((await get(app, generateToken())).statusCode).toBe(404);

    const checkin = generateToken();
    await db.collection('link_tokens').doc(checkin).set({
      token: checkin, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2027-04-03', expires_at: new Date(NOW.getTime() + 86_400_000),
      used_at: null, uses: 0, max_uses: 25, created_at: NOW, created_by: 'engine', sent_message_id: null,
    });
    expect((await get(app, checkin)).statusCode).toBe(404);
    expect((await sign(app, checkin)).statusCode).toBe(404);

    const application = await mint(db, { purpose: 'application', membership_id: null });
    expect((await get(app, application.token)).statusCode).toBe(404);

    const expired = await mint(db, { expires_at: new Date(NOW.getTime() - 1000) });
    const res = await get(app, expired.token);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('This link has expired');
  });

  it('is 404 when the membership behind the token is gone', async () => {
    const db = seed();
    const t = await mint(db, { membership_id: 'ghost' });
    expect((await get(await buildApp(db), t.token)).statusCode).toBe(404);
  });
});

describe('POST /api/agreements/:token', () => {
  it('signs: records the signature, activates the membership, spends the token, sends nothing', async () => {
    const db = seed();
    const t = await mint(db);
    const app = await buildApp(db);
    const res = await sign(app, t.token, { signature_name: '  Alice Apple  ', agree: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, signed: { name: 'Alice Apple', signed_at: NOW.toISOString() }, membership_status: 'active' });

    const m = db.dump('producer_memberships').p1_wlrfm_2027 as any;
    expect(m.hold_harmless).toEqual({ signed_at: NOW, name: 'Alice Apple', ip: expect.any(String), version: '2027-1', token: t.token });
    expect(m.hold_harmless.ip).not.toBe('');
    expect(m.status).toBe('active');
    expect(m.history).toHaveLength(2);
    expect(m.history[1]).toEqual({ from: 'approved', to: 'active', at: NOW, by: 'producer', note: 'Hold Harmless signed' });

    const token = db.dump('link_tokens')[t.token] as any;
    expect(token.uses).toBe(1);
    expect(token.used_at).toEqual(NOW);

    // No text, no email.
    expect(db.count('messages')).toBe(0);
    expect(logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && /^\[(sms|email):console\]/.test(c[0]))).toHaveLength(0);

    const audit = Object.values(db.dump('audit_log')).filter((a: any) => a.action === 'membership.agreement.signed') as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'producer:p1', actor_role: 'producer', target: { collection: 'producer_memberships', id: 'p1_wlrfm_2027' } });
    expect(JSON.stringify(audit[0])).not.toContain('Alice Apple');
  });

  it('a second signature is a 409 and changes nothing; the link then shows the signed state', async () => {
    const db = seed();
    const t = await mint(db);
    const app = await buildApp(db);
    await sign(app, t.token);
    const before = JSON.stringify(db.dump('producer_memberships'));

    vi.setSystemTime(new Date(NOW.getTime() + 3600_000));
    const again = await sign(app, t.token, { signature_name: 'Somebody Else', agree: true });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('Already signed');
    expect(JSON.stringify(db.dump('producer_memberships'))).toBe(before);

    const view = await get(app, t.token);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'signed', signed: { name: 'Alice Apple', signed_at: NOW.toISOString() }, hold_harmless_version: '2027-1' });
  });

  it('a second link for an already-signed membership shows signed and refuses to sign again', async () => {
    const db = seed();
    const first = await mint(db);
    const second = await mint(db);
    const app = await buildApp(db);
    await sign(app, first.token);
    expect((await get(app, second.token)).json().status).toBe('signed');
    expect((await sign(app, second.token)).statusCode).toBe(409);
  });

  it('records the version actually signed even if the market publishes a newer text later', async () => {
    const db = seed();
    const t = await mint(db);
    const app = await buildApp(db);
    await sign(app, t.token);
    await db.collection('farmers_markets').doc('wlrfm').update({ 'legal.hold_harmless_version': '2027-2' });
    const view = (await get(app, t.token)).json();
    expect(view.hold_harmless_version).toBe('2027-1');
  });

  it('leaves a membership that is already active active, without a history entry', async () => {
    const db = seed({ status: 'active' });
    const t = await mint(db);
    const res = await sign(await buildApp(db), t.token);
    expect(res.json().membership_status).toBe('active');
    const m = db.dump('producer_memberships').p1_wlrfm_2027 as any;
    expect(m.hold_harmless.name).toBe('Alice Apple');
    expect(m.history).toHaveLength(1);
  });

  it('409s for an inactive membership and does not sign it', async () => {
    const db = seed({ status: 'inactive' });
    const t = await mint(db);
    const res = await sign(await buildApp(db), t.token);
    expect(res.statusCode).toBe(409);
    expect((db.dump('producer_memberships').p1_wlrfm_2027 as any).hold_harmless).toBeUndefined();
  });

  it('is 410 once the link has expired', async () => {
    const db = seed();
    const t = await mint(db, { expires_at: new Date(NOW.getTime() + 1000) });
    const app = await buildApp(db);
    vi.setSystemTime(new Date(NOW.getTime() + 2000));
    const res = await sign(app, t.token);
    expect(res.statusCode).toBe(410);
    expect((db.dump('producer_memberships').p1_wlrfm_2027 as any).hold_harmless).toBeUndefined();
  });

  it('validates the body: a name of 2+ characters and agree === true', async () => {
    const db = seed();
    const t = await mint(db);
    const app = await buildApp(db);
    for (const payload of [{ signature_name: 'A', agree: true }, { signature_name: 'Alice Apple', agree: false }, { signature_name: 'Alice Apple' }, {}, { signature_name: ' ', agree: true }]) {
      expect((await sign(app, t.token, payload)).statusCode).toBe(400);
    }
    expect((db.dump('producer_memberships').p1_wlrfm_2027 as any).hold_harmless).toBeUndefined();
    expect((db.dump('link_tokens')[t.token] as any).uses).toBe(0);
  });

  it('two simultaneous signatures: exactly one wins', async () => {
    const db = seed();
    const t = await mint(db);
    const app = await buildApp(db);
    const [a, b] = await Promise.all([sign(app, t.token, { signature_name: 'First Signer', agree: true }), sign(app, t.token, { signature_name: 'Second Signer', agree: true })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const m = db.dump('producer_memberships').p1_wlrfm_2027 as any;
    expect(['First Signer', 'Second Signer']).toContain(m.hold_harmless.name);
    expect(m.history).toHaveLength(2);
  });

  it('takes over a stale signing lock but not a fresh one', async () => {
    const stale = seed();
    await stale.collection('workflow_locks').doc('agreement__p1_wlrfm_2027').set({ key: 'agreement', membership_id: 'p1_wlrfm_2027', claimed_at: new Date(NOW.getTime() - 60 * 60_000), created_at: NOW });
    const t1 = await mint(stale);
    expect((await sign(await buildApp(stale), t1.token)).statusCode).toBe(200);

    const fresh = seed();
    await fresh.collection('workflow_locks').doc('agreement__p1_wlrfm_2027').set({ key: 'agreement', membership_id: 'p1_wlrfm_2027', claimed_at: new Date(NOW.getTime() - 1000), created_at: NOW });
    const t2 = await mint(fresh);
    const res = await sign(await buildApp(fresh), t2.token);
    expect(res.statusCode).toBe(409);
    expect((fresh.dump('producer_memberships').p1_wlrfm_2027 as any).hold_harmless).toBeUndefined();
  });

  it('a spent token does not lock out a membership that was never actually signed', async () => {
    const db = seed();
    const t = await mint(db);
    await db.collection('link_tokens').doc(t.token).update({ uses: 1, used_at: NOW });
    const app = await buildApp(db);
    expect((await get(app, t.token)).json().status).toBe('open');
    expect((await sign(app, t.token)).statusCode).toBe(200);
    expect((await resolvePurposeToken(db as never, t.token, 'agreement', NOW)).status).toBe('used');
  });
});
