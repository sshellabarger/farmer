import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';

/**
 * A2's route modules (producers/memberships/applications/checkins) don't
 * exist on this branch — src/app.ts imports them behind @ts-ignore per the
 * Phase 2 contract. Importing src/app.js here would fail module resolution
 * before any test body runs, so the whole suite (not just the test) is
 * gated on their presence; it self-skips until they land (after the merge)
 * and then catches duplicate routes / boot failures across the full app.
 */
const a2ModulesExist = existsSync('src/routes/producers.ts');

describe.skipIf(!a2ModulesExist)('app boot', () => {
  it('builds and responds 200 on /api/health', async () => {
    const { buildApp } = await import('../src/app.js');
    const env = {
      JWT_SECRET: 'test-secret',
      NODE_ENV: 'test',
      APP_URL: 'http://test',
      ANTHROPIC_API_KEY: 'test',
      VOIPMS_WEBHOOK_SECRET: '',
    } as never;
    const app = await buildApp({ db: fakeDb() as never, env, notifyOnError: false });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
