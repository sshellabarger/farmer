// Fix X10: which market's staff receive a producer's forwarded text is decided
// by the producer's memberships of each market's CURRENT season only (D33).
// Last season's membership row no longer routes anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ADMIN_PHONE, P1_PHONE, T_OPEN, boot, seed, type Db } from './helpers/a1-fixtures.js';
import { firstActiveMembershipMarketId } from '../src/services/inbound.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN); // 2026-12-15; both fixture markets are in their 2027 season (season.label)
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MGR_W = '+15015550011';
const MGR_O = '+15015550012';
let n = 0;
const inboundUrl = (from: string, message: string) => `/api/sms/voipms/inbound?from=${from.replace('+', '')}&message=${encodeURIComponent(message)}&id=sms-season-${(n += 1)}`;
const forwards = (db: Db) =>
  Object.values(db.dump('messages'))
    .filter((m) => m.kind === 'forwarded_inbound')
    .map((m) => ({ to: m.to as string, body: m.body as string }))
    .sort((a, b) => a.to.localeCompare(b.to));

function world(memberships: Record<string, Record<string, unknown>>, marketOver: Record<string, unknown> = {}): Db {
  return seed(
    {
      users: {
        admin1: { name: 'Admin', role: 'admin', phone: ADMIN_PHONE, active: true },
        mgr_w: { name: 'WLRFM Manager', role: 'market_manager', phone: MGR_W, assigned_market_ids: ['wlrfm'], active: true },
        mgr_o: { name: 'Other Manager', role: 'market_manager', phone: MGR_O, assigned_market_ids: ['other'], active: true },
      },
      producers: { p1: { business_name: 'Testfield Farm', contact_name: 'Terry', phone: P1_PHONE, emails: [], active: true, sms_opt_out_at: null } },
      producer_memberships: memberships,
    },
    marketOver,
  );
}

const legacy = (market: string, status = 'active') => ({ producer_id: 'p1', market_id: market, status }); // a Phase 2 row: no season field, reads as 2026
const current = (market: string, status = 'active') => ({ producer_id: 'p1', market_id: market, season: '2027', status });

describe('forwarding a known producer\'s text', () => {
  it('last season\'s membership alone routes to nobody but the admins', async () => {
    const db = world({ p1_wlrfm: legacy('wlrfm') });
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'are you open in January?') });
    expect(forwards(db)).toEqual([{ to: ADMIN_PHONE, body: 'Text from Testfield Farm: are you open in January?' }]);
  });

  it('the current-season market wins over an older membership at a market that sorts first', async () => {
    // Before the fix the 2026 row at `other` (first by id) decided, and the wrong market's manager got the text.
    const db = world({ p1_other: legacy('other'), p1_wlrfm_2027: current('wlrfm') });
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'running late') });
    const body = 'Text from Testfield Farm (West Little Rock Farmers Market): running late';
    expect(forwards(db)).toEqual([
      { to: ADMIN_PHONE, body },
      { to: MGR_W, body },
    ]);
    expect(forwards(db).map((f) => f.to)).not.toContain(MGR_O);
  });

  it('a current-season membership that is not active yet (approved, agreement unsigned) does not route', async () => {
    const db = world({ p1_wlrfm_2027: current('wlrfm', 'approved') });
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'when do I get my booth?') });
    expect(forwards(db).map((f) => f.to)).toEqual([ADMIN_PHONE]);
  });

  it('two current-season markets: the first by id, as before', async () => {
    const db = world({ p1_other_2027: current('other'), p1_wlrfm_2027: current('wlrfm') });
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'hello') });
    expect(forwards(db).map((f) => f.to)).toEqual([ADMIN_PHONE, MGR_O]);
  });
});

describe('firstActiveMembershipMarketId', () => {
  it('follows each market\'s own current season, inferred from its schedule when no label is set', async () => {
    // No season label: the season is the year of the schedule version in effect (v26 until 2027-01-01, then v27).
    const db = world({ p1_wlrfm: legacy('wlrfm'), p1_wlrfm_2027: current('wlrfm', 'approved') }, { season: null });
    expect(await firstActiveMembershipMarketId(db as never, 'p1', new Date('2026-09-15T15:00:00Z'))).toBe('wlrfm'); // still the 2026 season
    expect(await firstActiveMembershipMarketId(db as never, 'p1', new Date('2027-01-02T15:00:00Z'))).toBeNull(); // 2027 now: the 2026 row is history, the 2027 one is not active
    await db.collection('producer_memberships').doc('p1_wlrfm_2027').update({ status: 'active' });
    expect(await firstActiveMembershipMarketId(db as never, 'p1', new Date('2027-01-02T15:00:00Z'))).toBe('wlrfm');
  });

  it('is null for a producer with no memberships, and reads a membership of a vanished market against the legacy season', async () => {
    const db = world({ p1_gone: legacy('gone'), p1_gone_2027: { producer_id: 'p1', market_id: 'gone', season: '2027', status: 'active' } });
    expect(await firstActiveMembershipMarketId(db as never, 'nobody', T_OPEN)).toBeNull();
    expect(await firstActiveMembershipMarketId(db as never, 'p1', T_OPEN)).toBe('gone');
    await db.collection('producer_memberships').doc('p1_gone').delete();
    expect(await firstActiveMembershipMarketId(db as never, 'p1', T_OPEN)).toBeNull();
  });
});
