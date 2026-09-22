// Phase 3 fix, round 2 — the adversary's minor: two concurrent successful
// POST /api/checkin/:token. upsertFormCheckin was read-then-set and
// markTokenUsed is read-modify-write, so `submissions` / `uses` could
// under-count. Neither has a double effect; the point here is that nothing is
// LOST: one checkins doc that counts both first submissions (create() decides
// who was first), the token intact with its other fields untouched, and the
// documented under-count of `uses` bounded to one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { checkinPublicRoutes } from '../src/routes/checkin-public.js';
import { createErrorHandler } from '../src/utils/http-error-handler.js';
import { fakeDb } from './helpers/fake-db.js';
import { mintCheckinToken } from '../src/services/link-tokens.js';
import { upsertFormCheckin } from '../src/services/checkins-submit.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { Env } from '../src/config/env.js';

const env = {
  NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

const NOW = new Date('2026-09-20T12:00:00Z');
const DATE_ID = 'wlrfm_2026-09-19';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function seedWlrfm() {
  return fakeDb({
    farmers_markets: {
      wlrfm: {
        id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' },
        timezone: 'America/Chicago', schedule: { versions: [], skipped_dates: [], special_dates: [] },
        workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS, active: true, created_by: 'test',
        created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
      },
    },
    market_dates: {
      [DATE_ID]: {
        market_id: 'wlrfm', date: '2026-09-19', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2026-09-19T13:00:00Z'), end_at: new Date('2026-09-19T17:00:00Z'),
        status: 'collecting', schedule_version: 'v1', special: false, note: '',
        actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: new Date('2026-09-01'), source: 'import', created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-01'),
      },
    },
    producers: { p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true } },
  });
}

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  app.setErrorHandler(createErrorHandler({ env, notify: false }));
  await app.register(checkinPublicRoutes, { prefix: '/api/checkin' });
  await app.ready();
  return app;
}

const FORM = { attending_next: true, bringing_next: 'tomatoes', sold_out: '', unsold: '', estimated_sales: '100', transactions_estimate: '', feedback: 'A' };

describe('two concurrent successful POST /api/checkin/:token', () => {
  it('one checkins doc counting both submissions, the token intact, uses under-counted by at most one', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: DATE_ID,
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    await db.collection('link_tokens').doc(token.token).update({ sent_message_id: 'checkin_link:x' });
    const app = await buildApp(db);

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: FORM }),
      app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: { ...FORM, feedback: 'B' } }),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);

    expect(db.count('checkins')).toBe(1);
    const stored = db.dump('checkins')[`${DATE_ID}_p1`]!;
    expect(stored.submissions).toBe(2); // the loser of create() counted on top of the winner rather than overwriting it as a first submission
    expect(stored.created_at).toEqual(NOW);
    expect(['A', 'B']).toContain(stored.feedback); // the later write's answers win — the form's "latest submission wins" rule
    expect(stored).toMatchObject({ source: 'form', partial: false, producer_id: 'p1', market_date_id: DATE_ID, token_id: token.token });
    expect(new Set([r1.json().checkin.submissions, r2.json().checkin.submissions])).toEqual(new Set([1, 2]));

    const tok = db.dump('link_tokens')[token.token]!;
    expect(tok.uses).toBeGreaterThanOrEqual(1); // read-modify-write: the documented under-count is at most one
    expect(tok.uses).toBeLessThanOrEqual(2);
    expect(tok.used_at).toEqual(NOW);
    expect(tok).toMatchObject({ producer_id: 'p1', market_date_id: DATE_ID, sent_message_id: 'checkin_link:x', max_uses: 25 }); // nothing else on the token was lost

    // A later, sequential submission counts on top of whatever landed.
    const r3 = await app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: { ...FORM, feedback: 'C' } });
    expect(r3.statusCode).toBe(200);
    expect(db.dump('checkins')[`${DATE_ID}_p1`]!.submissions).toBe(3);
    expect(db.dump('link_tokens')[token.token]!.uses).toBe((tok.uses as number) + 1);
    await app.close();
  });

  it('upsertFormCheckin: a concurrent first submission that loses create() keeps the winner\'s created_at and counts itself', async () => {
    const db = seedWlrfm();
    const args = (feedback: string, now: Date) => ({
      market_date_id: DATE_ID, market_id: 'wlrfm', producer_id: 'p1', token_id: 't',
      input: { ...FORM, feedback, extra_answers: {} }, now,
    });
    const [a, b] = await Promise.all([upsertFormCheckin(db as never, args('A', NOW)), upsertFormCheckin(db as never, args('B', new Date(NOW.getTime() + 1000)))]);
    expect([a.submissions, b.submissions].sort()).toEqual([1, 2]);
    expect(db.count('checkins')).toBe(1);
    const stored = db.dump('checkins')[`${DATE_ID}_p1`]!;
    expect(stored.submissions).toBe(2);
    expect(stored.created_at).toEqual(NOW); // the winner's, whichever landed second
    // Over an SMS-created partial doc the form still completes it (unchanged behaviour).
    const c = await upsertFormCheckin(db as never, args('C', new Date(NOW.getTime() + 2000)));
    expect(c.submissions).toBe(3);
    expect(c.partial).toBe(false);
  });
});
