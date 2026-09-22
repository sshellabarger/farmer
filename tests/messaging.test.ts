// The single logged send (SPEC §7.2) and the structural test-mode guard
// (SPEC §7.3): a real provider is unreachable without NODE_ENV=production
// AND ALLOW_REAL_SENDS=true, every send writes exactly one `messages` row
// before the provider call, and voipms.js / resend are imported from exactly
// one module each.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../src/config/env.js';
import {
  sendSms,
  trySendSms,
  selectSmsProvider,
  splitMessage,
  SendsDisabledError,
  SmsSendError,
} from '../src/services/sms.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { fakeDb } from './helpers/fake-db.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'vm-1') }));
const voipms = vi.mocked(voipmsSend);

const base = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  VOIPMS_DID: '5015550999',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
  APP_URL: 'http://test',
} as unknown as Env;
const production = { ...base, SMS_PROVIDER: 'voipms', NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' } as Env;

const TO = '+15015550100';
// 80 five-character words: 400 GSM-7 chars, three 153-char segments.
const LONG_BODY = 'word '.repeat(80).trim();

type Db = ReturnType<typeof fakeDb>;
const asFirestore = (db: Db) => db as unknown as Firestore;
const rows = (db: Db) => Object.entries(db.dump('messages')).map(([id, m]) => ({ id, ...m }));

/**
 * Make the first `set` / `update` calls on `messages` doc refs throw,
 * simulating a Firestore blip before the send (set) or after it (update).
 */
function withFailingMessages(db: Db, failures: { set?: number; update?: number }) {
  const collection = db.collection.bind(db);
  let setLeft = failures.set ?? 0;
  let updateLeft = failures.update ?? 0;
  db.collection = (name: string) => {
    const col = collection(name);
    if (name !== 'messages') return col;
    const doc = col.doc.bind(col);
    col.doc = (id?: string) => {
      const ref = doc(id);
      const set = ref.set.bind(ref);
      const update = ref.update.bind(ref);
      ref.set = async (data, opts) => {
        if (setLeft > 0) {
          setLeft -= 1;
          throw new Error('UNAVAILABLE: simulated Firestore write failure');
        }
        return set(data, opts);
      };
      ref.update = async (data) => {
        if (updateLeft > 0) {
          updateLeft -= 1;
          throw new Error('UNAVAILABLE: simulated Firestore update failure');
        }
        return update(data);
      };
      return ref;
    };
    return col;
  };
  return db;
}

let consoleLog: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  voipms.mockClear();
  voipms.mockImplementation(async () => 'vm-1');
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleLog.mockRestore();
  consoleError.mockRestore();
});

describe('selectSmsProvider — the structural guard', () => {
  it('console is always allowed', () => {
    expect(selectSmsProvider(base)).toBe('console');
    expect(selectSmsProvider({ ...base, NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' })).toBe('console');
  });

  it('voipms needs production AND the flag', () => {
    expect(selectSmsProvider(production)).toBe('voipms');
    expect(() => selectSmsProvider({ ...production, NODE_ENV: 'development' })).toThrow(SendsDisabledError);
    expect(() => selectSmsProvider({ ...production, NODE_ENV: 'test' })).toThrow(SendsDisabledError);
    expect(() => selectSmsProvider({ ...production, ALLOW_REAL_SENDS: 'false' })).toThrow(SendsDisabledError);
  });

  it('SendsDisabledError carries the SENDS_DISABLED code and names the offending values', () => {
    let caught: unknown;
    try {
      selectSmsProvider({ ...production, NODE_ENV: 'development' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SendsDisabledError);
    expect((caught as SendsDisabledError).code).toBe('SENDS_DISABLED');
    expect((caught as Error).message).toContain('NODE_ENV=development');
  });
});

describe('sendSms — console provider', () => {
  it('writes one simulated row and returns status simulated', async () => {
    const db = fakeDb();
    const result = await sendSms({ env: base, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' });

    expect(result).toMatchObject({ provider: 'console', status: 'simulated', segments: 1 });
    expect(result.provider_message_id).toBe(`console-${result.message_id}`);

    const logged = rows(db);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      id: result.message_id,
      direction: 'outbound',
      to: TO,
      from: 'console',
      body: 'hello',
      provider: 'console',
      provider_message_id: `console-${result.message_id}`,
      status: 'simulated',
      error: null,
      kind: 'otp',
      segments: 1,
      producer_id: null,
      market_date_id: null,
      user_id: null,
      sent_by: null,
    });
    expect(logged[0].created_at).toBeInstanceOf(Date);
    expect(logged[0].status_at).toBeInstanceOf(Date);
    expect(voipms).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(String(consoleLog.mock.calls[0][0])).toContain('[sms:console]');
  });

  it('a 400-char body writes segments: 3 and logs once', async () => {
    expect(splitMessage(LONG_BODY)).toHaveLength(3);
    const db = fakeDb();
    const result = await sendSms({ env: base, db: asFirestore(db), to: TO, body: LONG_BODY, kind: 'broadcast' });

    expect(result.segments).toBe(3);
    expect(rows(db)[0]).toMatchObject({ segments: 3, body: LONG_BODY, status: 'simulated' });
    expect(consoleLog).toHaveBeenCalledTimes(1);
  });

  it('records the optional ids and extra keys, and extra can never clobber a core field', async () => {
    const db = fakeDb();
    const result = await sendSms({
      env: base,
      db: asFirestore(db),
      to: TO,
      body: 'hi',
      kind: 'broadcast',
      user_id: 'u1',
      sent_by: 'admin1',
      producer_id: 'p1',
      market_date_id: 'wlrfm_2026-04-18',
      extra: { broadcast_id: 'b1', status: 'sent', direction: 'inbound' },
    });
    expect(rows(db)[0]).toMatchObject({
      id: result.message_id,
      user_id: 'u1',
      sent_by: 'admin1',
      producer_id: 'p1',
      market_date_id: 'wlrfm_2026-04-18',
      broadcast_id: 'b1',
      status: 'simulated',
      direction: 'outbound',
    });
  });
});

describe('sendSms — a real provider is unreachable without the flag', () => {
  it('voipms in development with ALLOW_REAL_SENDS=true rejects before any I/O', async () => {
    const db = fakeDb();
    const env = { ...base, SMS_PROVIDER: 'voipms', NODE_ENV: 'development', ALLOW_REAL_SENDS: 'true' } as Env;
    await expect(sendSms({ env, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' })).rejects.toBeInstanceOf(SendsDisabledError);
    expect(voipms).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it('voipms in production with ALLOW_REAL_SENDS=false rejects before any I/O', async () => {
    const db = fakeDb();
    const env = { ...base, SMS_PROVIDER: 'voipms', NODE_ENV: 'production', ALLOW_REAL_SENDS: 'false' } as Env;
    await expect(sendSms({ env, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' })).rejects.toBeInstanceOf(SendsDisabledError);
    expect(voipms).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it('trySendSms turns SendsDisabledError into { ok: false, message_id: null }', async () => {
    const db = fakeDb();
    const env = { ...base, SMS_PROVIDER: 'voipms' } as Env;
    const result = await trySendSms({ env, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' });
    expect(result).toMatchObject({ ok: false, message_id: null });
    expect((result as { error: string }).error).toContain('ALLOW_REAL_SENDS');
    expect(rows(db)).toHaveLength(0);
  });

  it('only production + ALLOW_REAL_SENDS=true reaches voip.ms, once per segment, and writes a sent row', async () => {
    const db = fakeDb();
    const result = await sendSms({ env: production, db: asFirestore(db), to: TO, body: LONG_BODY, kind: 'reminder' });

    expect(voipms).toHaveBeenCalledTimes(3);
    expect(voipms.mock.calls[0][0]).toMatchObject({ to: TO });
    expect(result).toMatchObject({ provider: 'voipms', status: 'sent', provider_message_id: 'vm-1', segments: 3 });
    expect(rows(db)[0]).toMatchObject({
      provider: 'voipms',
      from: '5015550999',
      status: 'sent',
      provider_message_id: 'vm-1',
      segments: 3,
      kind: 'reminder',
      error: null,
    });
    expect(consoleLog).not.toHaveBeenCalled();
  });
});

describe('sendSms — failure paths', () => {
  it('a provider throw marks the row failed, sendSms rejects SmsSendError, trySendSms resolves ok:false', async () => {
    voipms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: sms_toolong');
    });
    const db = fakeDb();
    let caught: unknown;
    try {
      await sendSms({ env: production, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmsSendError);
    const failed = caught as SmsSendError;
    expect(failed.cause_message).toContain('sms_toolong');

    const logged = rows(db);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ id: failed.message_id, status: 'failed', provider_message_id: null });
    expect(String(logged[0].error)).toContain('sms_toolong');

    const attempt = await trySendSms({ env: production, db: asFirestore(db), to: TO, body: 'again', kind: 'otp' });
    expect(attempt.ok).toBe(false);
    expect((attempt as { message_id: string | null }).message_id).toBeTypeOf('string');
    expect((attempt as { error: string }).error).toContain('sms_toolong');
    expect(rows(db)).toHaveLength(2);
  });

  it('a pre-write Firestore failure sends nothing and rejects', async () => {
    const db = withFailingMessages(fakeDb(), { set: 1 });
    await expect(sendSms({ env: production, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' })).rejects.toThrow('UNAVAILABLE');
    expect(voipms).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);

    const console_ = withFailingMessages(fakeDb(), { set: 1 });
    await expect(sendSms({ env: base, db: asFirestore(console_), to: TO, body: 'hello', kind: 'otp' })).rejects.toThrow('UNAVAILABLE');
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('a post-send update that fails twice still resolves and reports the provider id once', async () => {
    const db = withFailingMessages(fakeDb(), { update: 2 });
    const result = await sendSms({ env: production, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' });

    expect(voipms).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'sent', provider_message_id: 'vm-1' });
    // The row exists from before the send and is never marked failed.
    expect(rows(db)[0]).toMatchObject({ id: result.message_id, status: 'queued', provider_message_id: null });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('provider_message_id=vm-1');
  });

  it('a post-send update that fails once is retried and the row ends up sent', async () => {
    const db = withFailingMessages(fakeDb(), { update: 1 });
    const result = await sendSms({ env: production, db: asFirestore(db), to: TO, body: 'hello', kind: 'otp' });
    expect(rows(db)[0]).toMatchObject({ id: result.message_id, status: 'sent', provider_message_id: 'vm-1' });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('structural guarantees', () => {
  const root = join(__dirname, '..');
  const srcDir = join(root, 'src');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = sourceFiles(srcDir).map((full) => ({
    path: relative(root, full),
    text: readFileSync(full, 'utf8'),
  }));

  it('only src/services/sms.ts imports voipms.js', () => {
    const importers = files.filter((f) => /from\s+['"][^'"]*voipms\.js['"]/.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(['src/services/sms.ts']);
  });

  it("only src/services/email.ts imports 'resend'", () => {
    const importers = files.filter((f) => /from\s+['"]resend['"]/.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(['src/services/email.ts']);
  });

  it('src/config/env.ts loads .env without override: true', () => {
    const envSource = files.find((f) => f.path === 'src/config/env.ts')!.text;
    expect(envSource).not.toContain('override: true');
    expect(envSource).toContain('dotenv.config()');
  });

  it('getEnv() defaults to the console providers with real sends off', async () => {
    const saved = {
      SMS_PROVIDER: process.env.SMS_PROVIDER,
      EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
      ALLOW_REAL_SENDS: process.env.ALLOW_REAL_SENDS,
    };
    try {
      delete process.env.SMS_PROVIDER;
      delete process.env.EMAIL_PROVIDER;
      delete process.env.ALLOW_REAL_SENDS;
      vi.resetModules();
      // A developer's .env must not take part in this test.
      vi.doMock('dotenv', () => ({ default: { config: vi.fn() } }));
      const { getEnv } = await import('../src/config/env.js');
      const env = getEnv();
      expect(env.SMS_PROVIDER).toBe('console');
      expect(env.EMAIL_PROVIDER).toBe('console');
      expect(env.ALLOW_REAL_SENDS).toBe('false');
    } finally {
      vi.doUnmock('dotenv');
      process.env.SMS_PROVIDER = saved.SMS_PROVIDER;
      process.env.EMAIL_PROVIDER = saved.EMAIL_PROVIDER;
      process.env.ALLOW_REAL_SENDS = saved.ALLOW_REAL_SENDS;
    }
  });
});
