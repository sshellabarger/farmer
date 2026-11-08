import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { marketDateRoutes } from '../src/routes/market-dates.js';
import { listRecipients, processMarketDates } from '../src/services/checkin-workflow.js';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
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

const D0 = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-11-08T15:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function version(id: string, effective_from: string, season_start: string, season_end: string) {
  return { id, effective_from, season_start, season_end, days_of_week: ['saturday'], start_time: '08:00', end_time: '12:00', created_at: D0, created_by: 'test' };
}

function market(extra: Record<string, unknown> = {}, versions: unknown[] = []) {
  return {
    id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' }, timezone: 'America/Chicago',
    schedule: { versions, skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
    active: true, created_by: 'test', created_at: D0, updated_at: D0, ...extra,
  };
}

const producers = {
  p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
  p2: { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: '+15015550102', active: true },
  p3: { business_name: 'Gamma Farm', contact_name: 'Gus Grape', phone: '+15015550103', active: true },
};

describe('listRecipients — only the current season counts (D33)', () => {
  it('a producer with a 2026 and a 2027 membership is a recipient iff the 2027 row is active (season.label = 2027)', async () => {
    const memberships = (statusOf2027: string) => ({
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' }, // Phase 2 doc: no season field, reads as 2026
      p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: statusOf2027 },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' }, // never re-applied
      p3_wlrfm_2027: { producer_id: 'p3', market_id: 'wlrfm', season: '2027', status: 'active' },
    });

    const approved = fakeDb({ farmers_markets: { wlrfm: market({ season: { label: '2027', application_open: null, application_close: null, schedule_version_id: null } }) }, producers, producer_memberships: memberships('approved') });
    const a = await listRecipients(approved as never, 'wlrfm');
    expect(a.recipients.map((r) => r.producer_id)).toEqual(['p3']);
    expect(a.excluded).toEqual([]); // last season's vendors are simply not part of this season

    const active = fakeDb({ farmers_markets: { wlrfm: market({ season: { label: '2027', application_open: null, application_close: null, schedule_version_id: null } }) }, producers, producer_memberships: memberships('active') });
    const b = await listRecipients(active as never, 'wlrfm');
    expect(b.recipients.map((r) => r.producer_id)).toEqual(['p1', 'p3']);
  });

  it('a 2026 row that is inactive does not block an active 2027 row', async () => {
    const db = fakeDb({
      farmers_markets: { wlrfm: market({ season: { label: '2027' } }) }, producers,
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', season: '2026', status: 'inactive' },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'active' },
      },
    });
    expect((await listRecipients(db as never, 'wlrfm')).recipients.map((r) => r.producer_id)).toEqual(['p1']);
  });

  it('Phase 3 fixtures (no season anywhere) resolve to 2026 and keep working', async () => {
    const db = fakeDb({
      farmers_markets: { wlrfm: market() }, producers,
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
        p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'inactive' },
      },
    });
    const r = await listRecipients(db as never, 'wlrfm');
    expect(r.recipients.map((x) => x.producer_id)).toEqual(['p1']);
    // Even a market document that does not exist behaves (the legacy season).
    const orphan = fakeDb({ producers, producer_memberships: { p1_wlrfm: { producer_id: 'p1', market_id: 'ghost', status: 'active' } } });
    expect((await listRecipients(orphan as never, 'ghost')).recipients.map((x) => x.producer_id)).toEqual(['p1']);
  });

  it('infers the season from the schedule when no label is set, as of the caller\'s clock', async () => {
    const versions = [version('v1', '2026-04-18', '2026-04-18', '2026-10-31'), version('v2', '2027-01-01', '2027-04-03', '2027-11-27')];
    const db = fakeDb({
      farmers_markets: { wlrfm: market({}, versions) }, producers,
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
        p2_wlrfm_2027: { producer_id: 'p2', market_id: 'wlrfm', season: '2027', status: 'active' },
      },
    });
    const in2026 = await listRecipients(db as never, 'wlrfm', { now: new Date('2026-11-08T15:00:00Z') });
    expect(in2026.recipients.map((r) => r.producer_id)).toEqual(['p1']);
    const in2027 = await listRecipients(db as never, 'wlrfm', { now: new Date('2027-02-01T15:00:00Z') });
    expect(in2027.recipients.map((r) => r.producer_id)).toEqual(['p2']);
  });

  it('a producer\'s own exclusions still apply inside the season', async () => {
    const db = fakeDb({
      farmers_markets: { wlrfm: market({ season: { label: '2027' } }) },
      producers: { ...producers, p2: { ...producers.p2, phone: null }, p3: { ...producers.p3, sms_opt_out_at: new Date('2026-10-01') } },
      producer_memberships: {
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'active' },
        p2_wlrfm_2027: { producer_id: 'p2', market_id: 'wlrfm', season: '2027', status: 'active' },
        p3_wlrfm_2027: { producer_id: 'p3', market_id: 'wlrfm', season: '2027', status: 'active' },
      },
    });
    const r = await listRecipients(db as never, 'wlrfm');
    expect(r.recipients.map((x) => x.producer_id)).toEqual(['p1']);
    expect(r.excluded.map((x) => `${x.producer_id}:${x.reason}`).sort()).toEqual(['p2:no_phone', 'p3:opted_out']);
  });
});

function seasonDb() {
  return fakeDb({
    users: { admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' } },
    farmers_markets: { wlrfm: market({ season: { label: '2027', application_open: null, application_close: null, schedule_version_id: null } }) },
    market_dates: {
      'wlrfm_2027-04-03': {
        market_id: 'wlrfm', date: '2027-04-03', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2027-04-03T13:00:00Z'), end_at: new Date('2027-04-03T17:00:00Z'),
        status: 'collecting', schedule_version: 'v2', special: false, note: '',
        actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2027-04-06T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: D0, source: 'generator', created_at: D0, updated_at: D0,
      },
    },
    producers,
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' }, // 2026 only
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
      p2_wlrfm_2027: { producer_id: 'p2', market_id: 'wlrfm', season: '2027', status: 'active' }, // re-applied
      p3_wlrfm_2027: { producer_id: 'p3', market_id: 'wlrfm', season: '2027', status: 'approved' }, // not signed yet
    },
  });
}

describe('the engine sends only to current-season vendors', () => {
  it('texts the check-in link to the re-applied vendor and to nobody else', async () => {
    const db = seasonDb();
    const t = new Date('2027-04-03T18:00:00Z'); // end + 60 min, outside quiet hours
    vi.setSystemTime(t);
    const r = await processMarketDates(db as never, env, { now: t });
    expect(r.errors).toEqual([]);
    expect(r.checkin_sent).toBe(1);
    const msgs = Object.values(db.dump('messages')) as any[];
    expect(msgs.filter((m) => m.kind === 'checkin_link').map((m) => m.producer_id)).toEqual(['p2']);
    expect((db.dump('market_dates')['wlrfm_2027-04-03'] as any).actions.checkin_recipients).toBe(1);
  });
});

describe('POST /api/market-dates/:id/resend-checkin uses the current season', () => {
  async function app(db: ReturnType<typeof fakeDb>) {
    const a = Fastify();
    a.decorate('db', db as never);
    a.decorate('env', env as never);
    await a.register(marketDateRoutes, { prefix: '/api/market-dates' });
    await a.ready();
    return a;
  }
  const resend = (a: Awaited<ReturnType<typeof app>>, producer: string) =>
    a.inject({ method: 'POST', url: `/api/market-dates/wlrfm_2027-04-03/resend-checkin?producer_id=${producer}`, headers: { authorization: `Bearer ${tokenFor('admin1')}` } });

  it('409s a producer who has only a 2026 membership, and an approved-but-unsigned 2027 one; sends to the active 2027 vendor', async () => {
    const db = seasonDb();
    vi.setSystemTime(new Date('2027-04-04T15:00:00Z'));
    const a = await app(db);
    const old = await resend(a, 'p1');
    expect(old.statusCode).toBe(409);
    expect(old.json().reason).toBe('no_active_membership');
    const unsigned = await resend(a, 'p3');
    expect(unsigned.statusCode).toBe(409);
    expect(unsigned.json().reason).toBe('no_active_membership');
    const ok = await resend(a, 'p2');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().sms.status).toBe('simulated');
  });
});
