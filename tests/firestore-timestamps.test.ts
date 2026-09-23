// Regression for the 2026-09-22 rollMarketDates outage: Firestore returns
// `Timestamp` for every date field, and the generator compared them as Dates.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';
import { toDate, toDateOrEpoch, toMillis } from '../src/utils/dates.js';
import { generateMarketDates, marketDateFromData, isDateDecided, reminderStateKey } from '../src/services/market-dates.js';
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

  it('derives reminders_sent, offset-sorted, from the per-offset reminder_state map the engine writes (round 2)', () => {
    const at = Timestamp.fromDate(new Date('2026-09-21T17:00:00Z'));
    const doc = marketDateFromData('wlrfm_2026-09-19', {
      market_id: 'wlrfm',
      date: '2026-09-19',
      status: 'collecting',
      actions: {
        reminders_sent: [],
        reminder_state: {
          [reminderStateKey(2880)]: { offset_min: 2880, sent_at: at, recipients: 2, failed: 0, skipped: null },
          [reminderStateKey(1440)]: { offset_min: 1440, sent_at: at, recipients: 0, failed: 0, skipped: 'superseded' },
        },
      },
    });
    expect(doc.actions.reminders_sent.map((r) => [r.offset_min, r.skipped, r.recipients])).toEqual([
      [1440, 'superseded', 0],
      [2880, null, 2],
    ]);
    expect(doc.actions.reminders_sent[0]!.sent_at).toEqual(at.toDate());
    expect(reminderStateKey(1440)).toBe('offset_1440');
    expect(() => reminderStateKey(1.5)).toThrow();

    // A legacy array alone still reads (no production doc has one; kept for safety).
    const legacy = marketDateFromData('x', { actions: { reminders_sent: [{ offset_min: 1440, sent_at: at, recipients: 1, failed: 0, skipped: null }] } });
    expect(legacy.actions.reminders_sent.map((r) => r.offset_min)).toEqual([1440]);
    // Both present: the map wins for an offset it holds; an offset only the array holds is kept.
    const both = marketDateFromData('x', {
      actions: {
        reminders_sent: [
          { offset_min: 1440, sent_at: at, recipients: 1, failed: 0, skipped: null },
          { offset_min: 60, sent_at: at, recipients: 3, failed: 0, skipped: null },
        ],
        reminder_state: { offset_1440: { offset_min: 1440, sent_at: at, recipients: 5, failed: 0, skipped: null } },
      },
    });
    expect(both.actions.reminders_sent.map((r) => [r.offset_min, r.recipients])).toEqual([
      [60, 3],
      [1440, 5],
    ]);
    expect(marketDateFromData('x', { actions: {} }).actions.reminders_sent).toEqual([]);
    expect(marketDateFromData('x', {}).actions.reminders_sent).toEqual([]);
  });

  it('isDateDecided freezes a date whose only engine action is a reminder_state entry; informational claims never count', () => {
    const now = new Date('2026-09-21T18:00:00Z');
    const base = { market_id: 'wlrfm', date: '2026-09-26', status: 'collecting', end_at: new Date('2026-09-26T17:00:00Z'), actions: {} };
    const entry = { offset_min: 1440, sent_at: now, recipients: 0, failed: 0, skipped: 'superseded' };
    expect(isDateDecided(marketDateFromData('x', base), now)).toBe(false);
    expect(isDateDecided(marketDateFromData('x', { ...base, actions: { reminder_state: { offset_1440: entry } } }), now)).toBe(true);
    expect(isDateDecided(marketDateFromData('x', { ...base, actions: { reminders_sent: [entry] } }), now)).toBe(true);
    expect(isDateDecided(marketDateFromData('x', { ...base, actions: { claims: { checkin: now } } }), now)).toBe(false);
    expect(isDateDecided(marketDateFromData('x', { ...base, actions: { checkin_sent_at: now } }), now)).toBe(true);
  });

  it('the generator freezes a date the engine touched only through reminder_state, and updates an undecided one by field path', async () => {
    const day = (date: string, hoursZ: number, plusDays = 0) => new Date(Date.parse(`${date}T${String(hoursZ).padStart(2, '0')}:00:00Z`) + plusDays * 86_400_000);
    const dateDoc = (date: string, actions: Record<string, unknown>) => ({
      market_id: 'wlrfm',
      date,
      start_time: '08:00',
      end_time: '12:00',
      start_at: day(date, 13),
      end_at: day(date, 17),
      status: 'collecting',
      schedule_version: 'v1',
      special: false,
      note: '',
      actions: {
        checkin_sent_at: null,
        reminders_sent: [],
        deadline_at: day(date, 17, 3),
        deadline_processed_at: null,
        drafts_generated_at: null,
        approved_at: null,
        booth_texts_sent_at: null,
        ...actions,
      },
      extra_questions: [],
      sponsor_id: null,
      cancellation_reason: null,
      cancelled_at: null,
      cancelled_by: null,
      generated_at: new Date('2026-09-01T00:00:00Z'),
      source: 'generator',
      created_at: new Date('2026-09-01T00:00:00Z'),
      updated_at: new Date('2026-09-01T00:00:00Z'),
    });
    const superseded = { offset_min: 1440, sent_at: new Date('2026-10-04T17:00:00Z'), recipients: 0, failed: 0, skipped: 'superseded' };
    const db = fakeDb({
      market_dates: {
        'wlrfm_2026-10-03': dateDoc('2026-10-03', { reminder_state: { offset_1440: superseded } }),
        'wlrfm_2026-10-10': dateDoc('2026-10-10', { claims: { checkin: new Date('2026-10-03T18:00:00Z') } }), // informational only → undecided
      },
    });
    // The schedule changes: markets now end at 13:00.
    const changed: FarmersMarket = { ...market, schedule: { ...market.schedule, versions: [{ ...market.schedule.versions[0]!, end_time: '13:00' }] } };
    const now = new Date('2026-09-22T08:15:00Z');
    const r = await generateMarketDates(db as never, changed, { scope: 'window', now, actor: 'scheduler' });
    // Seven in-season Saturdays in the window (09-19 … 10-31); two exist: one frozen (the engine touched it), one updated.
    expect(r).toMatchObject({ frozen: 1, updated: 1, created: 5, cancelled: 0 });

    const frozen = db.dump('market_dates')['wlrfm_2026-10-03']! as Record<string, unknown>;
    expect(frozen.end_time).toBe('12:00'); // untouched, including its actions
    expect((frozen.actions as Record<string, unknown>).reminder_state).toEqual({ offset_1440: superseded });

    const updated = db.dump('market_dates')['wlrfm_2026-10-10']! as Record<string, unknown>;
    expect(updated.end_time).toBe('13:00');
    expect(updated.end_at).toEqual(new Date('2026-10-10T18:00:00Z'));
    expect(updated.actions).toEqual({
      checkin_sent_at: null,
      reminders_sent: [],
      deadline_at: new Date('2026-10-13T18:00:00Z'), // the one action field the generator owns
      deadline_processed_at: null,
      drafts_generated_at: null,
      approved_at: null,
      booth_texts_sent_at: null,
      claims: { checkin: new Date('2026-10-03T18:00:00Z') }, // everything else inside actions is left alone
    });
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
