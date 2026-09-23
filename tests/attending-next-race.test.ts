// Phase 3 fix, round 3: a texted YES/NO and a form submission landing in the
// same instant must end in ONE check-in that keeps every form answer. Both
// writers now create() first and fall back to an update, so no ordering can
// replace a full check-in with the SMS stub.
import { describe, it, expect } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { recordAttendingNext, type OpenCheckin } from '../src/services/open-checkin.js';
import { upsertFormCheckin } from '../src/services/checkins-submit.js';

const open: OpenCheckin = {
  token: 'tok1',
  producer_id: 'p1',
  market_id: 'wlrfm',
  market_date_id: 'wlrfm_2026-09-19',
  expires_at: new Date('2026-09-25T17:00:00Z'),
  created_at: new Date('2026-09-19T18:00:00Z'),
};
const now = new Date('2026-09-19T19:00:00Z');
const form = {
  market_date_id: 'wlrfm_2026-09-19',
  market_id: 'wlrfm',
  producer_id: 'p1',
  token_id: 'tok1',
  input: {
    attending_next: false,
    bringing_next: 'tomatoes, eggs',
    sold_out: 'peppers',
    unsold: '',
    estimated_sales: '$120',
    transactions_estimate: '14',
    feedback: 'great day',
    extra_answers: {},
  },
  now,
};

const ID = 'wlrfm_2026-09-19_p1';

describe('texted YES racing a form submission', () => {
  it('SMS first, form second: the form fills in the stub', async () => {
    const db = fakeDb();
    const sms = await recordAttendingNext(db as never, open, true, 'YES', now);
    expect(sms.created).toBe(true);
    await upsertFormCheckin(db as never, form);
    const doc = db.dump('checkins')[ID]!;
    expect(db.count('checkins')).toBe(1);
    expect(doc.feedback).toBe('great day');
    expect(doc.bringing_next).toEqual(['tomatoes', 'eggs']);
    expect(doc.attending_next).toBe(false); // the form's answer is the later one
    expect(doc.partial).toBe(false);
  });

  it('form first, SMS second: only the texted answer changes', async () => {
    const db = fakeDb();
    await upsertFormCheckin(db as never, form);
    const sms = await recordAttendingNext(db as never, open, true, 'YES', now);
    expect(sms.created).toBe(false);
    const doc = db.dump('checkins')[ID]!;
    expect(db.count('checkins')).toBe(1);
    expect(doc.feedback).toBe('great day');
    expect(doc.attending_next).toBe(true);
    expect(doc.attending_next_raw).toBe('YES');
    expect(doc.partial).toBe(false);
    expect(doc.source).toBe('form');
  });

  it('both at once, either order: one check-in, the form answers survive', async () => {
    for (const order of ['sms-first', 'form-first'] as const) {
      const db = fakeDb();
      const sms = () => recordAttendingNext(db as never, open, true, 'YES', now);
      const post = () => upsertFormCheckin(db as never, form);
      await Promise.all(order === 'sms-first' ? [sms(), post()] : [post(), sms()]);
      const doc = db.dump('checkins')[ID]!;
      expect(db.count('checkins'), order).toBe(1);
      expect(doc.feedback, order).toBe('great day');
      expect(doc.bringing_next, order).toEqual(['tomatoes', 'eggs']);
      expect(doc.partial, order).toBe(false);
      expect(typeof doc.attending_next, order).toBe('boolean');
    }
  });
});
