// Webhook authentication for the SMS inbound routes.
// Regression: /api/sms/inbound (Telnyx) and /api/sms/voipms/inbound accepted
// unsigned payloads, letting anyone who found the URLs drive the AI engine
// (inventory updates, orders) as any registered user by spoofing "from".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { smsRoutes } from '../src/routes/sms.js';

const processInboundMessage = vi.fn(async () => 'AI reply');
const sendSms = vi.fn(async () => 'msg-id');

vi.mock('../src/services/conversation.js', () => ({
  processInboundMessage: (...args: unknown[]) => processInboundMessage(...(args as [])),
}));
vi.mock('../src/services/sms.js', () => ({
  sendSms: (...args: unknown[]) => sendSms(...(args as [])),
}));
vi.mock('../src/services/error-notify.js', () => ({
  notifyError: vi.fn(async () => {}),
}));

// Real ed25519 keypair so the route exercises the actual verification code.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
// Telnyx publishes the raw 32-byte key base64-encoded; strip the SPKI header.
const TELNYX_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

function signTelnyx(rawBody: string, timestamp: string): string {
  return crypto.sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64');
}

function telnyxPayload(from = '+15015550100') {
  return JSON.stringify({
    data: {
      event_type: 'message.received',
      id: 'evt-1',
      payload: {
        from: { phone_number: from },
        to: [{ phone_number: '+15015550999' }],
        text: 'sold 10 lbs tomatoes',
        id: 'msg-1',
      },
    },
  });
}

function fakeDb() {
  return {
    collection() {
      return {
        where() {
          return this;
        },
        limit() {
          return this;
        },
        async get() {
          return { empty: false, docs: [{ id: 'u1', data: () => ({ phone: '+15015550100' }) }] };
        },
      };
    },
  };
}

async function buildApp(env: Record<string, string>) {
  const app = Fastify();
  app.decorate('db', fakeDb() as never);
  app.decorate('env', { NODE_ENV: 'production', JWT_SECRET: 'test-secret', APP_URL: 'http://test', ...env } as never);
  await app.register(smsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  processInboundMessage.mockClear();
  sendSms.mockClear();
});

describe('POST /inbound (Telnyx)', () => {
  it('accepts a correctly signed webhook and processes the message', async () => {
    const app = await buildApp({ TELNYX_PUBLIC_KEY });
    const body = telnyxPayload();
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'telnyx-timestamp': timestamp,
        'telnyx-signature-ed25519': signTelnyx(body, timestamp),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered payload (signature over different bytes)', async () => {
    const app = await buildApp({ TELNYX_PUBLIC_KEY });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signTelnyx(telnyxPayload('+15015550100'), timestamp);

    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: telnyxPayload('+15015559999'),
      headers: {
        'content-type': 'application/json',
        'telnyx-timestamp': timestamp,
        'telnyx-signature-ed25519': signature,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects an unsigned webhook', async () => {
    const app = await buildApp({ TELNYX_PUBLIC_KEY });
    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: telnyxPayload(),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a replayed webhook with a stale timestamp', async () => {
    const app = await buildApp({ TELNYX_PUBLIC_KEY });
    const body = telnyxPayload();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);

    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'telnyx-timestamp': stale,
        'telnyx-signature-ed25519': signTelnyx(body, stale),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects everything in production when TELNYX_PUBLIC_KEY is not configured', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: telnyxPayload(),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('accepts unsigned webhooks in development when no key is configured', async () => {
    const app = await buildApp({ NODE_ENV: 'development' });
    const res = await app.inject({
      method: 'POST',
      url: '/inbound',
      payload: telnyxPayload(),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe('GET /voipms/inbound', () => {
  const QUERY = 'from=5015550100&message=hello&id=sms-1';

  it('accepts the configured shared secret and processes the message', async () => {
    const app = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${QUERY}&secret=hunter2` });

    expect(res.statusCode).toBe(200);
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong secret', async () => {
    const app = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${QUERY}&secret=wrong` });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a missing secret', async () => {
    const app = await buildApp({ VOIPMS_WEBHOOK_SECRET: 'hunter2' });
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${QUERY}` });

    expect(res.statusCode).toBe(403);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('still accepts traffic when no secret is configured (pre-portal-change back-compat)', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${QUERY}` });

    expect(res.statusCode).toBe(200);
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });
});
