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
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';
import { tokenFor } from './helpers/staff-auth.js';
import { processMarketDates, DEDUPE_KEYS, workflowLockId, CLAIM_TTL_MS } from '../src/services/checkin-workflow.js';
import { marketDateFromData } from '../src/services/market-dates.js';
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
 * Count the `market_dates` updates that TRANSITION a flag from unset to set.
 * Shape-agnostic: the round-2 engine writes field paths
 * (`'actions.checkin_sent_at'`), the round-1 engine rewrote the whole map
 * (`actions: {…}`); counting either lets one assertion prove a flag is set
 * exactly once against both. The value is deliberately not compared —
 * concurrent runs at the same tick all write the same `now`, so comparing
 * values would prove nothing.
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
          const written = data[`actions.${flag}`] ?? actions[flag];
          if (written && !prevActions[flag]) counts[flag]++;
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
  // The engine takes an injected `now`, but case (d) drives the real resend
  // route, which reads the clock and 409s (past_grace) after 2026-09-25;
  // case (h) drives the close route and sets its own time. Pinned so the
  // file does not go red on the real 2026-09-25.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-19T18:00:00Z'));
  voipms.mockClear();
  voipms.mockImplementation(async () => 'vm-1');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const smsPrints = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[sms:console]')).length;
const emailPrints = () => logSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[email:console]')).length;

/** The staff routes over the same fake db; rbac is mocked above the way every staff route test does it. */
async function buildRoutes(db: Db) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
  await app.ready();
  return app;
}

// ─── Interleaving helpers (round 2) ─────────────────────────────────────────
//
// A run is tagged through AsyncLocalStorage so a gate can single out ONE run's
// write while another run overlaps it — the fake db is in-memory and every
// await is a real suspension point, so this is a faithful interleave.

const runName = new AsyncLocalStorage<string>();
const namedRun = (name: string, db: Db, now: Date) => runName.run(name, () => run(db, now));

/**
 * True when a `market_dates` update carries the outcome of reminder offset
 * N — in either shape: the round-1 whole-map array (`actions.reminders_sent`
 * containing the offset) or the round-2 field path
 * (`actions.reminder_state.offset_<N>`). Shape-agnostic so the gated cases
 * below reproduce against the round-1 engine too.
 */
function carriesReminderOffset(data: Record<string, unknown>, offset: number): boolean {
  if (`actions.reminder_state.offset_${offset}` in data) return true;
  const actions = data.actions as { reminders_sent?: { offset_min: number }[] } | undefined;
  return Array.isArray(actions?.reminders_sent) && actions.reminders_sent.some((r) => r.offset_min === offset);
}

/**
 * Suspend the first `update()` on `collectionName` that `match` accepts until
 * `release()` is called; `reached` resolves the moment that write arrives.
 * Composes with the other wrappers in this file (each rebinds db.collection).
 */
function gateUpdate(db: Db, collectionName: string, match: (id: string, data: Record<string, unknown>) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let arrived!: () => void;
  const reached = new Promise<void>((r) => {
    arrived = r;
  });
  let armed = true;
  const collection = db.collection.bind(db);
  db.collection = (name: string) => {
    const col = collection(name);
    if (name !== collectionName) return col;
    const doc = col.doc.bind(col);
    col.doc = (id?: string) => {
      const ref = doc(id);
      const update = ref.update.bind(ref);
      ref.update = async (data) => {
        if (armed && match(ref.id, data)) {
          armed = false;
          arrived();
          await gate;
        }
        return update(data);
      };
      return ref;
    };
    return col;
  };
  return { reached, release };
}

/** What every reader (the status route, the web page, isDateDecided) sees: the derived, offset-sorted array. */
const remindersState = (db: Db) =>
  marketDateFromData(DATE_ID, db.dump('market_dates')[DATE_ID]! as Record<string, unknown>).actions.reminders_sent.map((r) => ({
    offset_min: r.offset_min,
    recipients: r.recipients,
    failed: r.failed,
    skipped: r.skipped,
  }));

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
    const remindersSent = remindersState(db); // derived from the per-offset reminder_state fields
    expect(remindersSent.map((r) => r.offset_min)).toEqual([1440, 2880]); // one entry per offset, not one per run
    expect(remindersSent.every((r) => r.recipients === 10 && r.failed === 0 && r.skipped === null)).toBe(true);
    expect(Object.keys(actions.reminder_state as Record<string, unknown>).sort()).toEqual(['offset_1440', 'offset_2880']); // the stored shape
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

// ─── Round 2: the adversary's engine-vs-engine and engine-vs-close findings ──
//
// Both findings share one root: every step's final write rewrote the WHOLE
// `actions` map from the snapshot taken in claim(). Two overlapping runs
// holding DIFFERENT step locks in the same tick (or the admin close, which
// takes no lock) each write a map that lacks the other's outcome, and the
// last writer drops it. Round 2 writes only the fields inside `actions`
// (Firestore dotted paths), so the writes commute.

describe('(g) two runs at a tick where reminder_1440 must be superseded and reminder_2880 sent', () => {
  const T_CHECKIN = new Date('2026-09-19T18:00:00Z');
  /** The engine missed the 1440 tick (an outage): both offsets are due together, only the latest is sent. */
  const T_BOTH_DUE = new Date('2026-09-21T17:00:00Z');
  /** A check-in sent after the 1440 slot (Sun 12:00 CDT): 1440 is superseded outright, 2880 is due a day later. */
  const T_LATE_CHECKIN = new Date('2026-09-20T18:00:00Z');

  /** Two recipients, the check-in text already sent (the 1440 slot untouched). */
  async function seedAfterCheckin(checkinSentAt: Date) {
    const db = seed(2);
    await db.collection('market_dates').doc(DATE_ID).update({
      'actions.checkin_sent_at': checkinSentAt,
      'actions.checkin_recipients': 2,
      'actions.checkin_failed': 0,
      'actions.claims.checkin': checkinSentAt,
    });
    await db.collection('workflow_locks').doc(workflowLockId(DATE_ID, 'checkin')).set({ market_date_id: DATE_ID, key: 'checkin', claimed_at: checkinSentAt, run_id: 'earlier', created_at: checkinSentAt });
    return db;
  }

  const SETTLED = [
    { offset_min: 1440, recipients: 0, failed: 0, skipped: 'superseded' },
    { offset_min: 2880, recipients: 2, failed: 0, skipped: null },
  ];

  /** Both outcomes recorded, one reminder text per producer, and the ticks that follow — inside and past the lock TTL — send nothing more. */
  async function expectSettled(db: Db, tick: Date) {
    expect(remindersState(db)).toEqual(SETTLED);
    for (const later of [new Date(tick.getTime() + 5 * 60_000), new Date(tick.getTime() + CLAIM_TTL_MS + 60_000)]) {
      const r = await run(db, later);
      expect(r.errors).toEqual([]);
      expect(r.reminders_sent).toBe(0);
    }
    const reminders = rowsOfKind(db, 'checkin_reminder');
    expect(reminders.map((r) => [r.producer_id, r.offset_min]).sort()).toEqual([
      ['p01', 2880],
      ['p02', 2880],
    ]);
    expect(smsPrints()).toBe(2);
    expect(remindersState(db)).toEqual(SETTLED);
    expect(Object.keys(db.dump('workflow_locks')).sort()).toEqual(['checkin', 'reminder_1440', 'reminder_2880'].map((k) => workflowLockId(DATE_ID, k)).sort());
  }

  it('run concurrently (Promise.all): both outcomes survive and no tick afterwards sends more', async () => {
    const db = await seedAfterCheckin(T_CHECKIN);
    const results = await Promise.all([namedRun('A', db, T_BOTH_DUE), namedRun('B', db, T_BOTH_DUE)]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.map((r) => r.reminders_sent).sort()).toEqual([0, 2]);
    expect(results.reduce((n, r) => n + r.skipped_claimed, 0)).toBeGreaterThanOrEqual(1); // the loser of a reminder lock is counted
    await expectSettled(db, T_BOTH_DUE);
  });

  it('gated: run A held between its reminder_1440 claim and its final write while run B completes the 2880 send', async () => {
    const db = await seedAfterCheckin(T_CHECKIN);
    const holdA = gateUpdate(db, 'market_dates', (id, data) => id === DATE_ID && runName.getStore() === 'A' && carriesReminderOffset(data, 1440));

    const a = namedRun('A', db, T_BOTH_DUE);
    await holdA.reached; // A owns the reminder_1440 lock and is about to record "superseded"
    const rb = await namedRun('B', db, T_BOTH_DUE); // B: 1440 is claimed → skip; 2880 is free → send to both
    expect(rb.reminders_sent).toBe(2);
    expect(rb.skipped_claimed).toBe(1);
    expect(remindersState(db).map((r) => r.offset_min)).toEqual([2880]);

    holdA.release();
    const ra = await a; // A's write lands AFTER B's; then A finds reminder_2880 already DONE (B finished it before A got there — done, not claimed)
    expect(ra.errors).toEqual([]);
    expect(ra.reminders_sent).toBe(0);
    expect(ra.skipped_claimed).toBe(0);
    await expectSettled(db, T_BOTH_DUE);
  });

  it('gated the other way: the 2880 sender writes last from a snapshot taken before the supersede landed', async () => {
    // The write order that loses the supersede decision: A's "superseded"
    // lands, then B's final write (from B's claim-time snapshot, which
    // predates A's write) lands on top of it. Round 1 then re-sent
    // reminder_1440 on the first tick past the lock TTL.
    const db = await seedAfterCheckin(T_CHECKIN);
    const holdA = gateUpdate(db, 'market_dates', (id, data) => id === DATE_ID && runName.getStore() === 'A' && carriesReminderOffset(data, 1440));
    const holdB = gateUpdate(db, 'market_dates', (id, data) => id === DATE_ID && runName.getStore() === 'B' && carriesReminderOffset(data, 2880));

    const a = namedRun('A', db, T_BOTH_DUE);
    await holdA.reached; // A holds reminder_1440, its "superseded" write is pending
    const b = namedRun('B', db, T_BOTH_DUE);
    await holdB.reached; // B skipped 1440 (claimed), claimed 2880, texted both producers; its final write is pending
    expect(rowsOfKind(db, 'checkin_reminder')).toHaveLength(2);

    holdA.release();
    const ra = await a; // A records "superseded", then finds 2880 claimed (B's lock is live, its write still pending)
    expect(ra.reminders_sent).toBe(0);
    expect(ra.skipped_claimed).toBe(1); // the loser of a reminder lock is counted (round 2)
    expect(remindersState(db).map((r) => r.offset_min)).toEqual([1440]);

    holdB.release();
    const rb = await b; // B's write lands last
    expect(rb.reminders_sent).toBe(2);
    await expectSettled(db, T_BOTH_DUE);
  });

  it('late check-in (checkin_sent_at after the 1440 slot), same two-gate interleave: both entries survive', async () => {
    const db = await seedAfterCheckin(T_LATE_CHECKIN);
    const holdA = gateUpdate(db, 'market_dates', (id, data) => id === DATE_ID && runName.getStore() === 'A' && carriesReminderOffset(data, 1440));
    const holdB = gateUpdate(db, 'market_dates', (id, data) => id === DATE_ID && runName.getStore() === 'B' && carriesReminderOffset(data, 2880));

    const a = namedRun('A', db, T_BOTH_DUE);
    await holdA.reached;
    const b = namedRun('B', db, T_BOTH_DUE);
    await holdB.reached;
    holdA.release();
    await a;
    holdB.release();
    await b;
    await expectSettled(db, T_BOTH_DUE);
  });
});

describe('(h) an admin close {notify:true} issued while the engine is mid check-in loop', () => {
  it('both sets of flags survive, exactly one summary email, and the scheduled deadline tick sends nothing more', async () => {
    const T_CHECKIN = new Date('2026-09-19T18:00:00Z');
    const T_DEADLINE = new Date('2026-09-22T17:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] }); // the close route reads the real clock
    vi.setSystemTime(T_CHECKIN);
    const db = seed(3);
    const app = await buildRoutes(db);
    const headers = { authorization: `Bearer ${tokenFor('admin1')}` };

    // Hold the engine after its 2nd send: the post-send link_tokens.update({ sent_message_id }) is the 2nd such write.
    let tokenUpdates = 0;
    const midLoop = gateUpdate(db, 'link_tokens', () => ++tokenUpdates === 2);
    const engine = run(db, T_CHECKIN);
    await midLoop.reached;
    expect(rowsOfKind(db, 'checkin_link')).toHaveLength(2);

    const close = await app.inject({ method: 'POST', url: `/api/market-dates/${DATE_ID}/close`, headers, payload: { notify: true } });
    expect(close.statusCode).toBe(200);
    expect(close.json().result).toMatchObject({ recipients: 3, responded: 0, non_responders: ['p01', 'p02', 'p03'], summary: 'sent' });
    expect(rowsOfKind(db, 'deadline_summary').map((s) => s.user_id).sort()).toEqual(['admin1', 'mgr_w']);
    expect(emailPrints()).toBe(1);

    midLoop.release();
    const r1 = await engine;
    expect(r1.errors).toEqual([]);
    expect(r1.checkin_sent).toBe(3);
    expect(rowsOfKind(db, 'checkin_link')).toHaveLength(3);

    const date = db.dump('market_dates')[DATE_ID]! as Record<string, unknown>;
    const actions = date.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(T_CHECKIN);
    expect(actions.checkin_recipients).toBe(3);
    expect(actions.deadline_processed_at).toEqual(T_CHECKIN); // the close's flags survive the engine's final write
    expect(actions.summary_sent_at).toEqual(T_CHECKIN);
    expect(date.non_responders).toEqual(['p01', 'p02', 'p03']);
    expect(emailPrints()).toBe(1);

    // The scheduled deadline tick afterwards: nothing left to do, no second summary, no second email.
    vi.setSystemTime(T_DEADLINE);
    const r2 = await run(db, T_DEADLINE);
    expect(r2).toMatchObject({ deadlines_processed: 0, summaries_sent: 0, errors: [] });
    expect(emailPrints()).toBe(1);
    expect(rowsOfKind(db, 'deadline_summary')).toHaveLength(2);
    expect(db.count('messages')).toBe(5); // 3 links + 2 summaries
    await app.close();
  });
});
