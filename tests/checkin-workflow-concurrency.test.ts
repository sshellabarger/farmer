// Phase 3 fix — concurrency. The verifier's blocker: claim() was a
// read-then-write, so two genuinely concurrent processMarketDates runs (Cloud
// Scheduler every 5 min with a 300 s timeout, or a manual "run now" over a
// scheduled tick) both read the pre-claim state and both sent — 4 checkin_link
// rows for 2 recipients. The fix has two atomic layers, both exercised here:
//   1. workflow_locks/<date>__<step> created with DocumentReference.create()
//      (ALREADY_EXISTS for every run but one);
//   2. every engine send carries a dedupe_key that becomes the messages row id,
//      written with create() — the log row is the lock, so a duplicate can
//      never reach the provider.
// The staff resend is an intentional second text and carries no key.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { processMarketDates, DEDUPE_KEYS, workflowLockId } from '../src/services/checkin-workflow.js';
import { sendSms, trySendSms, DuplicateSendError, isAlreadyExists } from '../src/services/sms.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { marketDateRoutes } from '../src/routes/market-dates.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { Env } from '../src/config/env.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'vm-1') }));
const voipms = vi.mocked(voipmsSend);

// The resend test drives the real route; rbac is mocked the way every staff
// route test does it (see tests/helpers/staff-auth.ts).
vi.mock('../src/middleware/rbac.js', () => ({
  authenticate: (app: any) => async (request: any, reply: any) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer test:')) return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    const userId = header.slice('Bearer test:'.length);
    const userDoc = await app.db.collection('users').doc(userId).get();
    if (!userDoc.exists) return reply.status(401).send({ error: 'User not found' });
    const user = userDoc.data();
    request.authUser = { id: userDoc.id, name: user.name ?? null, role: user.role, phone: user.phone ?? null, assigned_market_ids: user.assigned_market_ids ?? [] };
  },
  requireRole: (...roles: string[]) => async (request: any, reply: any) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;
    if (!roles.includes(user.role)) return reply.status(403).send({ error: 'Forbidden: insufficient role' });
  },
}));

const env = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example',
  VOIPMS_DID: '5015550999',
  ALERT_EMAIL: 'alerts@example.com',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as Env;
const production = { ...env, SMS_PROVIDER: 'voipms', NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' } as Env;

const DATE_ID = 'wlrfm_2026-09-19';
type Db = ReturnType<typeof fakeDb>;
const asFirestore = (db: Db) => db as unknown as Firestore;

/** N phone-bearing producers (`p01`…) with active WLRFM memberships. */
function producersAndMemberships(n: number) {
  const producers: Record<string, Record<string, unknown>> = {};
  const memberships: Record<string, Record<string, unknown>> = {};
  for (let i = 1; i <= n; i++) {
    const id = `p${String(i).padStart(2, '0')}`;
    producers[id] = { business_name: `Farm ${String(i).padStart(2, '0')}`, contact_name: `Person ${i}`, phone: `+150155501${String(i).padStart(2, '0')}`, active: true };
    memberships[`${id}_wlrfm`] = { producer_id: id, market_id: 'wlrfm', status: 'active' };
  }
  return { producers, memberships };
}

function seed(recipientCount: number) {
  const { producers, memberships } = producersAndMemberships(recipientCount);
  return fakeDb({
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' },
        timezone: 'America/Chicago', schedule: { versions: [], skipped_dates: [], special_dates: [] },
        workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS, active: true, created_by: 'test',
        created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
      },
    },
    market_dates: {
      [DATE_ID]: {
        market_id: 'wlrfm', date: '2026-09-19', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2026-09-19T13:00:00Z'), end_at: new Date('2026-09-19T17:00:00Z'),
        status: 'collecting', schedule_version: 'v1', special: false, note: '',
        actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: new Date('2026-09-01'), source: 'import', created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-01'),
      },
    },
    producers,
    producer_memberships: memberships,
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', phone: '+15015550002', assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', phone: '+15015550003', assigned_market_ids: ['argenta'] },
      nophone: { name: 'No Phone Admin', role: 'admin', phone: null },
    },
  });
}

const rowsOfKind = (db: Db, kind: string) =>
  Object.entries(db.dump('messages'))
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, ...m }));
const perProducer = (rows: { producer_id?: unknown }[]) => {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(String(r.producer_id), (counts.get(String(r.producer_id)) ?? 0) + 1);
  return counts;
};
const run = (db: Db, now: Date) => processMarketDates(asFirestore(db), env, { now });
const concurrent = (db: Db, now: Date, n: number) => Promise.all(Array.from({ length: n }, () => run(db, now)));

/**
 * Count the `market_dates` updates that TRANSITION a flag from unset to set
 * (every engine update rewrites the whole `actions` map, so a later write
 * carrying the flag forward is not a second "set"). The proof that a flag is
 * set once, independent of the value — concurrent runs at the same tick all
 * write the same `now`, so comparing values would prove nothing.
 */
function countFlagWrites(db: Db) {
  const counts = { checkin_sent_at: 0, deadline_processed_at: 0, summary_sent_at: 0, non_responders: 0 };
  const collection = db.collection.bind(db);
  db.collection = (name: string) => {
    const col = collection(name);
    if (name !== 'market_dates') return col;
    const doc = col.doc.bind(col);
    col.doc = (id?: string) => {
      const ref = doc(id);
      const update = ref.update.bind(ref);
      ref.update = async (data) => {
        const prev = (db.dump('market_dates')[ref.id] ?? {}) as Record<string, unknown>;
        const prevActions = (prev.actions ?? {}) as Record<string, unknown>;
        const actions = (data.actions ?? {}) as Record<string, unknown>;
        for (const flag of ['checkin_sent_at', 'deadline_processed_at', 'summary_sent_at'] as const) {
          if (actions[flag] && !prevActions[flag]) counts[flag]++;
        }
        if ('non_responders' in data && !('non_responders' in prev)) counts.non_responders++;
        return update(data);
      };
      return ref;
    };
    return col;
  };
  return counts;
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  voipms.mockClear();
  voipms.mockImplementation(async () => 'vm-1');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
const smsPrints = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[sms:console]')).length;
const emailPrints = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[email:console]')).length;

describe('(a) the verifier\'s reproduction — two concurrent runs at the same tick, two recipients', () => {
  it('sends exactly one checkin_link per producer and sets checkin_sent_at once', async () => {
    const db = seed(2);
    const writes = countFlagWrites(db);
    const now = new Date('2026-09-19T18:00:00Z');

    const results = await concurrent(db, now, 2);

    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(2);
    expect([...perProducer(links).entries()].sort()).toEqual([['p01', 1], ['p02', 1]]);
    expect(links.map((l) => l.id).sort()).toEqual([DEDUPE_KEYS.checkin_link(DATE_ID, 'p01'), DEDUPE_KEYS.checkin_link(DATE_ID, 'p02')]);
    expect(links.every((l) => l.status === 'simulated')).toBe(true);
    expect(smsPrints()).toBe(2); // two texts reached the (console) provider, not four
    expect(db.count('link_tokens')).toBe(2);

    // One run won the lock and sent; the other was told the step was claimed.
    expect(results.map((r) => r.checkin_sent).sort()).toEqual([0, 2]);
    expect(results.map((r) => r.skipped_claimed).sort()).toEqual([0, 1]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);

    const date = db.dump('market_dates')[DATE_ID]! as Record<string, unknown>;
    const actions = date.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(now);
    expect(actions.checkin_recipients).toBe(2);
    expect(actions.checkin_failed).toBe(0);
    expect(writes.checkin_sent_at).toBe(1);
    expect((actions.claims as Record<string, unknown>).checkin).toEqual(now); // still written, informational
    expect(db.dump('workflow_locks')[workflowLockId(DATE_ID, 'checkin')]).toMatchObject({ market_date_id: DATE_ID, key: 'checkin', claimed_at: now });
  });
});

describe('(b) five concurrent runs on every tick of a 10-recipient date', () => {
  it('every producer gets one link and one reminder per offset; every staff phone one summary; the email goes once', async () => {
    const db = seed(10);
    const writes = countFlagWrites(db);
    const ticks = [
      new Date('2026-09-19T18:00:00Z'), // check-in
      new Date('2026-09-20T17:00:00Z'), // reminder 1440
      new Date('2026-09-21T17:00:00Z'), // reminder 2880
      new Date('2026-09-22T17:00:00Z'), // deadline + summary
    ];
    const allResults = [];
    for (const now of ticks) allResults.push(...(await concurrent(db, now, 5)));
    expect(allResults.flatMap((r) => r.errors)).toEqual([]);

    const producers = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(10);
    expect([...perProducer(links).keys()].sort()).toEqual(producers);
    expect([...perProducer(links).values()].every((n) => n === 1)).toBe(true);

    const reminders = rowsOfKind(db, 'checkin_reminder');
    expect(reminders).toHaveLength(20);
    for (const offset of [1440, 2880]) {
      const forOffset = reminders.filter((r) => r.offset_min === offset);
      expect(forOffset).toHaveLength(10);
      expect([...perProducer(forOffset).values()].every((n) => n === 1)).toBe(true);
      expect(forOffset.map((r) => r.id).sort()).toEqual(producers.map((p) => DEDUPE_KEYS.checkin_reminder(DATE_ID, p, offset)).sort());
    }

    const summaries = rowsOfKind(db, 'deadline_summary');
    expect(summaries.map((s) => s.user_id).sort()).toEqual(['admin1', 'mgr_w']); // never mgr_a / nophone, never twice
    expect(summaries.map((s) => s.id).sort()).toEqual([DEDUPE_KEYS.deadline_summary(DATE_ID, 'admin1'), DEDUPE_KEYS.deadline_summary(DATE_ID, 'mgr_w')]);
    expect(emailPrints()).toBe(1);
    expect(smsPrints()).toBe(32);
    expect(db.count('messages')).toBe(32);

    const date = db.dump('market_dates')[DATE_ID]! as Record<string, unknown>;
    const actions = date.actions as Record<string, unknown>;
    expect(date.non_responders).toEqual(producers);
    expect(date.spot_not_held).toEqual(producers);
    expect(date.deadline_recipient_count).toBe(10);
    expect(date.deadline_responded_count).toBe(0);
    expect(writes).toEqual({ checkin_sent_at: 1, deadline_processed_at: 1, summary_sent_at: 1, non_responders: 1 });
    const remindersSent = actions.reminders_sent as Record<string, unknown>[];
    expect(remindersSent.map((r) => r.offset_min)).toEqual([1440, 2880]); // one entry per offset, not one per run
    expect(remindersSent.every((r) => r.recipients === 10 && r.failed === 0 && r.skipped === null)).toBe(true);
    expect(actions.summary_sent_at).toEqual(ticks[3]);

    // One lock per step; a fifth run of the same tick changes nothing.
    expect(Object.keys(db.dump('workflow_locks')).sort()).toEqual(
      ['checkin', 'deadline', 'reminder_1440', 'reminder_2880', 'summary'].map((k) => workflowLockId(DATE_ID, k)).sort(),
    );
    await concurrent(db, new Date('2026-09-22T17:05:00Z'), 5);
    expect(db.count('messages')).toBe(32);
    expect(emailPrints()).toBe(1);
  });
});

describe('(c) a run that dies after the 3rd of 6 sends', () => {
  /** Make the Nth `link_tokens` doc update (the post-send `sent_message_id` write) throw once. */
  function dieOnNthTokenUpdate(db: Db, n: number) {
    let calls = 0;
    const collection = db.collection.bind(db);
    db.collection = (name: string) => {
      const col = collection(name);
      if (name !== 'link_tokens') return col;
      const doc = col.doc.bind(col);
      col.doc = (id?: string) => {
        const ref = doc(id);
        const update = ref.update.bind(ref);
        ref.update = async (data) => {
          calls += 1;
          if (calls === n) throw new Error('UNAVAILABLE: simulated crash mid-loop');
          return update(data);
        };
        return ref;
      };
      return col;
    };
  }

  it('leaves the other 3 for a later tick, past the lock TTL, and texts nobody twice', async () => {
    const db = seed(6);
    dieOnNthTokenUpdate(db, 3);

    // Tick 1: sends to the first three (business_name order), then dies.
    const r1 = await run(db, new Date('2026-09-19T18:00:00Z'));
    expect(r1.errors).toHaveLength(1);
    expect(r1.errors[0]).toContain(DATE_ID);
    expect(r1.errors[0]).toContain('simulated crash');
    let links = rowsOfKind(db, 'checkin_link');
    expect([...perProducer(links).keys()].sort()).toEqual(['p01', 'p02', 'p03']);
    expect(links.every((l) => l.status === 'simulated')).toBe(true); // the 3rd text DID go out before the crash
    let actions = (db.dump('market_dates')[DATE_ID]! as Record<string, unknown>).actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toBeNull();

    // Tick 2, five minutes later: the lock is younger than CLAIM_TTL_MS — skipped.
    const r2 = await run(db, new Date('2026-09-19T18:05:00Z'));
    expect(r2.skipped_claimed).toBe(1);
    expect(r2.checkin_sent).toBe(0);
    expect(rowsOfKind(db, 'checkin_link')).toHaveLength(3);

    // Tick 3, past the TTL: the lock is taken over and only the remaining three are texted.
    const r3 = await run(db, new Date('2026-09-19T18:11:00Z'));
    expect(r3.errors).toEqual([]);
    expect(r3.checkin_sent).toBe(3);
    links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(6);
    expect([...perProducer(links).values()].every((n) => n === 1)).toBe(true);
    expect(smsPrints()).toBe(6);
    actions = (db.dump('market_dates')[DATE_ID]! as Record<string, unknown>).actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(new Date('2026-09-19T18:11:00Z'));
    expect(actions.checkin_recipients).toBe(6);
    expect(actions.checkin_failed).toBe(0);
    expect(db.dump('workflow_locks')[workflowLockId(DATE_ID, 'checkin')]).toMatchObject({ claimed_at: new Date('2026-09-19T18:11:00Z') });
    expect((db.dump('workflow_locks')[workflowLockId(DATE_ID, 'checkin')] as Record<string, unknown>).taken_over_from).toBeTypeOf('string');
  });

  it('the keyed row alone refuses a re-send even when the in-memory pre-check cannot see it', async () => {
    // A takeover whose scan of existing rows misses p01's row (simulated by a
    // row that is present under the dedupe id but with a status the pre-check
    // ignores): sendSms still refuses it, so the provider is called for the
    // other producer only.
    const db = seed(2);
    await db.collection('messages').doc(DEDUPE_KEYS.checkin_link(DATE_ID, 'p01')).set({
      direction: 'outbound', to: '+15015550101', from: 'console', body: 'x', provider: 'console', provider_message_id: null,
      status: 'failed', status_at: new Date(), error: 'earlier provider error', kind: 'checkin_link', segments: 1,
      producer_id: 'p01', market_date_id: DATE_ID, user_id: null, sent_by: null, created_at: new Date('2026-09-19T17:59:00Z'),
    });
    const r = await run(db, new Date('2026-09-19T18:00:00Z'));
    expect(r.errors).toEqual([]);
    expect(r.checkin_sent).toBe(1);
    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.producer_id === 'p01')!.status).toBe('failed'); // untouched — not re-sent, not re-marked
    expect(links.find((l) => l.producer_id === 'p02')!.status).toBe('simulated');
    expect(smsPrints()).toBe(1);
    const actions = (db.dump('market_dates')[DATE_ID]! as Record<string, unknown>).actions as Record<string, unknown>;
    expect(actions.checkin_failed).toBe(0); // a duplicate is skipped, not failed
  });
});

describe('(d) the staff resend is an intentional second text', () => {
  async function buildRoutes(db: Db) {
    const app = Fastify();
    app.decorate('db', db as never);
    app.decorate('env', env as never);
    await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
    await app.ready();
    return app;
  }

  it('after the engine\'s keyed text, a resend produces a second (uuid-keyed) row, and a third on repeat', async () => {
    const db = seed(2);
    await run(db, new Date('2026-09-19T18:00:00Z'));
    expect(rowsOfKind(db, 'checkin_link').filter((l) => l.producer_id === 'p01')).toHaveLength(1);

    const app = await buildRoutes(db);
    const headers = { authorization: `Bearer ${tokenFor('admin1')}` };
    const res = await app.inject({ method: 'POST', url: `/api/market-dates/${DATE_ID}/resend-checkin?producer_id=p01`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().sms.status).toBe('simulated');

    let p01 = rowsOfKind(db, 'checkin_link').filter((l) => l.producer_id === 'p01');
    expect(p01).toHaveLength(2);
    const ids = p01.map((l) => l.id);
    expect(ids).toContain(DEDUPE_KEYS.checkin_link(DATE_ID, 'p01'));
    const resendId = ids.find((id) => id !== DEDUPE_KEYS.checkin_link(DATE_ID, 'p01'))!;
    expect(resendId).toMatch(/^[0-9a-f-]{36}$/); // a fresh uuid, never a dedupe key
    expect(res.json().message_id).toBe(resendId);
    expect(p01.find((l) => l.id === resendId)!.sent_by).toBe('admin1');

    const again = await app.inject({ method: 'POST', url: `/api/market-dates/${DATE_ID}/resend-checkin?producer_id=p01`, headers });
    expect(again.statusCode).toBe(200);
    p01 = rowsOfKind(db, 'checkin_link').filter((l) => l.producer_id === 'p01');
    expect(p01).toHaveLength(3);
    expect(smsPrints()).toBe(4); // 2 engine + 2 resends

    // The engine still refuses its own duplicate afterwards.
    const r = await run(db, new Date('2026-09-19T18:01:00Z'));
    expect(r.checkin_sent).toBe(0);
    expect(rowsOfKind(db, 'checkin_link')).toHaveLength(4);
  });
});

describe('(e) sendSms with a dedupe_key', () => {
  const TO = '+15015550100';

  it('the second call throws DuplicateSendError before the provider; the console printed once', async () => {
    const db = fakeDb();
    const first = await sendSms({ env, db: asFirestore(db), to: TO, body: 'hello', kind: 'checkin_link', dedupe_key: 'checkin_link:d1:p1' });
    expect(first.message_id).toBe('checkin_link:d1:p1');
    expect(first.status).toBe('simulated');
    expect(db.dump('messages')['checkin_link:d1:p1']).toMatchObject({ status: 'simulated', kind: 'checkin_link', to: TO });

    let caught: unknown;
    try {
      await sendSms({ env, db: asFirestore(db), to: TO, body: 'hello again', kind: 'checkin_link', dedupe_key: 'checkin_link:d1:p1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateSendError);
    const dup = caught as DuplicateSendError;
    expect(dup.code).toBe('DUPLICATE_SEND');
    expect(dup.dedupe_key).toBe('checkin_link:d1:p1');
    expect(dup.existing_message_id).toBe('checkin_link:d1:p1');
    expect(smsPrints()).toBe(1);
    expect(db.count('messages')).toBe(1);
    expect(db.dump('messages')['checkin_link:d1:p1']!.body).toBe('hello'); // the winner's row is untouched
  });

  it('trySendSms maps it to { ok: false, duplicate: true } with the existing row id', async () => {
    const db = fakeDb();
    const first = await trySendSms({ env, db: asFirestore(db), to: TO, body: 'x', kind: 'deadline_summary', dedupe_key: 'k1' });
    expect(first.ok).toBe(true);
    const second = await trySendSms({ env, db: asFirestore(db), to: TO, body: 'x', kind: 'deadline_summary', dedupe_key: 'k1' });
    expect(second).toEqual({ ok: false, duplicate: true, message_id: 'k1', error: expect.stringContaining('Duplicate send suppressed') });
    expect(smsPrints()).toBe(1);
  });

  it('concurrent keyed sends: exactly one reaches the provider', async () => {
    const db = fakeDb();
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => sendSms({ env, db: asFirestore(db), to: TO, body: 'race', kind: 'checkin_link', dedupe_key: 'race-key' })),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected' && s.reason instanceof DuplicateSendError)).toHaveLength(4);
    expect(smsPrints()).toBe(1);
    expect(db.count('messages')).toBe(1);
  });

  it('a keyed send that failed at the provider still holds the key (the log row is the lock)', async () => {
    voipms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: sms_toolong');
    });
    const db = fakeDb();
    const first = await trySendSms({ env: production, db: asFirestore(db), to: TO, body: 'x', kind: 'checkin_link', dedupe_key: 'k-failed' });
    expect(first).toMatchObject({ ok: false, duplicate: false, message_id: 'k-failed' });
    expect(db.dump('messages')['k-failed']).toMatchObject({ status: 'failed' });
    voipms.mockImplementation(async () => 'vm-1');
    const retry = await trySendSms({ env: production, db: asFirestore(db), to: TO, body: 'x', kind: 'checkin_link', dedupe_key: 'k-failed' });
    expect(retry).toMatchObject({ ok: false, duplicate: true, message_id: 'k-failed' });
    expect(voipms).toHaveBeenCalledTimes(1); // the retry never reached voip.ms; a resend (no key) is the way to try again
  });

  it('without a dedupe_key behaviour is unchanged: uuid ids, set(), two rows for two calls', async () => {
    const db = fakeDb();
    const a = await sendSms({ env, db: asFirestore(db), to: TO, body: 'x', kind: 'otp' });
    const b = await sendSms({ env, db: asFirestore(db), to: TO, body: 'x', kind: 'otp' });
    expect(a.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.message_id).not.toBe(b.message_id);
    expect(db.count('messages')).toBe(2);
    expect(smsPrints()).toBe(2);
  });

  it('isAlreadyExists recognises the admin SDK error shapes and nothing else', () => {
    expect(isAlreadyExists(Object.assign(new Error('6 ALREADY_EXISTS: Document already exists: projects/x/databases/(default)/documents/messages/k'), { code: 6 }))).toBe(true);
    expect(isAlreadyExists({ code: 6, message: 'anything' })).toBe(true);
    expect(isAlreadyExists({ code: 'ALREADY_EXISTS' })).toBe(true);
    expect(isAlreadyExists(new Error('6 ALREADY_EXISTS: Document already exists'))).toBe(true);
    expect(isAlreadyExists(new Error('NOT_FOUND: messages/k'))).toBe(false);
    expect(isAlreadyExists({ code: 5, message: 'NOT_FOUND' })).toBe(false);
    expect(isAlreadyExists(null)).toBe(false);
    expect(isAlreadyExists('ALREADY_EXISTS')).toBe(false);
  });
});

describe('(f) fake-db DocumentReference.create()', () => {
  it('creates when absent, throws a GoogleError-shaped ALREADY_EXISTS when present, and leaves the original intact', async () => {
    const db = fakeDb();
    const ref = db.collection('messages').doc('k1');
    await ref.create({ a: 1 });
    expect(db.dump('messages').k1).toEqual({ a: 1 });

    let caught: unknown;
    try {
      await ref.create({ a: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code: number }).code).toBe(6);
    expect((caught as Error).message).toBe('6 ALREADY_EXISTS: Document already exists: messages/k1');
    expect(isAlreadyExists(caught)).toBe(true);
    expect(db.dump('messages').k1).toEqual({ a: 1 });

    // set() still overwrites; after delete() a create() succeeds again.
    await ref.set({ a: 3 });
    expect(db.dump('messages').k1).toEqual({ a: 3 });
    await ref.delete();
    await ref.create({ a: 4 });
    expect(db.dump('messages').k1).toEqual({ a: 4 });

    // A ref obtained from a query result creates against the same store.
    const viaQuery = (await db.collection('messages').where('a', '==', 4).get()).docs[0]!.ref;
    await expect(viaQuery.create({ a: 5 })).rejects.toMatchObject({ code: 6 });
  });

  it('is atomic under interleaving: of N concurrent creates exactly one succeeds', async () => {
    const db = fakeDb();
    const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => db.collection('workflow_locks').doc('d__checkin').create({ run: i })));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(9);
    expect(db.count('workflow_locks')).toBe(1);
  });

  it('reads hand back Timestamps for created dates, like every other read', async () => {
    const db = fakeDb();
    await db.collection('workflow_locks').doc('x').create({ claimed_at: new Date('2026-09-19T18:00:00Z') });
    const snap = await db.collection('workflow_locks').doc('x').get();
    expect(snap.exists).toBe(true);
    expect(typeof (snap.data()!.claimed_at as { toDate: () => Date }).toDate).toBe('function');
  });
});
