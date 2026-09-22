// Phase 3 end-to-end (contract §7.5, the integrator's test): the whole
// check-in workflow through the real app — buildApp() over a fake Firestore
// with the console providers — from a Saturday schedule to the staff status
// page. One controllable `now` drives both the engine (injected) and the
// routes (they read `new Date()`, faked here), so the timeline is
// deterministic whenever this file runs.
//
// Two timelines: the one-producer flow the integrator was asked for (the
// producer answers, so no reminder, an empty non_responders list and a
// 1-of-1 summary) and the contract's literal two-producer flow (p2 never
// answers, so the reminders go to p2 only and the deadline flags p2). Then
// the concurrency variant: the first tick as three simultaneous engine runs.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { fakeDb } from './helpers/fake-db.js';
import { processMarketDates } from '../src/services/checkin-workflow.js';
import { generateMarketDates, marketDateFromData } from '../src/services/market-dates.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { FarmersMarket } from '../src/services/markets.js';
import { signJwt } from '../src/utils/jwt.js';
import { TOKEN_RE } from '../src/services/link-tokens.js';
import type { Env } from '../src/config/env.js';

vi.mock('../src/services/error-notify.js', () => ({ notifyError: vi.fn(async () => {}) }));

const env = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example',
  VOIPMS_DID: '5015550999',
  VOIPMS_WEBHOOK_SECRET: '',
  ALERT_EMAIL: 'alerts@example.com',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as Env;

const DATE_ID = 'wlrfm_2026-09-19';
const P1_PHONE = '+15015550101';
const P2_PHONE = '+15015550102';
const ADMIN_PHONE = '+15015550001';

const T_CHECKIN = new Date('2026-09-19T18:00:00Z'); // Sat 12:00 CDT close + 60 min
const T_REMINDER_1 = new Date('2026-09-20T17:00:00Z'); // + 1440 min
const T_REMINDER_2 = new Date('2026-09-21T17:00:00Z'); // + 2880 min
const T_DEADLINE = new Date('2026-09-22T17:00:00Z'); // + 4320 min

function wlrfm(): FarmersMarket {
  return {
    id: 'wlrfm',
    name: 'West Little Rock Farmers Market',
    slug: 'wlrfm',
    location: { name: 'Breckenridge Village', address: '' },
    timezone: 'America/Chicago',
    schedule: {
      versions: [
        {
          id: 'v1',
          effective_from: '2026-04-18',
          season_start: '2026-04-18',
          season_end: '2026-10-31',
          days_of_week: ['saturday'],
          start_time: '08:00',
          end_time: '12:00',
          created_at: new Date('2026-01-01'),
          created_by: 'import',
        },
      ],
      skipped_dates: [],
      special_dates: [],
    },
    workflow: DEFAULT_WORKFLOW,
    quiet_hours: DEFAULT_QUIET_HOURS,
    active: true,
    created_by: 'import',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

type Db = ReturnType<typeof fakeDb>;

/** A market with a Saturday schedule, its rolling dates generated, N producers, one admin. */
async function seed(producerCount: 1 | 2): Promise<Db> {
  const producers: Record<string, Record<string, unknown>> = {
    p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: P1_PHONE, active: true, sms_opt_out_at: null },
  };
  const memberships: Record<string, Record<string, unknown>> = {
    p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
  };
  if (producerCount === 2) {
    producers.p2 = { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: P2_PHONE, active: true, sms_opt_out_at: null };
    memberships.p2_wlrfm = { producer_id: 'p2', market_id: 'wlrfm', status: 'active' };
  }
  const market = wlrfm();
  const db = fakeDb({
    farmers_markets: { wlrfm: market as unknown as Record<string, unknown> },
    producers,
    producer_memberships: memberships,
    users: { admin1: { name: 'Admin', role: 'admin', phone: ADMIN_PHONE, active: true } },
  });
  // The same generator the nightly rollMarketDates job runs: the Saturday
  // schedule is what puts wlrfm_2026-09-19 (08:00–12:00 CDT) into `collecting`.
  await generateMarketDates(db as never, market, { scope: 'window', now: T_CHECKIN, actor: 'test' });
  await db.collection('market_dates').doc(DATE_ID).update({
    extra_questions: [{ key: 'booth_size', prompt: 'Booth size?', type: 'choice', options: ['10x10', '10x20'] }],
  });
  return db;
}

async function boot(db: Db): Promise<FastifyInstance> {
  const app = await buildApp({ db: db as never, env, notifyOnError: false, logLevel: 'silent' });
  await app.ready();
  return app;
}

const now = (t: Date) => vi.setSystemTime(t);
const tick = (db: Db, t: Date) => processMarketDates(db as never, env, { now: t });
const rowsOfKind = (db: Db, kind: string) =>
  Object.entries(db.dump('messages'))
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, ...(m as Record<string, unknown>) }));
const adminAuth = () => ({ authorization: `Bearer ${signJwt({ sub: 'admin1', role: 'admin' }, env.JWT_SECRET)}` });
const tokenFromBody = (body: unknown) => {
  const m = /\/checkin\?t=([A-Za-z0-9_-]{43})/.exec(String(body));
  expect(m).not.toBeNull();
  return m![1]!;
};
const inbound = (from: string, message: string) =>
  `/api/sms/voipms/inbound?from=${from.replace('+', '')}&message=${encodeURIComponent(message)}&id=sms-${Math.random().toString(36).slice(2)}`;

const FULL_FORM = {
  attending_next: true,
  bringing_next: 'tomatoes, eggs',
  sold_out: 'peppers',
  unsold: '',
  estimated_sales: '500-1000',
  transactions_estimate: '29',
  feedback: 'great day',
  extra_answers: { booth_size: '10x10' },
};

let logSpy: ReturnType<typeof vi.spyOn>;
function startClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const emailPrints = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[email:console]'));

describe('Phase 3 end-to-end — one producer who answers', () => {
  it('link → GET → YES by text → GET → form POST → GET → no reminder → deadline + summary → status → sms/status no-op', async () => {
    startClock();
    const db = await seed(1);
    const app = await boot(db);
    const dateDoc = () => db.dump('market_dates')[DATE_ID]! as Record<string, unknown>;
    expect(dateDoc()).toMatchObject({ status: 'collecting', end_at: new Date('2026-09-19T17:00:00Z') });

    // ── Engine tick: the check-in link goes out ──────────────────────────
    now(T_CHECKIN);
    const r1 = await tick(db, T_CHECKIN);
    expect(r1).toMatchObject({ considered: 1, checkin_sent: 1, errors: [] });
    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ to: P1_PHONE, producer_id: 'p1', market_date_id: DATE_ID, status: 'simulated', provider: 'console' });
    expect(links[0]!.id).toBe(`checkin_link:${DATE_ID}:p1`);
    const token = tokenFromBody(links[0]!.body);
    expect(token).toMatch(TOKEN_RE);
    expect(links[0]!.token).toBe(token);
    expect(db.dump('link_tokens')[token]).toMatchObject({ producer_id: 'p1', market_date_id: DATE_ID, created_by: 'engine', sent_message_id: links[0]!.id });

    // ── The producer opens the link ──────────────────────────────────────
    const get1 = await app.inject({ method: 'GET', url: `/api/checkin/${token}` });
    expect(get1.statusCode).toBe(200);
    expect(get1.json()).toMatchObject({
      producer_name: 'Acme Farm',
      market_name: 'West Little Rock Farmers Market',
      market_date_id: DATE_ID,
      date_label: 'Saturday, Sep 19, 2026',
      deadline_label: 'Tue Sep 22, 12:00 PM',
      past_deadline: false,
      existing: null,
    });
    expect(get1.json().questions.extra_questions).toEqual([{ key: 'booth_size', prompt: 'Booth size?', type: 'choice', options: ['10x10', '10x20'] }]);
    expect(get1.json().token).toBeUndefined();
    expect(get1.headers['set-cookie']).toBeUndefined();

    // ── The producer texts YES (the voip.ms webhook shape) ───────────────
    now(new Date('2026-09-19T19:00:00Z'));
    const yes = await app.inject({ method: 'GET', url: inbound(P1_PHONE, 'YES') });
    expect(yes.statusCode).toBe(200);
    expect(db.dump('checkins')[`${DATE_ID}_p1`]).toMatchObject({ source: 'sms', partial: true, attending_next: true, attending_next_raw: 'YES', token_id: token });
    const replies = rowsOfKind(db, 'auto_reply');
    expect(replies).toHaveLength(1);
    expect(String(replies[0]!.body)).toContain(`/checkin?t=${token}`);

    const get2 = await app.inject({ method: 'GET', url: `/api/checkin/${token}` });
    expect(get2.statusCode).toBe(200);
    expect(get2.json().existing).toMatchObject({ attending_next: true, source: 'sms', partial: true, bringing_next: '' });

    // ── The producer completes the form ──────────────────────────────────
    now(new Date('2026-09-19T20:00:00Z'));
    const post = await app.inject({ method: 'POST', url: `/api/checkin/${token}`, payload: FULL_FORM });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ ok: true, checkin: { attending_next: true, bringing_next: 'tomatoes, eggs', submissions: 2 } });
    expect(db.dump('checkins')[`${DATE_ID}_p1`]).toMatchObject({
      source: 'form',
      partial: false,
      submissions: 2,
      bringing_next: ['tomatoes', 'eggs'],
      sold_out_items: ['peppers'],
      estimated_sales: { value: 750, raw: '500-1000', kind: 'range' },
      extra_answers: { booth_size: '10x10' },
      created_at: new Date('2026-09-19T19:00:00Z'), // preserved from the SMS partial
    });
    expect(db.dump('link_tokens')[token]).toMatchObject({ uses: 1 });

    const get3 = await app.inject({ method: 'GET', url: `/api/checkin/${token}` });
    expect(get3.json().existing).toMatchObject({ ...FULL_FORM, source: 'form', partial: false });

    // ── Reminder instants: nothing for a producer who has answered ───────
    now(T_REMINDER_1);
    const r2 = await tick(db, T_REMINDER_1);
    expect(r2).toMatchObject({ reminders_sent: 0, errors: [] });
    expect(rowsOfKind(db, 'checkin_reminder')).toHaveLength(0);
    // What every reader sees: reminders_sent derived from the per-offset reminder_state fields the engine writes.
    const remindersSent = () => marketDateFromData(DATE_ID, dateDoc()).actions.reminders_sent;
    expect(remindersSent()).toEqual([{ offset_min: 1440, sent_at: T_REMINDER_1, recipients: 0, failed: 0, skipped: null }]);
    let actions = dateDoc().actions as Record<string, unknown>;
    expect(Object.keys(actions.reminder_state as Record<string, unknown>)).toEqual(['offset_1440']);

    now(T_REMINDER_2);
    await tick(db, T_REMINDER_2);
    expect(rowsOfKind(db, 'checkin_reminder')).toHaveLength(0);
    expect(remindersSent().map((r) => r.offset_min)).toEqual([1440, 2880]);

    // ── Deadline: flags written, one summary to the admin ────────────────
    now(T_DEADLINE);
    const r4 = await tick(db, T_DEADLINE);
    expect(r4).toMatchObject({ deadlines_processed: 1, summaries_sent: 1, errors: [] });
    expect(dateDoc()).toMatchObject({ non_responders: [], spot_not_held: [], deadline_recipient_count: 1, deadline_responded_count: 1 });
    actions = dateDoc().actions as Record<string, unknown>;
    expect(actions.deadline_processed_at).toEqual(T_DEADLINE);
    expect(actions.summary_sent_at).toEqual(T_DEADLINE);
    const summaries = rowsOfKind(db, 'deadline_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ to: ADMIN_PHONE, user_id: 'admin1', market_date_id: DATE_ID, status: 'simulated' });
    expect(String(summaries[0]!.body)).toContain('1 of 1 responded');
    expect(String(summaries[0]!.body)).toContain('Everyone responded.');
    expect(String(summaries[0]!.body)).toContain(`/admin/market-dates?id=${DATE_ID}`);
    expect(emailPrints()).toHaveLength(1);
    expect(emailPrints()[0]![1]).toBe(env.ALERT_EMAIL);

    // ── The staff status page ────────────────────────────────────────────
    const status = await app.inject({ method: 'GET', url: `/api/market-dates/${DATE_ID}/status`, headers: adminAuth() });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.counts).toEqual({ recipients: 1, responded: 1, non_responders: 0, excluded: 0 });
    expect(body.next_due).toEqual({ action: 'none', at: null });
    expect(body.date.id).toBe(DATE_ID);
    expect(body.date.actions).toMatchObject({
      checkin_sent_at: T_CHECKIN.toISOString(),
      checkin_recipients: 1,
      checkin_failed: 0,
      deadline_processed_at: T_DEADLINE.toISOString(),
      summary_sent_at: T_DEADLINE.toISOString(),
    });
    expect(Object.keys(body.date.actions.claims).sort()).toEqual(['checkin', 'deadline', 'reminder_1440', 'reminder_2880', 'summary']);
    expect(body.date.non_responders).toEqual([]);
    expect(body.recipients).toHaveLength(1);
    expect(body.recipients[0]).toMatchObject({
      producer_id: 'p1',
      responded: true,
      late: false,
      link_sends: 1,
      reminders_sent: 0,
      last_status: 'simulated',
      checkin: { source: 'form', partial: false, attending_next: true },
    });
    expect(body.messages.map((m: { kind: string }) => m.kind).sort()).toEqual(['checkin_link', 'deadline_summary']);
    expect(body.schedule.deadline_at).toBe(T_DEADLINE.toISOString());

    // Unauthenticated, the same page is a 401.
    expect((await app.inject({ method: 'GET', url: `/api/market-dates/${DATE_ID}/status` })).statusCode).toBe(401);

    // ── Delivery-status callback: a documented no-op ─────────────────────
    const before = JSON.stringify(db.dump('messages'));
    const dlr = await app.inject({ method: 'POST', url: '/api/sms/status', payload: { sms: 12345, status: 'delivered' } });
    expect(dlr.statusCode).toBe(200);
    expect(dlr.json()).toEqual({ ok: true, updated: false });
    expect(JSON.stringify(db.dump('messages'))).toBe(before);

    // A later tick changes nothing.
    now(new Date('2026-09-22T17:05:00Z'));
    await tick(db, new Date('2026-09-22T17:05:00Z'));
    expect(db.count('messages')).toBe(4); // checkin_link, inbound, auto_reply, deadline_summary
    expect(emailPrints()).toHaveLength(1);
    await app.close();
  });
});

describe('Phase 3 end-to-end — contract §7.5 literal timeline (p1 answers, p2 never does)', () => {
  it('reminders go to p2 only; the deadline flags p2; the status counts 2 / 1 / 1', async () => {
    startClock();
    const db = await seed(2);
    const app = await boot(db);

    now(T_CHECKIN);
    await tick(db, T_CHECKIN);
    const links = rowsOfKind(db, 'checkin_link');
    expect(links.map((l) => l.producer_id).sort()).toEqual(['p1', 'p2']);
    const token = tokenFromBody(links.find((l) => l.producer_id === 'p1')!.body);

    expect((await app.inject({ method: 'GET', url: `/api/checkin/${token}` })).json().existing).toBeNull();

    now(new Date('2026-09-19T19:00:00Z'));
    await app.inject({ method: 'GET', url: inbound(P1_PHONE, 'YES') });
    expect(db.dump('checkins')[`${DATE_ID}_p1`]).toMatchObject({ source: 'sms', attending_next: true, partial: true });
    expect((await app.inject({ method: 'GET', url: `/api/checkin/${token}` })).json().existing).toMatchObject({ attending_next: true, partial: true });

    const post = await app.inject({ method: 'POST', url: `/api/checkin/${token}`, payload: FULL_FORM });
    expect(post.statusCode).toBe(200);
    expect(db.dump('checkins')[`${DATE_ID}_p1`]).toMatchObject({ source: 'form', partial: false });

    now(T_REMINDER_1);
    await tick(db, T_REMINDER_1);
    let reminders = rowsOfKind(db, 'checkin_reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ producer_id: 'p2', to: P2_PHONE, offset_min: 1440 });

    now(T_REMINDER_2);
    await tick(db, T_REMINDER_2);
    reminders = rowsOfKind(db, 'checkin_reminder');
    expect(reminders.map((r) => [r.producer_id, r.offset_min])).toEqual([
      ['p2', 1440],
      ['p2', 2880],
    ]);

    now(T_DEADLINE);
    await tick(db, T_DEADLINE);
    const dateDoc = db.dump('market_dates')[DATE_ID]! as Record<string, unknown>;
    expect(dateDoc.non_responders).toEqual(['p2']);
    expect(dateDoc.spot_not_held).toEqual(['p2']);
    const summaries = rowsOfKind(db, 'deadline_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ user_id: 'admin1', to: ADMIN_PHONE });
    expect(String(summaries[0]!.body)).toContain('1 of 2 responded');
    expect(String(summaries[0]!.body)).toContain('No response: Beta Farm.');

    const status = await app.inject({ method: 'GET', url: `/api/market-dates/${DATE_ID}/status`, headers: adminAuth() });
    expect(status.statusCode).toBe(200);
    expect(status.json().counts).toEqual({ recipients: 2, responded: 1, non_responders: 1, excluded: 0 });
    const p2Row = status.json().recipients.find((r: { producer_id: string }) => r.producer_id === 'p2');
    expect(p2Row).toMatchObject({ responded: false, link_sends: 1, reminders_sent: 2, checkin: null });

    const dlr = await app.inject({ method: 'POST', url: '/api/sms/status', payload: {} });
    expect(dlr.json()).toEqual({ ok: true, updated: false });
    await app.close();
  });
});

describe('Phase 3 end-to-end — the first tick as three simultaneous engine runs', () => {
  it('produces a single checkin_link row and the same link the producer can open', async () => {
    startClock();
    const db = await seed(1);
    const app = await boot(db);

    now(T_CHECKIN);
    const results = await Promise.all([tick(db, T_CHECKIN), tick(db, T_CHECKIN), tick(db, T_CHECKIN)]);
    expect(results.map((r) => r.checkin_sent).sort()).toEqual([0, 0, 1]);
    expect(results.map((r) => r.skipped_claimed).sort()).toEqual([0, 1, 1]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);

    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(1);
    expect(logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[sms:console]'))).toHaveLength(1);
    expect(db.count('link_tokens')).toBe(1);
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([`${DATE_ID}__checkin`]);

    const token = tokenFromBody(links[0]!.body);
    const get = await app.inject({ method: 'GET', url: `/api/checkin/${token}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().existing).toBeNull();
    await app.close();
  });
});
