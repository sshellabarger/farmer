// Regression: route-level Zod schema.parse() throws ZodError with no
// statusCode, which the global error handler used to map to a 500 — paging
// the prod alert channel for plain bad client input. The shared handler must
// return 400 with readable field messages and never call notifyError for them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import { createErrorHandler } from '../src/utils/http-error-handler.js';

vi.mock('../src/services/otp.js', () => ({
  sendOtp: vi.fn(async () => {}),
  verifyOtp: vi.fn(async () => true),
}));

const notifyError = vi.fn(async () => {});
vi.mock('../src/services/error-notify.js', () => ({
  notifyError: (...args: unknown[]) => notifyError(...args),
}));

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
          return { empty: true, docs: [] };
        },
        doc() {
          return { set: async () => {} };
        },
      };
    },
  };
}

async function buildApp() {
  const app = Fastify();
  const env = { NODE_ENV: 'test', JWT_SECRET: 'test-secret' } as never;
  app.decorate('db', fakeDb() as never);
  app.decorate('env', env);
  app.setErrorHandler(createErrorHandler({ env }));
  await app.register(authRoutes);
  app.get('/boom', async () => {
    throw new Error('kaboom');
  });
  await app.ready();
  return app;
}

describe('global error handler', () => {
  beforeEach(() => {
    notifyError.mockClear();
  });

  it('returns 400 (not 500) for an invalid signup body and does not alert', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: { name: 'No Contact Info', role: 'farmer' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTypeOf('string');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('includes the failing field path in the message', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: { name: 'Bad Role', phone: '+15015550100', role: 'astronaut' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('role');
  });

  it('still returns 500 and alerts for real server errors', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Internal server error');
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});
