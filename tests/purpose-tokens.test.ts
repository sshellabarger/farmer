import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import {
  AGREEMENT_TOKEN_MAX_USES,
  APPLICATION_TOKEN_MAX_USES,
  markPurposeTokenUsed,
  mintPurposeToken,
  purposeTokenUrl,
  purposeTokensFor,
  resolvePurposeToken,
} from '../src/services/purpose-tokens.js';
import { TOKEN_RE, mintCheckinToken, resolveCheckinToken } from '../src/services/link-tokens.js';
import { findOpenCheckin } from '../src/services/open-checkin.js';

const NOW = new Date('2026-12-15T18:00:00Z');
const LATER = new Date('2026-12-30T18:00:00Z');

function mint(db: ReturnType<typeof fakeDb>, purpose: 'application' | 'agreement', over: Record<string, unknown> = {}) {
  return mintPurposeToken(db as never, {
    purpose,
    producer_id: 'p1',
    market_id: 'wlrfm',
    season: '2027',
    membership_id: purpose === 'agreement' ? 'p1_wlrfm_2027' : null,
    expires_at: new Date('2027-01-31T00:00:00Z'),
    now: NOW,
    created_by: 'admin1',
    ...over,
  });
}

describe('mintPurposeToken', () => {
  it('writes a 43-character token with the purpose cap and the contract shape', async () => {
    const db = fakeDb();
    const app = await mint(db, 'application');
    const agr = await mint(db, 'agreement');
    expect(app.token).toMatch(TOKEN_RE);
    expect(app.max_uses).toBe(APPLICATION_TOKEN_MAX_USES);
    expect(agr.max_uses).toBe(AGREEMENT_TOKEN_MAX_USES);
    expect(db.dump('link_tokens')[app.token]).toMatchObject({
      purpose: 'application',
      producer_id: 'p1',
      market_id: 'wlrfm',
      season: '2027',
      membership_id: null,
      application_id: null,
      uses: 0,
      used_at: null,
      sent_message_id: null,
      email_sent_at: null,
      created_by: 'admin1',
    });
    expect(db.dump('link_tokens')[agr.token]).toMatchObject({ purpose: 'agreement', membership_id: 'p1_wlrfm_2027' });
  });

  it('builds the links the texts carry', () => {
    expect(purposeTokenUrl('https://x.test/', 'application', 'abc')).toBe('https://x.test/apply?t=abc');
    expect(purposeTokenUrl('https://x.test', 'agreement', 'abc')).toBe('https://x.test/agreement?t=abc');
  });
});

describe('resolvePurposeToken', () => {
  it('unknown for a malformed string and a missing doc', async () => {
    const db = fakeDb();
    expect(await resolvePurposeToken(db as never, 'short', 'application', NOW)).toEqual({ status: 'unknown' });
    expect(await resolvePurposeToken(db as never, 'x'.repeat(43), 'application', NOW)).toEqual({ status: 'unknown' });
  });

  it('ok, wrong purpose, expired and used', async () => {
    const db = fakeDb();
    const app = await mint(db, 'application');
    expect((await resolvePurposeToken(db as never, app.token, 'application', NOW)).status).toBe('ok');

    const wrong = await resolvePurposeToken(db as never, app.token, 'agreement', NOW);
    expect(wrong).toMatchObject({ status: 'expired', reason: 'wrong_purpose' });

    const expired = await resolvePurposeToken(db as never, app.token, 'application', new Date('2027-02-01T00:00:00Z'));
    expect(expired).toMatchObject({ status: 'expired', reason: 'expired' });

    const agr = await mint(db, 'agreement');
    await markPurposeTokenUsed(db as never, agr.token, NOW);
    expect((await resolvePurposeToken(db as never, agr.token, 'agreement', LATER)).status).toBe('used');
  });

  it('an application token survives several uses until its cap', async () => {
    const db = fakeDb();
    const app = await mint(db, 'application');
    for (let i = 0; i < APPLICATION_TOKEN_MAX_USES - 1; i += 1) await markPurposeTokenUsed(db as never, app.token, NOW);
    expect((await resolvePurposeToken(db as never, app.token, 'application', NOW)).status).toBe('ok');
    await markPurposeTokenUsed(db as never, app.token, NOW);
    expect((await resolvePurposeToken(db as never, app.token, 'application', NOW)).status).toBe('used');
  });

  it('a check-in token is unknown to the purpose resolver', async () => {
    const db = fakeDb();
    const checkin = await mintCheckinToken(db as never, { producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19', deadline_at: LATER, now: NOW, created_by: 'engine' });
    expect(await resolvePurposeToken(db as never, checkin.token, 'application', NOW)).toEqual({ status: 'unknown' });
  });
});

describe('markPurposeTokenUsed', () => {
  it('counts a use, stamps used_at and records the application id', async () => {
    const db = fakeDb();
    const app = await mint(db, 'application');
    await markPurposeTokenUsed(db as never, app.token, LATER, { application_id: 'app-1' });
    expect(db.dump('link_tokens')[app.token]).toMatchObject({ uses: 1, application_id: 'app-1' });
    expect(db.dump('link_tokens')[app.token]!.used_at).toEqual(LATER);
  });

  it('is a no-op for an unknown token', async () => {
    const db = fakeDb();
    await markPurposeTokenUsed(db as never, 'x'.repeat(43), NOW);
    expect(db.count('link_tokens')).toBe(0);
  });
});

describe('purposeTokensFor', () => {
  it('lists one producer\'s tokens of one purpose, newest first, optionally per season', async () => {
    const db = fakeDb();
    const a = await mint(db, 'application', { now: new Date('2026-12-01T00:00:00Z') });
    const b = await mint(db, 'application', { now: new Date('2026-12-10T00:00:00Z') });
    await mint(db, 'application', { season: '2028', now: new Date('2026-12-11T00:00:00Z') });
    await mint(db, 'agreement');
    await mint(db, 'application', { producer_id: 'p2' });
    const all = await purposeTokensFor(db as never, 'p1', 'application');
    expect(all).toHaveLength(3);
    const season = await purposeTokensFor(db as never, 'p1', 'application', { season: '2027', market_id: 'wlrfm' });
    expect(season.map((t) => t.token)).toEqual([b.token, a.token]);
  });
});

describe('check-in plumbing ignores purpose tokens', () => {
  it('findOpenCheckin never returns an application or agreement token, and resolveCheckinToken answers unknown', async () => {
    const db = fakeDb({
      market_dates: {
        wlrfm_2027_04_03: { market_id: 'wlrfm', date: '2027-04-03', status: 'collecting', start_at: NOW, end_at: NOW, actions: {} },
      },
    });
    const app = await mint(db, 'application');
    const agr = await mint(db, 'agreement');
    // Give them a market_date_id so only the purpose guard can exclude them.
    await db.collection('link_tokens').doc(app.token).update({ market_date_id: 'wlrfm_2027_04_03' });
    await db.collection('link_tokens').doc(agr.token).update({ market_date_id: 'wlrfm_2027_04_03' });

    expect(await findOpenCheckin(db as never, 'p1', NOW)).toBeNull();
    expect(await resolveCheckinToken(db as never, app.token, NOW)).toEqual({ status: 'unknown' });
    expect(await resolveCheckinToken(db as never, agr.token, NOW)).toEqual({ status: 'unknown' });
  });
});
