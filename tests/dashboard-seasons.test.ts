import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { T_OPEN, adminAuth, authFor, boot, seed } from './helpers/a1-fixtures.js';

// Saturday 2026-12-12, 08:00-12:00 CST: closed three days before T_OPEN, inside the collecting window.
const PAST_DATE = {
  market_id: 'wlrfm',
  date: '2026-12-12',
  start_time: '08:00',
  end_time: '12:00',
  start_at: new Date('2026-12-12T14:00:00Z'),
  end_at: new Date('2026-12-12T18:00:00Z'),
  status: 'collecting',
  schedule_version: 'v26',
  special: false,
  note: '',
  actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-12-15T18:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
  extra_questions: [],
  created_at: new Date('2026-12-01'),
  updated_at: new Date('2026-12-01'),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = (marketOver: Record<string, unknown> = {}) =>
  seed(
    {
      users: { admin1: { name: 'Admin', role: 'admin', active: true }, mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true } },
      market_dates: { wlrfm_2026_12_12: PAST_DATE },
      producer_memberships: {
        // Three vendors of 2026, one of 2027.
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
        p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
        p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active', season: '2026' },
        p4_wlrfm_2027: { producer_id: 'p4', market_id: 'wlrfm', status: 'active', season: '2027' },
        p5_wlrfm_2027: { producer_id: 'p5', market_id: 'wlrfm', status: 'approved', season: '2027' },
      },
      checkins: { wlrfm_2026_12_12_p1: { market_date_id: 'wlrfm_2026_12_12', producer_id: 'p1' } },
    },
    marketOver,
  );

const card = async (d: ReturnType<typeof db>) => {
  const app = await boot(d);
  const res = await app.inject({ method: 'GET', url: '/api/dashboard', headers: adminAuth() });
  expect(res.statusCode).toBe(200);
  return res.json().markets.find((m: { market: { id: string } }) => m.market.id === 'wlrfm');
};

describe('GET /api/dashboard — current-season progress', () => {
  it('active_memberships ignores the 2026 rows once the season label is 2027', async () => {
    const c = await card(db());
    expect(c.season).toBe('2027');
    expect(c.progress).toEqual({ active_memberships: 1, checkins: 1, percent: 100 }); // only p4 is an active 2027 vendor
  });

  it('before the label is set the card is the inferred 2026 season', async () => {
    const c = await card(db({ season: null }));
    expect(c.season).toBe('2026');
    expect(c.progress).toEqual({ active_memberships: 3, checkins: 1, percent: 33 });
  });

  it('only active memberships count, not approved ones', async () => {
    const d = db();
    await d.collection('producer_memberships').doc('p5_wlrfm_2027').update({ status: 'active' });
    expect((await card(d)).progress.active_memberships).toBe(2);
  });

  it('every market card carries its season; a manager sees only their market', async () => {
    const app = await boot(db());
    const all = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: adminAuth() })).json().markets;
    expect(all.map((m: { market: { id: string }; season: string }) => [m.market.id, m.season]).sort()).toEqual([['other', '2027'], ['wlrfm', '2027']]);
    const mine = (await app.inject({ method: 'GET', url: '/api/dashboard', headers: authFor('mgr1', 'market_manager') })).json().markets;
    expect(mine.map((m: { market: { id: string } }) => m.market.id)).toEqual(['other']);
  });
});
