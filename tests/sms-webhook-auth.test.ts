// voip.ms inbound webhook: shared-secret auth + the Phase 1 stopgap handler.
//
// Auth regression: /api/sms/voipms/inbound accepted unauthenticated payloads,
// letting anyone who found the URL spoof texts from any number. The Telnyx
// cases that used to live here were archived with the Telnyx channel
// (archive/v1-channels/).
//
// Stopgap (SPEC §7.4): every inbound is logged to `messages`; STOP/START/HELP
// are honoured; anything else gets one courtesy reply per 24 h, never a loop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { smsRoutes } from '../src/routes/sms.js';
import { REPLIES } from '../src/services/inbound.js';
import { fakeDb } from './helpers/fake-db.js';

const sendSms = vi.fn(async () => 'msg-id');

vi.mock('../src/services/sms.js', () => ({
  sendSms: (...args: unknown[]) => sendSms(...(args as [])),
}));
vi.mock('../src/services/error-notify.js', () => ({
  notifyError: vi.fn(async () => {}),
}));

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
  app.decorate('env', { NODE_ENV: 'production', JWT_SECRET: 'test-secret', APP_URL: 'http://test', VOIPMS_DID: DID, ...env } as never);
  await app.register(smsRoutes);
  await app.ready();
  return { app, db };
}

function inbound(message: string, from = '5015550100') {
  return `from=${from}&message=${encodeURIComponent(message)}&id=sms-${Math.random().toString(36).slice(2)}`;
}

/**
 * Make the first `failures` writes of an outbound row to `messages` throw,
 * simulating a Firestore blip between the provider send and the log write.
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
      const set = ref.set.bind(ref);
      ref.set = async (data, opts) => {
        if (data.direction === 'outbound' && remaining > 0) {
          remaining -= 1;
          throw new Error('UNAVAILABLE: simulated Firestore write failure');
        }
        return set(data, opts);
      };
      return ref;
    };
    return col;
  };
  return db;
}

beforeEach(() => {
  sendSms.mockClear();
  sendSms.mockImplementation(async () => 'msg-id');
});

describe('GET /voipms/inbound — shared secret', () => {
  it('accepts the configured shared secret and processes the message', async () => {
    const { app, db } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}&secret=hunter2` });

    expect(res.statusCode).toBe(200);
    const logged = Object.values(db.dump('messages'));
    expect(logged.some((m) => m.direction === 'inbound' && m.body === 'hello' && m.from === USER_PHONE)).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong secret', async () => {
    const { app, db } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}&secret=wrong` });

    expect(res.statusCode).toBe(403);
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('rejects a missing secret', async () => {
    const { app } = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(403);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('still accepts traffic when no secret is configured (pre-portal-change back-compat)', async () => {
    const { app } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('accepts the same payload as a form POST', async () => {
    const { app } = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/voipms/inbound',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: inbound('hello'),
    });

    expect(res.statusCode).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
});

describe('stopgap inbound handler', () => {
  it('STOP sets sms_opt_out_at on the matching user and confirms once', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('stop')}` });

    expect(res.statusCode).toBe(200);
    expect(db.dump('users').u1.sms_opt_out_at).toBeInstanceOf(Date);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0]).toMatchObject({ to: USER_PHONE, body: REPLIES.unsubscribed });

    const outbound = Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ to: USER_PHONE, from: DID, provider: 'voipms', provider_message_id: 'msg-id', status: 'sent', kind: 'opt_out_confirm' });
  });

  it('START clears sms_opt_out_at and confirms', async () => {
    const db = fakeDb({ users: { u1: { phone: USER_PHONE, sms_opt_out_at: new Date() } } });
    const { app } = await buildApp({}, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('START')}` });

    expect(res.statusCode).toBe(200);
    expect(db.dump('users').u1.sms_opt_out_at).toBeNull();
    expect(sendSms.mock.calls[0][0]).toMatchObject({ body: REPLIES.resubscribed });
  });

  it('HELP replies with the canned help text', async () => {
    const { app } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('Help')}` });

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0]).toMatchObject({ body: REPLIES.help });
  });

  it('unknown text gets the "service has closed" reply once', async () => {
    const { app } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('sold 10 lbs tomatoes')}` });

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0]).toMatchObject({ to: USER_PHONE, body: REPLIES.closed });
  });

  it('a second unknown text within 24 h does not get another reply', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('first')}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('second')}` });

    expect(sendSms).toHaveBeenCalledTimes(1);
    const inboundLogged = Object.values(db.dump('messages')).filter((m) => m.direction === 'inbound');
    expect(inboundLogged).toHaveLength(2);
  });

  it('replies again once the last reply is older than 24 h', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const db = seededDb({
      messages: { old: { direction: 'outbound', to: USER_PHONE, status: 'sent', kind: 'auto_reply', created_at: stale } },
    });
    const { app } = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello again')}` });

    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('an unknown number still gets STOP confirmation and the one-time reply', async () => {
    const { app, db } = await buildApp({});
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hi', '5015559999')}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('STOP', '5015559999')}` });

    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(Object.keys(db.dump('users'))).toEqual(['u1']);
  });

  it('never replies to an opted-out user except for keyword confirmations', async () => {
    const db = fakeDb({ users: { u1: { phone: USER_PHONE, sms_opt_out_at: new Date() } } });
    const { app } = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('anything')}` });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it('a send failure is logged as failed and never 500s the webhook', async () => {
    sendSms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: sms_toolong');
    });
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

    expect(res.statusCode).toBe(200);
    const outbound = Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ status: 'failed' });
  });

  it('a text that sent but whose first log write failed is recorded as sent and not re-sent within 24 h', async () => {
    const db = withFlakyOutboundLog(seededDb(), 1);
    const { app } = await buildApp({}, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('first')}` });

    expect(res.statusCode).toBe(200);
    const outbound = Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ status: 'sent', provider_message_id: 'msg-id', kind: 'auto_reply' });

    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('second')}` });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('a text that sent but could not be logged after a retry is never recorded as failed and still returns 200', async () => {
    const db = withFlakyOutboundLog(seededDb(), 2);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app } = await buildApp({}, db);
      const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello')}` });

      expect(res.statusCode).toBe(200);
      expect(sendSms).toHaveBeenCalledTimes(1);
      const outbound = Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
      expect(outbound).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0][0])).toContain('provider_message_id=msg-id');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores a callback with no from/message', async () => {
    const { app, db } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/voipms/inbound' });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });
});
