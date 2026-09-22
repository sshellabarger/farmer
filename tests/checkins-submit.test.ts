import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { parseMoney, parseCount, splitItems, validateExtraAnswers, upsertFormCheckin, toFormValues } from '../src/services/checkins-submit.js';

describe('parseMoney', () => {
  it.each([
    ['$1,000.00', 1000, 'exact'],
    ['500-1000', 750, 'range'],
    ['500 to 1000', 750, 'range'],
    ['N/a', null, 'none'],
    ['$45,690.00', 45690, 'exact'],
    ['', null, 'none'],
  ] as const)('%s -> %s (%s)', (raw, value, kind) => {
    expect(parseMoney(raw)).toEqual({ value, kind });
  });
});

describe('parseCount', () => {
  it.each([
    ['80ish', 80, false],
    ['29 cards, 5 Cash App', 29, true],
    ['none', null, false],
    ['', null, false],
  ] as const)('%s -> %s ambiguous=%s', (raw, value, ambiguous) => {
    expect(parseCount(raw)).toEqual({ value, ambiguous });
  });
});

describe('splitItems', () => {
  it.each([
    ['tomatoes, eggs', ['tomatoes', 'eggs']],
    ['No.', []],
    ['none', []],
    ['n/a', []],
    ['tomatoes and eggs', ['tomatoes', 'eggs']],
    ['', []],
  ] as const)('%s -> %j', (raw, expected) => {
    expect(splitItems(raw)).toEqual(expected);
  });
});

describe('validateExtraAnswers', () => {
  const questions = [
    { key: 'booth_size', prompt: 'Booth size?', type: 'choice' as const, options: ['10x10', '10x20'] },
    { key: 'has_generator', prompt: 'Generator?', type: 'yes_no' as const },
    { key: 'notes', prompt: 'Notes?', type: 'text' as const },
  ];

  it('rejects an unknown key', () => {
    expect(validateExtraAnswers(questions, { bogus: 'x' })).toMatch(/unknown question/);
  });
  it('rejects a choice value outside its options', () => {
    expect(validateExtraAnswers(questions, { booth_size: '20x20' })).toMatch(/must be one of/);
  });
  it('rejects a non-boolean yes_no', () => {
    expect(validateExtraAnswers(questions, { has_generator: 'yes' as unknown as boolean })).toMatch(/must be true or false/);
  });
  it('rejects a non-string text answer', () => {
    expect(validateExtraAnswers(questions, { notes: true as unknown as string })).toMatch(/must be text/);
  });
  it('allows missing answers and valid ones', () => {
    expect(validateExtraAnswers(questions, { booth_size: '10x10', has_generator: true })).toBeNull();
  });
});

describe('upsertFormCheckin', () => {
  it('writes the full §2.3 shape, flags outliers/ambiguous counts, and resubmission overwrites in place', async () => {
    const db = fakeDb();
    const now1 = new Date('2026-09-19T14:00:00Z');
    const doc1 = await upsertFormCheckin(db as never, {
      market_date_id: 'wlrfm_2026-09-19',
      market_id: 'wlrfm',
      producer_id: 'p1',
      token_id: 'tok1',
      input: {
        attending_next: true,
        bringing_next: 'tomatoes, eggs',
        sold_out: 'peppers',
        unsold: 'squash',
        estimated_sales: '$45,690.00',
        transactions_estimate: '29 cards, 5 Cash App',
        feedback: 'great day',
        extra_answers: {},
      },
      now: now1,
    });

    expect(doc1.source).toBe('form');
    expect(doc1.partial).toBe(false);
    expect(doc1.submissions).toBe(1);
    expect(doc1.estimated_sales).toEqual({ value: 45690, raw: '$45,690.00', kind: 'exact' });
    expect(doc1.flags).toContain('sales_outlier');
    expect(doc1.flags).toContain('transactions_ambiguous');
    expect(doc1.bringing_next).toEqual(['tomatoes', 'eggs']);
    expect(doc1.created_at).toEqual(now1);

    const now2 = new Date('2026-09-19T15:00:00Z');
    const doc2 = await upsertFormCheckin(db as never, {
      market_date_id: 'wlrfm_2026-09-19',
      market_id: 'wlrfm',
      producer_id: 'p1',
      token_id: 'tok2',
      input: {
        attending_next: false,
        bringing_next: '',
        sold_out: '',
        unsold: '',
        estimated_sales: '500-1000',
        transactions_estimate: '40',
        feedback: '',
        extra_answers: {},
      },
      now: now2,
    });

    expect(doc2.submissions).toBe(2);
    expect(doc2.created_at).toEqual(now1); // preserved across overwrite
    expect(doc2.estimated_sales).toEqual({ value: 750, raw: '500-1000', kind: 'range' });
    expect(doc2.attending_next).toBe(false);

    const stored = db.dump('checkins')['wlrfm_2026-09-19_p1'];
    expect(stored!.submissions).toBe(2);

    const values = toFormValues(stored!);
    expect(values.attending_next).toBe(false);
    expect(values.estimated_sales).toBe('500-1000');
  });

  it('a source:sms partial doc is overwritten by the form with partial:false', async () => {
    const db = fakeDb();
    await db.collection('checkins').doc('wlrfm_2026-09-19_p2').set({
      producer_id: 'p2', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19',
      submitted_at: new Date('2026-09-19T13:00:00Z'), source: 'sms', token_id: 'tokx',
      estimated_sales: { value: null, raw: '', kind: 'none' }, transactions_estimate: { value: null, raw: '' },
      sold_out_items: [], sold_out_raw: '', unsold_items: [], unsold_raw: '',
      attending_next: true, attending_next_raw: 'yes', bringing_next: [], bringing_next_raw: '',
      feedback: '', extra_answers: {}, flags: [], raw_import: null, submissions: 1, partial: true,
      created_at: new Date('2026-09-19T13:00:00Z'), updated_at: new Date('2026-09-19T13:00:00Z'),
    });

    const doc = await upsertFormCheckin(db as never, {
      market_date_id: 'wlrfm_2026-09-19', market_id: 'wlrfm', producer_id: 'p2', token_id: 'tok2',
      input: { attending_next: true, bringing_next: 'tomatoes', sold_out: '', unsold: '', estimated_sales: '100', transactions_estimate: '5', feedback: '', extra_answers: {} },
      now: new Date('2026-09-19T16:00:00Z'),
    });
    expect(doc.partial).toBe(false);
    expect(doc.submissions).toBe(2);
  });
});
