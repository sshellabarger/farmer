// voip.ms inbound webhook: shared-secret auth + the Phase 1 stopgap handler.
//
// Auth regression: /api/sms/voipms/inbound accepted unauthenticated payloads,
// letting anyone who found the URL spoof texts from any number. The Telnyx
// cases that used to live here were archived with the Telnyx channel
// (archive/v1-channels/).
//
// Stopgap (SPEC §7.4): every inbound is logged to `messages`; STOP/START/HELP
// are honoured; anything else gets one courtesy reply per 24 h, never a loop.
//
// Replies go out through `trySendSms` (SPEC §7.2/§7.3): under the console
// env of these tests each reply is a `simulated` row in `messages`; the
// provider-failure and flaky-log cases point the real path at a mocked
// voipms.js with a production env.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { smsRoutes } from '../src/routes/sms.js';
import { REPLIES } from '../src/services/inbound.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { fakeDb } from './helpers/fake-db.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'msg-id') }));
vi.mock('../src/services/error-notify.js', () => ({
  notifyError: vi.fn(async () => {}),
}));
const voipms = vi.mocked(voipmsSend);

const USER_PHONE = '+15015550100';
const DID = '5015550999';

function seededDb(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  return fakeDb({
    users: { u1: { phone: USER_PHONE, name: 'Test User', role: 'farmer' } },
    ...extra,
  });
}

async function buildApp(env: Record<string, string>, db = seededDb()) {
  const app = Fastify();
  // voip.ms POSTs application/x-www-form-urlencoded; buildApp() registers this in prod.
  await app.register(formbody);
  app.decorate('db', db as never);
  app.decorate('env', {
    NODE_ENV: 'production',
    SMS_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    ALLOW_REAL_SENDS: 'false',
    JWT_SECRET: 'test-secret',
    APP_URL: 'http://test',
    VOIPMS_DID: DID,
    ...env,
  } as never);
  await app.register(smsRoutes);
  await app.ready();
  return { app, db };
}

// The real provider path: production env + the flag, against the mock.
const REAL = { SMS_PROVIDER: 'voipms', ALLOW_REAL_SENDS: 'true' };

function inbound(message: string, from = '5015550100') {
  return `from=${from}&message=${encodeURIComponent(message)}&id=sms-${Math.random().toString(36).slice(2)}`;
}

const outbound = (db: ReturnType<typeof fakeDb>) => Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
const inboundRows = (db: ReturnType<typeof fakeDb>) => Object.values(db.dump('messages')).filter((m) => m.direction === 'inbound');

/**
 * Make the first `failures` post-send status updates of an outbound row in
 * `messages` throw, simulating a Firestore blip between the provider send
 * and the log update. (The row itself is written before the send.)
 */
function withFlakyOutboundLog(db: ReturnType<typeof fakeDb>, failures: number) {
  const collection = db.collection.bind(db);
  let remaining = failures;
  db.collection = (name: string) => {
    const col = collection(name);
    if (name !== 'messages') return col;
    const doc = col.doc.bind(col);
    col.doc = (id?: string) => {
      const ref = doc(id);
      const update = ref.update.bind(ref);
      ref.update = async (data) => {
        if (remaining > 0) {
          remaining -= 1;
          throw new Error('UNAVAILABLE: simulated Firestore write failure');
        }
        return update(data);
      };
      return ref;
    };
    return col;
  };
  return db;
}

beforeEach(() => {
  voipms.mockClear();
  voipms.mockImplementation(async () => 'msg-id');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /voipms/inbound — shared secret', () => {
  it('accepts the configured shared secret and processes the message', async () => {
    const { app, db } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}&secret=hunter2` });

    expect(res.statusCode).toBe(200);
    const logged = inboundRows(db);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ body: 'hello', from: USER_PHONE, to: DID, status: 'received', kind: 'inbound', segments: 1 });
    expect(logged[0].status_at).toBeInstanceOf(Date);
    expect(outbound(db)).toHaveLength(1);
  });

  it('rejects a wrong secret', async () => {
    const { app, db } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}&secret=wrong` });

    expect(res.statusCode).toBe(403);
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });

  it('rejects a missing secret', async () => {
    const { app, db } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(403);
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });

  it('still accepts traffic when no secret is configured (pre-portal-change back-compat)', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(outbound(db)).toHaveLength(1);
  });

  it('accepts the same payload as a form POST', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/voipms/inbound',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: inbound('hello'),
    });

    expect(res.statusCode).toBe(200);
    expect(outbound(db)).toHaveLength(1);
  });
});

describe('stopgap inbound handler', () => {
  it('STOP sets sms_opt_out_at on the matching user and confirms once', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('stop')}` });

    expect(res.statusCode).toBe(200);
    expect(db.dump('users').u1.sms_opt_out_at).toBeInstanceOf(Date);

    const replies = outbound(db);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      to: USER_PHONE,
      from: 'console',
      body: REPLIES.unsubscribed,
      provider: 'console',
      status: 'simulated',
      kind: 'opt_out_confirm',
      segments: 1,
      user_id: 'u1',
    });
    expect(String(replies[0].provider_message_id)).toMatch(/^console-/);
    expect(voipms).not.toHaveBeenCalled();
  });

  it('START clears sms_opt_out_at and confirms', async () => {
    const db = fakeDb({ users: { u1: { phone: USER_PHONE, sms_opt_out_at: new Date() } } });
    const { app } = await buildApp({}, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('START')}` });

    expect(res.statusCode).toBe(200);
    expect(db.dump('users').u1.sms_opt_out_at).toBeNull();
    expect(outbound(db)[0]).toMatchObject({ body: REPLIES.resubscribed, kind: 'opt_in_confirm', status: 'simulated' });
  });

  it('HELP replies with the canned help text', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('Help')}` });

    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ body: REPLIES.help, kind: 'help' });
  });

  it('unknown text gets the "service has closed" reply once', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('sold 10 lbs tomatoes')}` });

    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ to: USER_PHONE, body: REPLIES.closed, kind: 'auto_reply' });
  });

  it('a second unknown text within 24 h does not get another reply', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('first')}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('second')}` });

    expect(outbound(db)).toHaveLength(1);
    expect(inboundRows(db)).toHaveLength(2);
  });

  it('a recent simulated reply counts the same as a sent one for the 24 h rule', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const db = seededDb({
      messages: { prev: { direction: 'outbound', to: USER_PHONE, status: 'simulated', kind: 'auto_reply', created_at: recent } },
    });
    const { app } = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello again')}` });

    expect(outbound(db)).toHaveLength(1); // only the seeded row
  });

  it('replies again once the last reply is older than 24 h', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const db = seededDb({
      messages: { old: { direction: 'outbound', to: USER_PHONE, status: 'sent', kind: 'auto_reply', created_at: stale } },
    });
    const { app } = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello again')}` });

    expect(outbound(db)).toHaveLength(2);
    expect(outbound(db).filter((m) => m.status === 'simulated')).toHaveLength(1);
  });

  it('an unknown number still gets STOP confirmation and the one-time reply', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hi', '5015559999')}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('STOP', '5015559999')}` });

    expect(outbound(db)).toHaveLength(2);
    expect(outbound(db).map((m) => m.kind).sort()).toEqual(['auto_reply', 'opt_out_confirm']);
    expect(outbound(db).every((m) => m.user_id === null)).toBe(true);
    expect(Object.keys(db.dump('users'))).toEqual(['u1']);
  });

  it('never replies to an opted-out user except for keyword confirmations', async () => {
    const db = fakeDb({ users: { u1: { phone: USER_PHONE, sms_opt_out_at: new Date() } } });
    const { app } = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('anything')}` });

    expect(outbound(db)).toHaveLength(0);
  });

  it('the real provider path reaches voip.ms only with production + ALLOW_REAL_SENDS=true', async () => {
    const { app, db } = await buildApp(REAL);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(voipms).toHaveBeenCalledTimes(1);
    expect(voipms.mock.calls[0][0]).toMatchObject({ to: USER_PHONE, body: REPLIES.closed });
    expect(outbound(db)[0]).toMatchObject({ from: DID, provider: 'voipms', provider_message_id: 'msg-id', status: 'sent', kind: 'auto_reply' });
  });

  it('a real provider without the flag never sends, logs nothing outbound and still returns 200', async () => {
    const { app, db } = await buildApp({ SMS_PROVIDER: 'voipms' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(voipms).not.toHaveBeenCalled();
    expect(inboundRows(db)).toHaveLength(1);
    expect(outbound(db)).toHaveLength(0);
  });

  it('a send failure is logged as failed and never 500s the webhook', async () => {
    voipms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: sms_toolong');
    });
    const { app, db } = await buildApp(REAL);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ status: 'failed', provider: 'voipms', provider_message_id: null });
    expect(String(outbound(db)[0].error)).toContain('sms_toolong');
  });

  it('a text that sent but whose first status update failed is recorded as sent and not re-sent within 24 h', async () => {
    const db = withFlakyOutboundLog(seededDb(), 1);
    const { app } = await buildApp(REAL, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('first')}` });

    expect(res.statusCode).toBe(200);
    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ status: 'sent', provider_message_id: 'msg-id', kind: 'auto_reply' });

    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('second')}` });
    expect(voipms).toHaveBeenCalledTimes(1);
    expect(outbound(db)).toHaveLength(1);
  });

  it('a text that sent but could not be marked after a retry is never recorded as failed and still returns 200', async () => {
    const db = withFlakyOutboundLog(seededDb(), 2);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = await buildApp(REAL, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(voipms).toHaveBeenCalledTimes(1);
    // The queued row from before the send is all that remains: never 'failed'.
    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ status: 'queued', provider_message_id: null, kind: 'auto_reply' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('provider_message_id=msg-id');
  });

  it('ignores a callback with no from/message', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/voipms/inbound' });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });
});
