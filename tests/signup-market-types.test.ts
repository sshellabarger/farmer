// Smoke test for POST /api/auth/signup market type validation.
// Regression: the web signup form offered food_hub / food_bank / food_pantry /
// school but the backend Zod enum rejected them (pilot-blocking for ALFN).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import { MARKET_TYPES } from '../src/types/schema.js';

vi.mock('../src/services/otp.js', () => ({
  sendOtp: vi.fn(async () => {}),
  verifyOtp: vi.fn(async () => true),
}));

interface FakeWrite {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

function fakeDb(writes: FakeWrite[]) {
  return {
    collection(name: string) {
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
        doc(id: string) {
          return {
            set: async (data: Record<string, unknown>) => {
              writes.push({ collection: name, id, data });
            },
          };
        },
      };
    },
  };
}

async function buildApp(writes: FakeWrite[]) {
  const app = Fastify();
  app.decorate('db', fakeDb(writes) as never);
  app.decorate('env', { NODE_ENV: 'test', JWT_SECRET: 'test-secret' } as never);
  await app.register(authRoutes);
  await app.ready();
  return app;
}

function signupPayload(marketType: string) {
  return {
    name: 'Smoke Test',
    email: 'smoke@example.com',
    phone: '+15015550100',
    role: 'market',
    businessName: 'Test Org',
    location: 'Little Rock, AR',
    marketType,
  };
}

describe('POST /signup market types', () => {
  let writes: FakeWrite[];

  beforeEach(() => {
    writes = [];
  });

  it.each([...MARKET_TYPES])('accepts market_type=%s and stores it on the market doc', async (type) => {
    const app = await buildApp(writes);
    const res = await app.inject({ method: 'POST', url: '/signup', payload: signupPayload(type) });

    expect(res.statusCode).toBe(201);
    expect(res.json().success).toBe(true);

    const marketWrite = writes.find((w) => w.collection === 'markets');
    expect(marketWrite).toBeDefined();
    expect(marketWrite!.data.type).toBe(type);
  });

  it('rejects an unknown market_type and writes nothing', async () => {
    const app = await buildApp(writes);
    const res = await app.inject({ method: 'POST', url: '/signup', payload: signupPayload('nightclub') });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(writes).toHaveLength(0);
  });
});
