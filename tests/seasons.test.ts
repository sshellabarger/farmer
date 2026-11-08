import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import {
  currentSeason,
  findMembership,
  inferSeasonLabel,
  insuranceStatusAt,
  isVendorOfRecord,
  listCurrentMemberships,
  membershipDocId,
  membershipFromData,
  normalizeFeePlan,
  type SeasonSource,
} from '../src/services/seasons.js';
import { runBackfill } from '../scripts/backfill-membership-seasons.mjs';

const v26 = { effective_from: '2026-04-18', season_start: '2026-04-18' };
const v27 = { effective_from: '2027-01-01', season_start: '2027-04-03' };
const m = (versions: { effective_from: string; season_start: string }[], season?: { label?: string | null }): SeasonSource => ({
  timezone: 'America/Chicago',
  schedule: { versions },
  season,
});

describe('inferSeasonLabel', () => {
  it('a 2026-only market in September 2026 is 2026', () => {
    expect(inferSeasonLabel(m([v26]), new Date('2026-09-19T12:00:00Z'))).toBe('2026');
  });

  it('adding a 2027 version does not flip the season until its effective_from', () => {
    const market = m([v26, v27]);
    expect(inferSeasonLabel(market, new Date('2026-11-08T12:00:00Z'))).toBe('2026');
    expect(inferSeasonLabel(market, new Date('2027-02-01T12:00:00Z'))).toBe('2027');
  });

  it('reads today in the market zone: New Year there is not yet New Year in UTC', () => {
    const market = m([v26, v27]);
    expect(inferSeasonLabel(market, new Date('2027-01-01T03:00:00Z'))).toBe('2026'); // 21:00 on Dec 31 in Chicago
    expect(inferSeasonLabel(market, new Date('2027-01-01T07:00:00Z'))).toBe('2027');
  });

  it('a market with no versions reads as the legacy season', () => {
    expect(inferSeasonLabel(m([]), new Date())).toBe('2026');
  });

  it('before every version it uses the earliest one', () => {
    expect(inferSeasonLabel(m([v27]), new Date('2026-01-01T12:00:00Z'))).toBe('2027');
  });
});

describe('currentSeason', () => {
  it('an explicit label wins', () => {
    expect(currentSeason(m([v26], { label: '2027' }), new Date('2026-09-19T12:00:00Z'))).toBe('2027');
    expect(currentSeason(m([v26], { label: '2027-winter' }), new Date())).toBe('2027-winter');
  });

  it('a malformed or empty label is ignored', () => {
    expect(currentSeason(m([v26], { label: 'next year' }), new Date('2026-09-19T12:00:00Z'))).toBe('2026');
    expect(currentSeason(m([v26], { label: null }), new Date('2026-09-19T12:00:00Z'))).toBe('2026');
  });
});

describe('membershipFromData', () => {
  it('reads a Phase 2 document as season 2026, daily, one space, no insurance, no agreement', () => {
    const view = membershipFromData('p1_wlrfm', {
      producer_id: 'p1',
      market_id: 'wlrfm',
      status: 'active',
      fee_plan: 'weekly',
      usual_booth_id: null,
      history: [],
      source: 'import',
      created_at: new Date('2026-09-01'),
      updated_at: new Date('2026-09-01'),
    });
    expect(view).toMatchObject({
      season: '2026',
      fee_plan: 'daily',
      fee_plan_raw: 'weekly',
      spaces: 1,
      electric: false,
      pay_in_full: false,
      booth_kind: 'stall',
      trial_period: false,
      hold_harmless: null,
      approved_items: [],
      item_requests: [],
      application_id: null,
    });
    expect(view.insurance).toMatchObject({ status: 'missing', expires_at: null, upload_id: null });
  });

  it('keeps a stored season and the Phase 4 fields', () => {
    const view = membershipFromData('x', {
      producer_id: 'p1',
      market_id: 'wlrfm',
      season: '2027',
      status: 'approved',
      fee_plan: 'seasonal',
      spaces: 2,
      electric: true,
      booth_kind: 'food_truck',
      usual_booth_id: 'wlrfm_v1',
    });
    expect(view).toMatchObject({ season: '2027', fee_plan: 'seasonal', spaces: 2, electric: true, booth_kind: 'food_truck', usual_booth_id: 'wlrfm_v1' });
  });
});

describe('normalizeFeePlan', () => {
  it('maps the Phase 2 vocabulary onto seasonal | daily', () => {
    expect(normalizeFeePlan('weekly')).toBe('daily');
    expect(normalizeFeePlan('season')).toBe('seasonal');
    expect(normalizeFeePlan('both')).toBe('seasonal');
    expect(normalizeFeePlan('seasonal')).toBe('seasonal');
    expect(normalizeFeePlan('daily')).toBe('daily');
    expect(normalizeFeePlan(undefined)).toBe('daily');
  });
});

describe('membershipDocId', () => {
  it('is producer, market and season', () => {
    expect(membershipDocId('p1', 'wlrfm', '2027')).toBe('p1_wlrfm_2027');
  });
});

function twoSeasonDb() {
  return fakeDb({
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', created_at: new Date('2026-09-01') },
      p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', created_at: new Date('2026-12-01') },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active', created_at: new Date('2026-09-01') },
      p3_other: { producer_id: 'p3', market_id: 'other', status: 'active', created_at: new Date('2026-09-01') },
    },
  });
}

describe('findMembership', () => {
  it('picks the season and returns null for an absent one', async () => {
    const db = twoSeasonDb();
    expect((await findMembership(db as never, 'p1', 'wlrfm', '2027'))?.id).toBe('p1_wlrfm_2027');
    expect((await findMembership(db as never, 'p1', 'wlrfm', '2026'))?.id).toBe('p1_wlrfm');
    expect(await findMembership(db as never, 'p1', 'wlrfm', '2028')).toBeNull();
    expect(await findMembership(db as never, 'p1', 'other', '2027')).toBeNull();
  });
});

describe('insuranceStatusAt', () => {
  const base = { status: 'on_file' as const, upload_id: null, verified_by: null, verified_at: null, note: '' };
  it('an on_file certificate past its expiry reads as expired', () => {
    expect(insuranceStatusAt({ ...base, expires_at: new Date('2027-05-01') }, new Date('2027-05-02'))).toBe('expired');
    expect(insuranceStatusAt({ ...base, expires_at: new Date('2027-05-01') }, new Date('2027-04-30'))).toBe('on_file');
    expect(insuranceStatusAt({ ...base, expires_at: null }, new Date('2030-01-01'))).toBe('on_file');
    expect(insuranceStatusAt({ ...base, status: 'waived', expires_at: new Date('2020-01-01') }, new Date())).toBe('waived');
  });
});

describe('listCurrentMemberships', () => {
  it('flips from 2026 to 2027 when the season label is set', async () => {
    const db = twoSeasonDb();
    const before = await listCurrentMemberships(db as never, { id: 'wlrfm', ...m([v26, v27]) }, new Date('2026-12-15T18:00:00Z'));
    expect(before.season).toBe('2026');
    expect(before.memberships.map((x) => x.id).sort()).toEqual(['p1_wlrfm', 'p2_wlrfm']);

    const after = await listCurrentMemberships(db as never, { id: 'wlrfm', ...m([v26, v27], { label: '2027' }) }, new Date('2026-12-15T18:00:00Z'));
    expect(after.season).toBe('2027');
    expect(after.memberships.map((x) => x.id)).toEqual(['p1_wlrfm_2027']);
  });

  it('only active memberships are vendors of record', () => {
    expect(isVendorOfRecord({ status: 'active' })).toBe(true);
    expect(isVendorOfRecord({ status: 'approved' })).toBe(false);
  });
});

describe('scripts/backfill-membership-seasons.mjs', () => {
  it('dry run counts, write sets only the season on memberships that lack it', async () => {
    const db = twoSeasonDb();
    const dry = await runBackfill({ db, marketId: 'wlrfm', season: '2026', write: false });
    expect(dry).toEqual({ scanned: 3, updated: 2, already_set: 1 });
    expect(db.dump('producer_memberships').p1_wlrfm!.season).toBeUndefined();

    const before = JSON.stringify(db.dump('producer_memberships').p3_other);
    const done = await runBackfill({ db, marketId: 'wlrfm', season: '2026', write: true });
    expect(done).toEqual({ scanned: 3, updated: 2, already_set: 1 });
    expect(db.dump('producer_memberships').p1_wlrfm!.season).toBe('2026');
    expect(db.dump('producer_memberships').p2_wlrfm!.season).toBe('2026');
    expect(db.dump('producer_memberships').p1_wlrfm_2027!.season).toBe('2027');
    expect(JSON.stringify(db.dump('producer_memberships').p3_other)).toBe(before); // another market is untouched
    expect(db.dump('producer_memberships').p1_wlrfm!.updated_at).toBeUndefined(); // nothing else is written

    const again = await runBackfill({ db, marketId: 'wlrfm', season: '2026', write: true });
    expect(again).toEqual({ scanned: 3, updated: 0, already_set: 3 });
  });

  it('refuses a malformed season', async () => {
    await expect(runBackfill({ db: fakeDb(), marketId: 'wlrfm', season: 'nope', write: false })).rejects.toThrow(/Invalid season/);
  });
});
