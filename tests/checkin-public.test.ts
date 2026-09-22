import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { checkinPublicRoutes } from '../src/routes/checkin-public.js';
import { createErrorHandler } from '../src/utils/http-error-handler.js';
import { fakeDb } from './helpers/fake-db.js';
import { mintCheckinToken, generateToken } from '../src/services/link-tokens.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { Env } from '../src/config/env.js';

const env = {
  NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

// The routes read the real clock and every valid fixture token below expires
// on 2026-09-25T17:00Z (deadline 09-22 + 3 days' grace): pin the clock inside
// that window so the suite does not go red on the real 2026-09-25.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function buildApp(db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  app.setErrorHandler(createErrorHandler({ env, notify: false }));
  await app.register(checkinPublicRoutes, { prefix: '/api/checkin' });
  await app.ready();
  return app;
}

function seedWlrfm(extraDate: Record<string, unknown> = {}) {
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
      'wlrfm_2026-09-19': {
        market_id: 'wlrfm', date: '2026-09-19', start_time: '08:00', end_time: '12:00',
        start_at: new Date('2026-09-19T13:00:00Z'), end_at: new Date('2026-09-19T17:00:00Z'),
        status: 'collecting', schedule_version: 'v1', special: false, note: '',
        actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
        extra_questions: [
          { key: 'booth_size', prompt: 'Booth size?', type: 'choice', options: ['10x10', '10x20'] },
        ],
        sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
        generated_at: new Date('2026-09-01'), source: 'import', created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-01'),
        ...extraDate,
      },
    },
    producers: {
      p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
    },
  });
}

describe('GET /api/checkin/:token', () => {
  it('404s on an unknown token and on a malformed one', async () => {
    const db = seedWlrfm();
    const app = await buildApp(db);
    const r1 = await app.inject({ method: 'GET', url: `/api/checkin/${generateToken()}` });
    expect(r1.statusCode).toBe(404);
    expect(r1.json()).toEqual({ error: 'Unknown link' });

    const r2 = await app.inject({ method: 'GET', url: '/api/checkin/abc' });
    expect(r2.statusCode).toBe(404);
  });

  it('410s on an expired token', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-01T00:00:00Z'), now: new Date('2026-08-01T00:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: `/api/checkin/${token.token}` });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'This link has expired' });
  });

  it('200s on a valid token with the expected shape', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: `/api/checkin/${token.token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.producer_name).toBe('Acme Farm');
    expect(body.market_name).toBe('West Little Rock Farmers Market');
    expect(body.date_label).toBe('Saturday, Sep 19, 2026');
    expect(body.deadline_label).toBe('Tue Sep 22, 12:00 PM');
    expect(body.questions.extra_questions).toHaveLength(1);
    expect(body.existing).toBeNull();
    expect(body.token).toBeUndefined();
    expect(body.jwt).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /api/checkin/:token', () => {
  it('writes the full shape, resubmission overwrites, and returns the current values', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);

    const body1 = {
      attending_next: true, bringing_next: 'tomatoes, eggs', sold_out: 'peppers', unsold: '',
      estimated_sales: '500-1000', transactions_estimate: '29 cards, 5 Cash App', feedback: 'great day',
      extra_answers: { booth_size: '10x10' },
    };
    const res1 = await app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: body1 });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().checkin.submissions).toBe(1);

    const stored1 = db.dump('checkins')['wlrfm_2026-09-19_p1']!;
    expect(stored1.source).toBe('form');
    expect(stored1.token_id).toBe(token.token);
    expect(stored1.estimated_sales).toEqual({ value: 750, raw: '500-1000', kind: 'range' });
    expect((stored1.flags as string[])).toContain('transactions_ambiguous');
    expect(stored1.sold_out_items).toEqual(['peppers']);
    expect(stored1.attending_next).toBe(true);
    expect(stored1.extra_answers).toEqual({ booth_size: '10x10' });
    expect(stored1.submissions).toBe(1);
    expect(stored1.partial).toBe(false);

    const tokenAfter1 = db.dump('link_tokens')[token.token]!;
    expect(tokenAfter1.uses).toBe(1);

    const res2 = await app.inject({
      method: 'POST', url: `/api/checkin/${token.token}`,
      payload: { ...body1, attending_next: false, estimated_sales: '2000' },
    });
    expect(res2.statusCode).toBe(200);
    const stored2 = db.dump('checkins')['wlrfm_2026-09-19_p1']!;
    expect(stored2.submissions).toBe(2);
    expect(stored2.created_at).toEqual(stored1.created_at);
    expect(stored2.attending_next).toBe(false);
    const tokenAfter2 = db.dump('link_tokens')[token.token]!;
    expect(tokenAfter2.uses).toBe(2);

    const getRes = await app.inject({ method: 'GET', url: `/api/checkin/${token.token}` });
    expect(getRes.json().existing.attending_next).toBe(false);
  });

  it('400s on an unknown extra key and a choice value outside its options', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);
    const base = { attending_next: true, bringing_next: '', sold_out: '', unsold: '', estimated_sales: '', transactions_estimate: '', feedback: '' };

    const r1 = await app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: { ...base, extra_answers: { bogus: 'x' } } });
    expect(r1.statusCode).toBe(400);

    const r2 = await app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: { ...base, extra_answers: { booth_size: '20x20' } } });
    expect(r2.statusCode).toBe(400);
  });

  it('400s when attending_next is missing', async () => {
    const db = seedWlrfm();
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/checkin/${token.token}`, payload: { bringing_next: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('410s (no write) on an expired token, and once max_uses is reached', async () => {
    const db = seedWlrfm();
    const app = await buildApp(db);
    const expired = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-01T00:00:00Z'), now: new Date('2026-08-01T00:00:00Z'), created_by: 'engine',
    });
    const res1 = await app.inject({ method: 'POST', url: `/api/checkin/${expired.token}`, payload: { attending_next: true } });
    expect(res1.statusCode).toBe(410);
    expect(db.dump('checkins')['wlrfm_2026-09-19_p1']).toBeUndefined();

    const maxed = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    await db.collection('link_tokens').doc(maxed.token).update({ uses: 25 });
    const res2 = await app.inject({ method: 'POST', url: `/api/checkin/${maxed.token}`, payload: { attending_next: true } });
    expect(res2.statusCode).toBe(410);
  });

  it('an sms-created partial check-in is overwritten by the form submission with partial:false', async () => {
    const db = seedWlrfm();
    await db.collection('checkins').doc('wlrfm_2026-09-19_p1').set({
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19', submitted_at: new Date('2026-09-19T19:00:00Z'),
      source: 'sms', token_id: 'tokx',
      estimated_sales: { value: null, raw: '', kind: 'none' }, transactions_estimate: { value: null, raw: '' },
      sold_out_items: [], sold_out_raw: '', unsold_items: [], unsold_raw: '',
      attending_next: true, attending_next_raw: 'yes', bringing_next: [], bringing_next_raw: '',
      feedback: '', extra_answers: {}, flags: [], raw_import: null, submissions: 1, partial: true,
      created_at: new Date('2026-09-19T19:00:00Z'), updated_at: new Date('2026-09-19T19:00:00Z'),
    });
    const token = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-20T18:00:00Z'), created_by: 'engine',
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: `/api/checkin/${token.token}`,
      payload: { attending_next: true, bringing_next: 'tomatoes', sold_out: '', unsold: '', estimated_sales: '', transactions_estimate: '', feedback: '' },
    });
    expect(res.statusCode).toBe(200);
    const stored = db.dump('checkins')['wlrfm_2026-09-19_p1']!;
    expect(stored.partial).toBe(false);
    expect(stored.source).toBe('form');
    expect(stored.submissions).toBe(2);
  });
});

describe('no session is ever minted', () => {
  it('the route/service source imports no jwt.js', () => {
    for (const path of ['src/routes/checkin-public.ts', 'src/services/checkins-submit.ts', 'src/services/link-tokens.ts']) {
      const src = readFileSync(path, 'utf8');
      expect(src).not.toMatch(/jwt\.js/);
    }
  });
});
