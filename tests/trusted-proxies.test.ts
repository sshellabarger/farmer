// Fix X1: `request.ip` is the first untrusted address from the right of
// X-Forwarded-For, never a value the caller wrote. Driven through the real
// buildApp() so the limiter key and the stored evidence address are the ones
// production uses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { T_OPEN, boot, seed, validSubmission } from './helpers/a1-fixtures.js';
import { GOOGLE_SERVICE_RANGES, LOOPBACK_RANGES, TRUSTED_PROXIES } from '../src/utils/trusted-proxies.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CLIENT = '198.51.100.9';
const xff = (value: string) => ({ 'x-forwarded-for': value });

const submit = (app: FastifyInstance, headers: Record<string, string>, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/applications', headers, payload: validSubmission(over) as never });

/** A bare Fastify instance with the production trust list; answers the address it resolved. */
async function echoApp() {
  const app = Fastify({ trustProxy: TRUSTED_PROXIES });
  app.get('/ip', async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}
const ipFor = async (app: FastifyInstance, header?: string) =>
  (await app.inject({ method: 'GET', url: '/ip', headers: header ? xff(header) : {} })).json().ip as string;

describe('the trust list', () => {
  it('is loopback plus the Google service ranges, and nothing broader', () => {
    expect(TRUSTED_PROXIES).toEqual([...LOOPBACK_RANGES, ...GOOGLE_SERVICE_RANGES]);
    expect(LOOPBACK_RANGES).toEqual(['127.0.0.0/8', '::1/128']);
    expect(GOOGLE_SERVICE_RANGES).toHaveLength(20);
    for (const range of TRUSTED_PROXIES) expect(range).toMatch(/^[0-9a-f:.]+\/\d{1,3}$/);
    expect(TRUSTED_PROXIES).not.toContain('0.0.0.0/0');
    expect(TRUSTED_PROXIES).not.toContain('::/0');
  });

  it('skips a proxy address from every observed Google range and from each listed range', async () => {
    const app = await echoApp();
    const samples = [
      // Observed in production on 2026-11-09.
      '66.249.80.1', '142.250.1.1', '74.125.20.5', '66.102.8.9', '192.178.10.2', '64.233.170.3',
      // One address inside each remaining range.
      '72.14.200.1', '108.177.15.1', '142.251.40.1', '172.217.4.1', '172.253.60.1', '173.194.70.1', '192.179.1.1',
      '209.85.200.1', '216.58.200.1', '216.239.40.1',
      '2001:4860:4860::8888', '2404:6800:4003::1', '2607:f8b0:4004:800::200e', '2800:3f0:4001::1', '2a00:1450:4001::1', '2c0f:fb50:4002::1',
    ];
    for (const proxy of samples) expect(await ipFor(app, `${CLIENT}, ${proxy}`)).toBe(CLIENT);
  });

  it('does not skip an address just outside the ranges', async () => {
    const app = await echoApp();
    for (const notGoogle of ['64.233.192.1', '66.249.96.1', '142.252.0.1', '192.180.0.1', '203.0.113.50', '2001:4861::1']) {
      expect(await ipFor(app, `${CLIENT}, ${notGoogle}`)).toBe(notGoogle);
    }
  });

  it('resolves both production paths to the true client', async () => {
    const app = await echoApp();
    // Direct to the function URL: "<whatever the client sent>, <client ip>".
    expect(await ipFor(app, `203.0.113.7, ${CLIENT}`)).toBe(CLIENT);
    expect(await ipFor(app, `142.250.1.1, ${CLIENT}`)).toBe(CLIENT); // a spoofed "Google" first hop changes nothing
    expect(await ipFor(app, `10.0.0.1, 127.0.0.1, ${CLIENT}`)).toBe(CLIENT);
    // Through Hosting: "<client ip>, <google proxy ip>".
    expect(await ipFor(app, `${CLIENT}, 142.250.1.1`)).toBe(CLIENT);
    expect(await ipFor(app, `${CLIENT}, 66.249.80.1, 74.125.20.5`)).toBe(CLIENT);
    // No header: the socket address, as before.
    expect(await ipFor(app)).toBe('127.0.0.1');
  });
});

describe('buildApp(): the stored evidence address', () => {
  it('direct path: a spoofed first hop is ignored; the consent, signature and application ip are the real client', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app, xff(`203.0.113.7, ${CLIENT}`));
    expect(res.statusCode).toBe(201);
    const doc = db.dump('applications')[res.json().id] as Record<string, any>;
    expect(doc.ip).toBe(CLIENT);
    expect(doc.sms_consent.ip).toBe(CLIENT);
    expect(doc.signature.ip).toBe(CLIENT);
    expect(JSON.stringify(doc)).not.toContain('203.0.113.7');
  });

  it('Hosting path: the Google proxy hop is skipped', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app, xff(`${CLIENT}, 142.250.1.1`));
    expect(res.statusCode).toBe(201);
    const doc = db.dump('applications')[res.json().id] as Record<string, any>;
    expect(doc.ip).toBe(CLIENT);
    expect(doc.sms_consent.ip).toBe(CLIENT);
    expect(doc.signature.ip).toBe(CLIENT);
  });

  it('no header: 127.0.0.1, unchanged', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app, {});
    expect((db.dump('applications')[res.json().id] as Record<string, any>).sms_consent.ip).toBe('127.0.0.1');
  });
});

describe('buildApp(): the rate limiter cannot be reset by rotating a spoofed first hop', () => {
  it('POST /api/applications: the sixth request from one real address is a 429 whatever it claims', async () => {
    const app = await boot(seed());
    const post = (i: number, client = CLIENT) =>
      app.inject({ method: 'POST', url: '/api/applications', headers: xff(`203.0.113.${i}, ${client}`), payload: {} });
    for (let i = 1; i <= 5; i += 1) expect((await post(i)).statusCode).toBe(400);
    expect((await post(6)).statusCode).toBe(429);
    expect((await post(7)).statusCode).toBe(429);
    // The bucket is the real address: a different client is not affected.
    expect((await post(8, '198.51.100.77')).statusCode).toBe(400);
  });

  it('POST /api/applications/uploads: the twenty-first request from one real address is a 429 whatever it claims', async () => {
    const app = await boot(seed());
    const post = (i: number, client = CLIENT) =>
      app.inject({ method: 'POST', url: '/api/applications/uploads', headers: xff(`203.0.113.${i}, ${client}`), payload: {} });
    for (let i = 1; i <= 20; i += 1) expect((await post(i)).statusCode).toBe(400);
    expect((await post(21)).statusCode).toBe(429);
    expect((await post(22, '198.51.100.77')).statusCode).toBe(400);
  });

  it('through Hosting, one client behind changing Google proxy addresses is one bucket', async () => {
    const app = await boot(seed());
    const proxies = ['66.249.80.1', '142.250.1.1', '74.125.20.5', '66.102.8.9', '192.178.10.2', '64.233.170.3'];
    const post = (proxy: string) => app.inject({ method: 'POST', url: '/api/applications', headers: xff(`${CLIENT}, ${proxy}`), payload: {} });
    for (const proxy of proxies.slice(0, 5)) expect((await post(proxy)).statusCode).toBe(400);
    expect((await post(proxies[5]!)).statusCode).toBe(429);
  });
});
