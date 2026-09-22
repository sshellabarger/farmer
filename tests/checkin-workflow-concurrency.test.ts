// Phase 3 fix — concurrency. The verifier's blocker: claim() was a
// read-then-write, so two genuinely concurrent processMarketDates runs (Cloud
// Scheduler every 5 min with a 300 s timeout, or a manual "run now" over a
// scheduled tick) both read the pre-claim state and both sent — 4 checkin_link
// rows for 2 recipients. The fix has two atomic layers:
//   1. workflow_locks/<date>__<step> created with DocumentReference.create()
//      (ALREADY_EXISTS for every run but one);
//   2. every engine send carries a dedupe_key that becomes the messages row id,
//      written with create() — the log row is the lock, so a duplicate can
//      never reach the provider.
// This file exercises the two primitives ((e) keyed sendSms, (f) the fake
// create()); the engine-level cases (a)–(d) follow in the engine commit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';
import { sendSms, trySendSms, DuplicateSendError, isAlreadyExists } from '../src/services/sms.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import type { Env } from '../src/config/env.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'vm-1') }));
const voipms = vi.mocked(voipmsSend);

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

type Db = ReturnType<typeof fakeDb>;
const asFirestore = (db: Db) => db as unknown as Firestore;

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
