import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import {
  generateToken,
  mintCheckinToken,
  resolveCheckinToken,
  markTokenUsed,
  tokensForDate,
  TOKEN_RE,
} from '../src/services/link-tokens.js';

describe('generateToken', () => {
  it('matches TOKEN_RE and 1000 tokens are unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = generateToken();
      expect(TOKEN_RE.test(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('mintCheckinToken', () => {
  it('writes the §2.1 shape with uses: 0, max_uses: 25', async () => {
    const db = fakeDb();
    const now = new Date('2026-09-19T18:00:00Z');
    const deadline = new Date('2026-09-22T17:00:00Z');
    const doc = await mintCheckinToken(db as never, {
      producer_id: 'p1',
      market_id: 'wlrfm',
      market_date_id: 'wlrfm_2026-09-19',
      deadline_at: deadline,
      now,
      created_by: 'engine',
    });

    expect(TOKEN_RE.test(doc.token)).toBe(true);
    expect(doc.purpose).toBe('checkin');
    expect(doc.uses).toBe(0);
    expect(doc.max_uses).toBe(25);
    expect(doc.used_at).toBeNull();
    expect(doc.expires_at.toISOString()).toBe('2026-09-25T17:00:00.000Z'); // deadline + 4320min (3 days)
    expect(doc.sent_message_id).toBeNull();

    const stored = db.dump('link_tokens')[doc.token];
    expect(stored).toBeDefined();
  });
});

describe('resolveCheckinToken', () => {
  async function seedDate(db: ReturnType<typeof fakeDb>, status = 'collecting') {
    await db.collection('market_dates').doc('wlrfm_2026-09-19').set({
      market_id: 'wlrfm',
      date: '2026-09-19',
      status,
      actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
    });
  }

  it('unknown doc or a regex failure -> unknown', async () => {
    const db = fakeDb();
    expect((await resolveCheckinToken(db as never, 'not-a-valid-token', new Date())).status).toBe('unknown');
    expect((await resolveCheckinToken(db as never, generateToken(), new Date())).status).toBe('unknown');
  });

  it('expires_at <= now -> expired/expired', async () => {
    const db = fakeDb();
    await seedDate(db);
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      expires_at: new Date('2026-09-19T00:00:00Z'), used_at: null, uses: 0, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const r = await resolveCheckinToken(db as never, token, new Date('2026-09-20T00:00:00Z'));
    expect(r).toMatchObject({ status: 'expired', reason: 'expired' });
  });

  it('uses >= max_uses -> expired/exhausted', async () => {
    const db = fakeDb();
    await seedDate(db);
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      expires_at: new Date('2026-09-25T00:00:00Z'), used_at: null, uses: 25, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const r = await resolveCheckinToken(db as never, token, new Date('2026-09-20T00:00:00Z'));
    expect(r).toMatchObject({ status: 'expired', reason: 'exhausted' });
  });

  it('cancelled date -> expired/date_cancelled', async () => {
    const db = fakeDb();
    await seedDate(db, 'cancelled');
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      expires_at: new Date('2026-09-25T00:00:00Z'), used_at: null, uses: 0, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const r = await resolveCheckinToken(db as never, token, new Date('2026-09-20T00:00:00Z'));
    expect(r).toMatchObject({ status: 'expired', reason: 'date_cancelled' });
  });

  it('missing date doc -> expired/date_missing', async () => {
    const db = fakeDb();
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-99-99',
      expires_at: new Date('2026-09-25T00:00:00Z'), used_at: null, uses: 0, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const r = await resolveCheckinToken(db as never, token, new Date('2026-09-20T00:00:00Z'));
    expect(r).toMatchObject({ status: 'expired', reason: 'date_missing' });
  });

  it('valid token -> ok with both the token and the normalised date', async () => {
    const db = fakeDb();
    await seedDate(db);
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      expires_at: new Date('2026-09-25T00:00:00Z'), used_at: null, uses: 0, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const r = await resolveCheckinToken(db as never, token, new Date('2026-09-20T00:00:00Z'));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.token.producer_id).toBe('p1');
      expect(r.date.id).toBe('wlrfm_2026-09-19');
    }
  });
});

describe('markTokenUsed', () => {
  it('increments uses and sets used_at; no-op on an unknown token', async () => {
    const db = fakeDb();
    const token = generateToken();
    await db.collection('link_tokens').doc(token).set({
      token, purpose: 'checkin', producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      expires_at: new Date('2026-09-25T00:00:00Z'), used_at: null, uses: 0, max_uses: 25, created_at: new Date(), created_by: 'engine', sent_message_id: null,
    });
    const now = new Date('2026-09-19T20:00:00Z');
    await markTokenUsed(db as never, token, now);
    const stored = db.dump('link_tokens')[token]!;
    expect(stored.uses).toBe(1);
    expect(stored.used_at).toEqual(now);

    await expect(markTokenUsed(db as never, generateToken(), now)).resolves.toBeUndefined();
  });
});

describe('tokensForDate', () => {
  it('returns the newest-first tokens for a producer/date', async () => {
    const db = fakeDb();
    const t1 = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-19T18:00:00Z'), created_by: 'engine',
    });
    const t2 = await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      deadline_at: new Date('2026-09-22T17:00:00Z'), now: new Date('2026-09-20T18:00:00Z'), created_by: 'engine',
    });
    // A different date for the same producer must not show up.
    await mintCheckinToken(db as never, {
      producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-26',
      deadline_at: new Date('2026-09-29T17:00:00Z'), now: new Date('2026-09-20T18:00:00Z'), created_by: 'engine',
    });

    const tokens = await tokensForDate(db as never, 'p1', 'wlrfm_2026-09-19');
    expect(tokens.map((t) => t.token)).toEqual([t2.token, t1.token]);
  });
});
