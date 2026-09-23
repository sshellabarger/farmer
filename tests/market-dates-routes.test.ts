import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { marketDateRoutes } from '../src/routes/market-dates.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { Env } from '../src/config/env.js';

// See tests/helpers/staff-auth.ts / tests/checkins.test.ts for this pattern.
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
  APP_URL: 'https://test.example', ALERT_EMAIL: 'alerts@example.com', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

// The routes read the real clock: the resend cases need wlrfm_2026-09-19 to
// be inside its grace window (deadline 09-22T17:00Z + 3 days) and the close
// cases need wlrfm_2026-03-21 ended and wlrfm_2099-01-03 not. Pinned so the
// suite does not go red on the real 2026-09-25.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function seed(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  return fakeDb({
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', phone: '+15015550002', assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', phone: '+15015550003', assigned_market_ids: ['argenta'] },
    },
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' },
        timezone: 'America/Chicago', schedule: { versions: [], skipped_dates: [], special_dates: [] },
        workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS, active: true, created_by: 'test',
        created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
      },
    },
    market_dates: {
      'wlrfm_2026-09-19': {
        market_id: 'wlrfm', date: '2026-09-19', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2026-09-19T13:00:00Z'), end_at: new Date('2026-09-19T17:00:00Z'),
        status: 'collecting', schedule_version: 'v1', special: false, note: '',
        actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: new Date('2026-09-01'), source: 'import', created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-01'),
      },
      'wlrfm_2026-03-21': {
        market_id: 'wlrfm', date: '2026-03-21', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2026-03-21T13:00:00Z'), end_at: new Date('2026-03-21T17:00:00Z'),
        status: 'collecting', schedule_version: 'v1', special: false, note: '',
        actions: { checkin_sent_at: new Date('2026-03-21T14:00:00Z'), reminders_sent: [], deadline_at: new Date('2026-03-24T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: new Date('2026-03-01'), source: 'import', created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01'),
      },
    },
    producers: {
      p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
      p2: { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: '+15015550102', active: true },
      p3: { business_name: 'Gamma Farm', contact_name: '', phone: null, active: true },
    },
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
      p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
    },
    ...extra,
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
  await app.ready();
  return app;
}

function auth(userId: string) {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

describe('GET /api/market-dates/:id/status', () => {
  it('401s without auth, 404s an unknown date, 403s a manager outside their market', async () => {
    const db = seed();
    const app = await buildApp(db);

    const noAuth = await app.inject({ method: 'GET', url: '/api/market-dates/wlrfm_2026-09-19/status' });
    expect(noAuth.statusCode).toBe(401);

    const notFound = await app.inject({ method: 'GET', url: '/api/market-dates/bogus/status', headers: auth('admin1') });
    expect(notFound.statusCode).toBe(404);

    const forbidden = await app.inject({ method: 'GET', url: '/api/market-dates/wlrfm_2026-09-19/status', headers: auth('mgr_a') });
    expect(forbidden.statusCode).toBe(403);
  });

  it('returns counts, next_due and per-recipient rows', async () => {
    const db = seed();
    await db.collection('messages').doc('m1').set({
      direction: 'outbound', to: '+15015550101', from: 'console', body: 'x', provider: 'console', provider_message_id: 'y',
      status: 'sent', status_at: new Date(), error: null, kind: 'checkin_link', segments: 1, token: 'tok1',
      producer_id: 'p1', market_date_id: 'wlrfm_2026-09-19', user_id: null, sent_by: null, created_at: new Date('2026-09-19T18:00:00Z'),
    });
    await db.collection('market_dates').doc('wlrfm_2026-09-19').update({
      actions: { checkin_sent_at: new Date('2026-09-19T18:00:00Z'), reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null, checkin_recipients: 2, checkin_failed: 0 },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/market-dates/wlrfm_2026-09-19/status', headers: auth('admin1') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ recipients: 2, responded: 0, non_responders: 2, excluded: 1 });
    expect(body.next_due.action).toBe('reminder');
    const p1Row = body.recipients.find((r: any) => r.producer_id === 'p1');
    expect(p1Row.link_sends).toBe(1);
    expect(p1Row.responded).toBe(false);
    expect(body.excluded).toHaveLength(1);
    expect(body.excluded[0].reason).toBe('no_phone');
  });
});

describe('POST /api/market-dates/:id/resend-checkin', () => {
  it('mints a fresh token, sends, and audits', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-09-19/resend-checkin?producer_id=p1', headers: auth('mgr_w'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sms.status).toBe('simulated');
    expect(body.message_id).toBeTruthy();
    expect(body.token_expires_at).toBeTruthy();

    const linkMsgs = Object.values(db.dump('messages')).filter((m: any) => m.kind === 'checkin_link');
    expect(linkMsgs).toHaveLength(1);
    expect((linkMsgs[0] as any).sent_by).toBe('mgr_w');

    const audit = Object.values(db.dump('audit_log'));
    expect(audit.some((a: any) => a.action === 'market_date.checkin.resend')).toBe(true);
  });

  it('409s for a producer with no phone', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-09-19/resend-checkin?producer_id=p3', headers: auth('admin1'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('no_phone');
  });

  it('409s after the grace period', async () => {
    const db = seed({
      market_dates: {
        'wlrfm_2026-09-19': {
          market_id: 'wlrfm', date: '2026-09-19', start_time: '08:00', end_time: '12:00',
          start_at: new Date('2020-01-01T13:00:00Z'), end_at: new Date('2020-01-01T17:00:00Z'),
          status: 'collecting', schedule_version: 'v1', special: false, note: '',
          actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2020-01-04T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
          extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
          generated_at: new Date('2019-12-01'), source: 'import', created_at: new Date('2019-12-01'), updated_at: new Date('2019-12-01'),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-09-19/resend-checkin?producer_id=p1', headers: auth('admin1'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('past_grace');
  });
});

describe('POST /api/market-dates/:id/close', () => {
  it('403s a market_manager (admin only)', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-03-21/close', headers: auth('mgr_w'), payload: { notify: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it('409s a date that has not yet ended', async () => {
    const db = seed({
      market_dates: {
        'wlrfm_2099-01-03': {
          market_id: 'wlrfm', date: '2099-01-03', start_time: '08:00', end_time: '12:00',
          start_at: new Date('2099-01-03T13:00:00Z'), end_at: new Date('2099-01-03T17:00:00Z'),
          status: 'collecting', schedule_version: 'v1', special: false, note: '',
          actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2099-01-06T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
          extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
          generated_at: new Date('2098-12-01'), source: 'import', created_at: new Date('2098-12-01'), updated_at: new Date('2098-12-01'),
        },
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2099-01-03/close', headers: auth('admin1'), payload: { notify: false },
    });
    expect(res.statusCode).toBe(409);
  });

  it('with notify:false writes flags, sends nothing, and audits', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-03-21/close', headers: auth('admin1'), payload: { notify: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.summary).toBe('skipped_notify_false');
    expect(db.count('messages')).toBe(0);
    const dateDoc: any = db.dump('market_dates')['wlrfm_2026-03-21'];
    expect(dateDoc.actions.deadline_processed_at).toBeTruthy();
    expect(dateDoc.actions.summary_skipped).toBe('notify_false');
    const audit = Object.values(db.dump('audit_log'));
    expect(audit.some((a: any) => a.action === 'market_date.close')).toBe(true);
  });

  it('with notify:true sends the summary', async () => {
    const db = seed();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/api/market-dates/wlrfm_2026-03-21/close', headers: auth('admin1'), payload: { notify: true },
    });
    expect(res.statusCode).toBe(200);
    const summaryMsgs = Object.values(db.dump('messages')).filter((m: any) => m.kind === 'deadline_summary');
    expect(summaryMsgs.length).toBeGreaterThan(0);
  });
});
