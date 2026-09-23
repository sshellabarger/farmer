// Phase 3 fix, round 3: the generator creates new market dates with the
// atomic create(). A date that appears between its scan and its write —
// another generator run (the nightly roll and an admin schedule save can
// overlap) followed by the engine acting on it — must keep its flags; a blind
// set() erased them.
import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { generateMarketDates } from '../src/services/market-dates.js';
import type { FarmersMarket } from '../src/services/markets.js';

const market = {
  id: 'wlrfm',
  name: 'West Little Rock Farmers Market',
  slug: 'wlrfm',
  location: { name: 'Breckenridge Village', address: '' },
  timezone: 'America/Chicago',
  schedule: {
    versions: [
      {
        id: 'v1',
        effective_from: '2026-04-18',
        season_start: '2026-04-18',
        season_end: '2026-10-31',
        days_of_week: ['saturday'],
        start_time: '08:00',
        end_time: '12:00',
        created_at: new Date('2026-04-01T00:00:00Z'),
        created_by: 'import',
      },
    ],
    skipped_dates: [],
    special_dates: [],
  },
  workflow: { checkin_offset_min: 60, reminder_offsets_min: [1440, 2880], deadline_offset_min: 4320, drafts_offset_min: 4380 },
  quiet_hours: { start: '21:00', end: '08:00' },
  active: true,
  created_by: 'import',
  created_at: new Date('2026-04-01T00:00:00Z'),
  updated_at: new Date('2026-04-01T00:00:00Z'),
} as unknown as FarmersMarket;

describe('generator vs a concurrent creator', () => {
  it('does not overwrite a market date that appeared between its scan and its write', async () => {
    const T = new Date('2026-09-22T08:15:00Z');
    const db = fakeDb();
    const real = db.collection('market_dates');

    // The other run created wlrfm_2026-09-19 (inside the window: today − 7)
    // and the engine already processed its long-passed deadline.
    await real.doc('wlrfm_2026-09-19').set({
      market_id: 'wlrfm',
      date: '2026-09-19',
      start_time: '08:00',
      end_time: '12:00',
      start_at: new Date('2026-09-19T13:00:00Z'),
      end_at: new Date('2026-09-19T17:00:00Z'),
      status: 'collecting',
      schedule_version: 'v1',
      special: false,
      note: '',
      actions: {
        checkin_sent_at: T,
        reminders_sent: [],
        deadline_at: new Date('2026-09-22T17:00:00Z'),
        deadline_processed_at: T,
        summary_sent_at: null,
        summary_skipped: 'no_recipients',
        claims: { checkin: T, deadline: T },
      },
      non_responders: [],
      spot_not_held: [],
      extra_questions: [],
      source: 'generator',
      created_at: T,
      updated_at: T,
    });

    // This generator's scan ran before that create landed: it sees no dates.
    const raced = {
      collection(name: string) {
        if (name !== 'market_dates') return db.collection(name);
        return {
          where() {
            return { where: () => this, limit: () => this, get: async () => ({ empty: true, size: 0, docs: [] as unknown[] }) };
          },
          doc: (id: string) => real.doc(id),
        };
      },
    };

    const result = await generateMarketDates(raced as never, market, { scope: 'window', now: T, actor: 'scheduler' });

    // 2026-09-19 was left alone (counted as unchanged); the six other Saturdays in the window were created.
    expect(result.unchanged).toBe(1);
    expect(result.created).toBe(6);
    const kept = db.dump('market_dates')['wlrfm_2026-09-19']!;
    const actions = kept.actions as Record<string, unknown>;
    expect(actions.deadline_processed_at).toEqual(T);
    expect(actions.checkin_sent_at).toEqual(T);
    expect(actions.summary_skipped).toBe('no_recipients');
    expect((actions.claims as Record<string, unknown>).deadline).toEqual(T);
    expect(db.count('market_dates')).toBe(7);
  });
});
