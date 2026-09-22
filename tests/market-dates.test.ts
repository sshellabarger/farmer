import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { generateMarketDates } from '../src/services/market-dates.js';
import type { MarketDateDoc } from '../src/services/market-dates.js';
import { DEFAULT_QUIET_HOURS, DEFAULT_WORKFLOW } from '../src/services/markets.js';
import type { FarmersMarket, ScheduleVersion } from '../src/services/markets.js';

function baseVersion(overrides: Partial<ScheduleVersion> = {}): ScheduleVersion {
  return {
    id: 'v1',
    effective_from: '2026-04-18',
    season_start: '2026-04-18',
    season_end: '2026-10-31',
    days_of_week: ['saturday'],
    start_time: '08:00',
    end_time: '12:00',
    created_at: new Date('2026-01-01'),
    created_by: 'import',
    ...overrides,
  };
}

function market(overrides: Partial<FarmersMarket> = {}): FarmersMarket {
  return {
    id: 'wlrfm',
    name: 'West Little Rock Farmers Market',
    slug: 'wlrfm',
    location: { name: 'Breckenridge Village', address: '' },
    timezone: 'America/Chicago',
    schedule: { versions: [baseVersion()], skipped_dates: [], special_dates: [] },
    workflow: DEFAULT_WORKFLOW,
    quiet_hours: DEFAULT_QUIET_HOURS,
    active: true,
    created_by: 'import',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

async function dump(db: ReturnType<typeof fakeDb>, marketId: string): Promise<MarketDateDoc[]> {
  const all = db.dump('market_dates');
  return Object.entries(all)
    .filter(([id]) => id.startsWith(`${marketId}_`))
    .map(([id, data]) => ({ id, ...(data as Record<string, unknown>) }) as MarketDateDoc)
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe('generateMarketDates', () => {
  it('1. Saturday 8-12 season generates exactly 29 dates in CDT', async () => {
    const db = fakeDb();
    const m = market();
    const result = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });

    expect(result.created).toBe(29);
    const dates = await dump(db, 'wlrfm');
    expect(dates).toHaveLength(29);
    expect(dates[0]!.id).toBe('wlrfm_2026-04-18');
    expect(dates[dates.length - 1]!.id).toBe('wlrfm_2026-10-31');
    for (const d of dates) {
      expect(d.start_at.toISOString().slice(11, 16)).toBe('13:00');
      expect(d.end_at.toISOString().slice(11, 16)).toBe('17:00');
      expect(d.status).toBe('collecting');
      expect(d.actions.deadline_at.getTime()).toBe(d.end_at.getTime() + 4320 * 60_000);
    }
  });

  it('2. Thursday 17-20 market spans both DST transitions', async () => {
    const db = fakeDb();
    const m = market({
      schedule: {
        versions: [baseVersion({ effective_from: '2026-03-01', season_start: '2026-03-01', season_end: '2026-11-30', days_of_week: ['thursday'], start_time: '17:00', end_time: '20:00' })],
        skipped_dates: [],
        special_dates: [],
      },
    });
    await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });
    const byId = Object.fromEntries((await dump(db, 'wlrfm')).map((d) => [d.date, d]));

    expect(byId['2026-03-05']!.start_at.toISOString()).toBe('2026-03-05T23:00:00.000Z');
    expect(byId['2026-03-12']!.start_at.toISOString()).toBe('2026-03-12T22:00:00.000Z');
    expect(byId['2026-10-29']!.start_at.toISOString()).toBe('2026-10-29T22:00:00.000Z');
    expect(byId['2026-11-05']!.start_at.toISOString()).toBe('2026-11-05T23:00:00.000Z');
  });

  it('3. skipped date: no doc on first run, cancelled if existing, revives when un-skipped', async () => {
    const db = fakeDb();
    let m = market({ schedule: { versions: [baseVersion()], skipped_dates: [{ date: '2026-07-04', reason: 'Holiday' }], special_dates: [] } });

    const r1 = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });
    expect(r1.skipped).toBe(1);
    expect((await dump(db, 'wlrfm')).find((d) => d.date === '2026-07-04')).toBeUndefined();

    // Simulate: the doc already existed (e.g. created before the skip was added), undecided.
    const existingId = 'wlrfm_2026-07-04';
    await db.collection('market_dates').doc(existingId).set({
      market_id: 'wlrfm', date: '2026-07-04', start_time: '08:00', end_time: '12:00',
      start_at: new Date('2026-07-04T13:00:00Z'), end_at: new Date('2026-07-04T17:00:00Z'),
      status: 'collecting', schedule_version: 'v1', special: false, note: '',
      actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-07-10T05:00:00Z'), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null },
      extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
      generated_at: new Date(), source: 'generator', created_at: new Date(), updated_at: new Date(),
    });
    const r2 = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test', now: new Date('2026-05-01T00:00:00Z') });
    expect(r2.cancelled).toBe(1);
    const cancelledDoc = (await dump(db, 'wlrfm')).find((d) => d.date === '2026-07-04')!;
    expect(cancelledDoc.status).toBe('cancelled');
    expect(cancelledDoc.cancelled_by).toBe('generator');
    expect(cancelledDoc.cancellation_reason).toBe('skipped: Holiday');

    // Un-skip: revive.
    m = market({ schedule: { versions: [baseVersion()], skipped_dates: [], special_dates: [] } });
    const r3 = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test', now: new Date('2026-05-01T00:00:00Z') });
    expect(r3.updated).toBeGreaterThanOrEqual(1);
    const revived = (await dump(db, 'wlrfm')).find((d) => d.date === '2026-07-04')!;
    expect(revived.status).toBe('collecting');
    expect(revived.cancelled_by).toBeNull();
  });

  it('4. special date outside the season creates a special market day', async () => {
    const db = fakeDb();
    const m = market({
      schedule: {
        versions: [baseVersion()],
        skipped_dates: [],
        special_dates: [{ date: '2026-12-12', start_time: '10:00', end_time: '14:00', note: 'Holiday market' }],
      },
    });
    await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });
    const special = (await dump(db, 'wlrfm')).find((d) => d.date === '2026-12-12')!;
    expect(special).toBeDefined();
    expect(special.special).toBe(true);
    expect(special.schedule_version).toBe('special');
    expect(special.start_time).toBe('10:00');
    expect(special.end_time).toBe('14:00');
    expect(special.note).toBe('Holiday market');
  });

  it('5. mid-season version change: past frozen, future undecided cancelled/created, extra_questions kept', async () => {
    const db = fakeDb();
    const m1 = market();
    await generateMarketDates(db as never, m1, { scope: 'season', actor: 'test', now: new Date('2026-01-01T00:00:00Z') });

    // Freeze a past Saturday and a decided future Saturday.
    await db.collection('market_dates').doc('wlrfm_2026-08-08').update({ status: 'published' });
    await db.collection('market_dates').doc('wlrfm_2026-08-01').update({ extra_questions: [{ key: 'weekly_question', prompt: 'x', type: 'text' }] });

    const now = new Date('2026-08-15T00:00:00Z'); // after 08-08, before 08-15's Saturday check
    const m2 = market({
      schedule: {
        versions: [baseVersion(), baseVersion({ id: 'v2', effective_from: '2026-08-01', days_of_week: ['sunday'] })],
        skipped_dates: [],
        special_dates: [],
      },
    });
    const result = await generateMarketDates(db as never, m2, { scope: 'season', actor: 'test', now });

    const dates = Object.fromEntries((await dump(db, 'wlrfm')).map((d) => [d.date, d]));
    // Saturdays before Aug 1 (already generated) are untouched.
    expect(dates['2026-04-18']!.schedule_version).toBe('v1');
    // The published (decided) Saturday is frozen.
    expect(dates['2026-08-08']!.status).toBe('published');
    // A future undecided Saturday >= Aug 1 gets cancelled for schedule_change.
    expect(dates['2026-08-22']!.status).toBe('cancelled');
    expect(dates['2026-08-22']!.cancellation_reason).toBe('schedule_change');
    // Sundays >= Aug 2 are created.
    expect(dates['2026-08-02']).toBeDefined();
    expect(dates['2026-08-02']!.schedule_version).toBe('v2');
    // 2026-08-01 is a past date relative to `now` (2026-08-15): frozen
    // untouched regardless of the version change, and its extra_questions survive.
    expect(dates['2026-08-01']!.status).toBe('collecting');
    expect(dates['2026-08-01']!.extra_questions).toEqual([{ key: 'weekly_question', prompt: 'x', type: 'text' }]);
    expect(result.frozen).toBeGreaterThanOrEqual(2); // the published date + every past Saturday
  });

  it('6. running the same scope twice is idempotent', async () => {
    const db = fakeDb();
    const m = market();
    await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });
    const before = await dump(db, 'wlrfm');

    const r2 = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test' });
    expect(r2).toMatchObject({ created: 0, updated: 0, cancelled: 0 });

    const after = await dump(db, 'wlrfm');
    const strip = (d: MarketDateDoc) => { const { generated_at: _g, updated_at: _u, ...rest } = d; return rest; };
    expect(after.map(strip)).toEqual(before.map(strip));
  });

  it('7. window scope only touches the window around `now`', async () => {
    const db = fakeDb();
    const m = market();
    const now = new Date('2026-06-10T12:00:00Z');
    const result = await generateMarketDates(db as never, m, { scope: 'window', actor: 'test', now });

    expect(result.from).toBe('2026-06-03');
    expect(result.to).toBe('2026-08-05');
    const dates = await dump(db, 'wlrfm');
    for (const d of dates) {
      expect(d.date >= '2026-06-03' && d.date <= '2026-08-05').toBe(true);
    }
    expect(dates.some((d) => d.date === '2026-06-06')).toBe(true); // a Saturday inside the window
    expect(dates.some((d) => d.date === '2026-05-30')).toBe(false); // outside the window
  });

  it('8. an admin-cancelled date is never revived by the generator', async () => {
    const db = fakeDb();
    const m = market();
    await generateMarketDates(db as never, m, { scope: 'season', actor: 'test', now: new Date('2026-01-01T00:00:00Z') });
    await db.collection('market_dates').doc('wlrfm_2026-05-02').update({ status: 'cancelled', cancelled_by: 'u1', cancelled_at: new Date(), cancellation_reason: 'rain' });

    const result = await generateMarketDates(db as never, m, { scope: 'season', actor: 'test', now: new Date('2026-01-02T00:00:00Z') });
    const doc = (await dump(db, 'wlrfm')).find((d) => d.date === '2026-05-02')!;
    expect(doc.status).toBe('cancelled');
    expect(doc.cancelled_by).toBe('u1');
    expect(result.frozen).toBeGreaterThanOrEqual(1);
  });
});
