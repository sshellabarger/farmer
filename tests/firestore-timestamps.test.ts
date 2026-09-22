// Regression for the 2026-09-22 rollMarketDates outage: Firestore returns
// `Timestamp` for every date field, and the generator compared them as Dates.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';
import { toDate, toDateOrEpoch, toMillis } from '../src/utils/dates.js';
import { generateMarketDates, marketDateFromData } from '../src/services/market-dates.js';
import type { FarmersMarket } from '../src/services/markets.js';

const market: FarmersMarket = {
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
} as FarmersMarket;

describe('toDate', () => {
  const at = new Date('2026-09-19T17:00:00Z');
  it('accepts Date, Timestamp, the serialized Timestamp shape, ISO strings and epoch millis', () => {
    expect(toDate(at)).toEqual(at);
    expect(toDate(Timestamp.fromDate(at))).toEqual(at);
    expect(toDate({ _seconds: 1789837200, _nanoseconds: 0 })).toEqual(at);
    expect(toDate(at.toISOString())).toEqual(at);
    expect(toDate(at.getTime())).toEqual(at);
    expect(toMillis(Timestamp.fromDate(at))).toBe(at.getTime());
  });
  it('returns null for missing or invalid values, and the epoch for required fields', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('')).toBeNull();
    expect(toDate('not a date')).toBeNull();
    expect(toDate(new Date('x'))).toBeNull();
    expect(toDateOrEpoch(undefined).getTime()).toBe(0);
  });
});

describe('fake-db mirrors the admin SDK', () => {
  it('hands Date fields back as Timestamps on get(), nested and in arrays, while dump() stays raw', async () => {
    const db = fakeDb();
    const when = new Date('2026-09-19T17:00:00Z');
    await db.collection('x').doc('a').set({ at: when, nested: { at: when }, list: [when], n: 1 });
    const data = (await db.collection('x').doc('a').get()).data()!;
    expect(data.at).toBeInstanceOf(Timestamp);
    expect((data.nested as { at: unknown }).at).toBeInstanceOf(Timestamp);
    expect((data.list as unknown[])[0]).toBeInstanceOf(Timestamp);
    expect(data.n).toBe(1);
    const viaQuery = (await db.collection('x').where('n', '==', 1).get()).docs[0]!.data();
    expect(viaQuery.at).toBeInstanceOf(Timestamp);
    expect(db.dump('x').a!.at).toBeInstanceOf(Date);
  });
});

describe('market dates read back from Firestore', () => {
  it('normalises every date field, including actions and reminders_sent', () => {
    const end = new Date('2026-09-19T17:00:00Z');
    const doc = marketDateFromData('wlrfm_2026-09-19', {
      market_id: 'wlrfm',
      date: '2026-09-19',
      start_at: Timestamp.fromDate(new Date('2026-09-19T13:00:00Z')),
      end_at: Timestamp.fromDate(end),
      status: 'collecting',
      actions: {
        checkin_sent_at: null,
        // Phase 3 (contract §2.2): reminders_sent entries are ReminderSent
        // objects, not bare Timestamps.
        reminders_sent: [{ offset_min: 1440, sent_at: Timestamp.fromDate(end), recipients: 2, failed: 0, skipped: null }],
        deadline_at: Timestamp.fromDate(new Date('2026-09-22T17:00:00Z')),
        deadline_processed_at: null,
      },
      created_at: Timestamp.fromDate(end),
    });
    expect(doc.end_at.getTime()).toBe(end.getTime());
    expect(doc.actions.deadline_at.getTime()).toBe(Date.parse('2026-09-22T17:00:00Z'));
    expect(doc.actions.reminders_sent[0]!.offset_min).toBe(1440);
    expect(doc.actions.reminders_sent[0]!.sent_at.getTime()).toBe(end.getTime());
    expect(doc.actions.reminders_sent[0]!.recipients).toBe(2);
    expect(doc.actions.reminders_sent[0]!.skipped).toBeNull();
    expect(doc.actions.checkin_sent_at).toBeNull();
    expect(doc.actions.approved_at).toBeNull();
    expect(doc.created_at.getTime()).toBe(end.getTime());
  });

  it('the nightly roll freezes an imported past date and creates the upcoming Saturdays (the production case)', async () => {
    const db = fakeDb({
      market_dates: {
        'wlrfm_2026-09-19': {
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
            checkin_sent_at: null,
            reminders_sent: [],
            deadline_at: new Date('2026-09-22T17:00:00Z'),
            deadline_processed_at: null,
            drafts_generated_at: null,
            approved_at: null,
            booth_texts_sent_at: null,
          },
          extra_questions: [],
          sponsor_id: null,
          cancellation_reason: null,
          cancelled_at: null,
          cancelled_by: null,
          generated_at: new Date('2026-09-22T00:00:00Z'),
          source: 'import',
          created_at: new Date('2026-09-22T00:00:00Z'),
          updated_at: new Date('2026-09-22T00:00:00Z'),
        },
      },
    });
    const now = new Date('2026-09-22T08:15:00Z');
    const first = await generateMarketDates(db as never, market, { scope: 'window', now, actor: 'scheduler' });
    expect(first.frozen).toBe(1);
    // 2026-09-26 … 2026-10-31 are the six Saturdays left in the season inside the 56-day window.
    expect(first.created).toBe(6);
    expect(db.count('market_dates')).toBe(7);
    expect(db.dump('market_dates')['wlrfm_2026-09-19']!.updated_at).toEqual(new Date('2026-09-22T00:00:00Z'));

    const second = await generateMarketDates(db as never, market, { scope: 'window', now, actor: 'scheduler' });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.cancelled).toBe(0);
    expect(second.unchanged).toBe(6);
  });
});
