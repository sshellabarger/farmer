// Phase 3 contract §5.3 / §7.2: voip.ms has no outbound delivery-receipt
// callback, so POST /api/sms/status is a documented no-op. It must accept
// any body, write nothing to `messages`, and always return a fixed shape.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { smsRoutes } from '../src/routes/sms.js';
import { fakeDb } from './helpers/fake-db.js';

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  await app.register(formbody);
  app.decorate('db', db as never);
  app.decorate('env', { NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false' } as never);
  await app.register(smsRoutes);
  await app.ready();
  return app;
}

describe('POST /status — delivery-status no-op (contract §5.3)', () => {
  it('an empty body returns the fixed shape and writes nothing', async () => {
    const db = fakeDb();
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/status', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: false });
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });

  it('a JSON delivery-report-shaped body still writes nothing', async () => {
    const db = fakeDb();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/status',
      payload: { sms: 12345, status: 'delivered', to: '+15015550100', done_date: '2026-09-21 10:00:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: false });
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });

  it('a form-encoded body is accepted the same way', async () => {
    const db = fakeDb();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'sms=12345&status=delivered',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: false });
    expect(Object.keys(db.dump('messages'))).toHaveLength(0);
  });

  it('a seeded sent row is left untouched — status stays terminal at sent', async () => {
    const db = fakeDb({
      messages: { m1: { direction: 'outbound', status: 'sent', provider: 'voipms', provider_message_id: '12345', to: '+15015550100' } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/status',
      payload: { sms: 12345, status: 'delivered' },
    });

    expect(res.statusCode).toBe(200);
    expect(db.dump('messages').m1.status).toBe('sent');
  });
});
