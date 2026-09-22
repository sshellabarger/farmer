// Personal reminders (decision D6) now send through the logged sendSms: the
// `messages` row (kind 'reminder', reminder_id) is the audit trail, the v1
// `notifications` write is gone, and last_sent_date moves only on success.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../src/config/env.js';
import { processDueReminders } from '../src/services/reminders.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { fakeDb } from './helpers/fake-db.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'vm-1') }));
// push.ts pulls in firebase-admin/messaging; reminders only fire-and-forget it.
vi.mock('../src/services/push.js', () => ({ sendPushToUser: vi.fn(async () => true) }));
const voipms = vi.mocked(voipmsSend);

const base = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  VOIPMS_DID: '5015550999',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as unknown as Env;
const production = { ...base, SMS_PROVIDER: 'voipms', NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' } as Env;

const USER_PHONE = '+15015550100';
// Wednesday 2026-06-10 10:05 America/Chicago (CDT, UTC-5).
const NOW = new Date('2026-06-10T15:05:00Z');

function seeded(reminder: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  return fakeDb({
    users: { u1: { phone: USER_PHONE, name: 'Test User', role: 'farmer', ...user } },
    reminders: { r1: { user_id: 'u1', title: 'Water the beds', frequency: 'daily', time: '10:00', active: true, ...reminder } },
  });
}
const asFirestore = (db: ReturnType<typeof fakeDb>) => db as unknown as Firestore;
const messages = (db: ReturnType<typeof fakeDb>) => Object.values(db.dump('messages'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  voipms.mockClear();
  voipms.mockImplementation(async () => 'vm-1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('processDueReminders', () => {
  it('a due reminder sends via the provider and writes a messages row with reminder_id — and no notifications doc', async () => {
    const db = seeded();
    const result = await processDueReminders(asFirestore(db), production);

    expect(result).toEqual({ checked: 1, sent: 1 });
    expect(voipms).toHaveBeenCalledTimes(1);
    expect(voipms.mock.calls[0][0]).toMatchObject({ to: USER_PHONE });
    expect(String(voipms.mock.calls[0][0].body)).toContain('Water the beds');

    const logged = messages(db);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      direction: 'outbound',
      to: USER_PHONE,
      kind: 'reminder',
      reminder_id: 'r1',
      user_id: 'u1',
      status: 'sent',
      provider: 'voipms',
      provider_message_id: 'vm-1',
    });
    expect(Object.keys(db.dump('notifications'))).toHaveLength(0);
    expect(db.dump('reminders').r1.last_sent_date).toBe('2026-06-10');
  });

  it('under the console provider the row is simulated and the reminder still counts as sent', async () => {
    const db = seeded();
    const result = await processDueReminders(asFirestore(db), base);

    expect(result.sent).toBe(1);
    expect(voipms).not.toHaveBeenCalled();
    expect(messages(db)[0]).toMatchObject({ kind: 'reminder', reminder_id: 'r1', status: 'simulated', provider: 'console' });
    expect(db.dump('reminders').r1.last_sent_date).toBe('2026-06-10');
  });

  it('an opted-out user is skipped: no send, no row, last_sent_date untouched', async () => {
    const db = seeded({}, { sms_opt_out_at: new Date('2026-06-01T00:00:00Z') });
    const result = await processDueReminders(asFirestore(db), production);

    expect(result).toEqual({ checked: 1, sent: 0 });
    expect(voipms).not.toHaveBeenCalled();
    expect(messages(db)).toHaveLength(0);
    expect(db.dump('reminders').r1.last_sent_date).toBeUndefined();
  });

  it('a provider failure leaves last_sent_date untouched and records a failed row', async () => {
    voipms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: invalid_dst');
    });
    const db = seeded();
    const result = await processDueReminders(asFirestore(db), production);

    expect(result).toEqual({ checked: 1, sent: 0 });
    expect(db.dump('reminders').r1.last_sent_date).toBeUndefined();
    expect(messages(db)).toHaveLength(1);
    expect(messages(db)[0]).toMatchObject({ kind: 'reminder', reminder_id: 'r1', status: 'failed' });
    expect(String(messages(db)[0].error)).toContain('invalid_dst');
  });

  it('a real provider without the flag is blocked: nothing sent, last_sent_date untouched', async () => {
    const db = seeded();
    const env = { ...production, ALLOW_REAL_SENDS: 'false' } as Env;
    const result = await processDueReminders(asFirestore(db), env);

    expect(result.sent).toBe(0);
    expect(voipms).not.toHaveBeenCalled();
    expect(messages(db)).toHaveLength(0);
    expect(db.dump('reminders').r1.last_sent_date).toBeUndefined();
  });

  it('skips reminders already sent today, outside the catch window, or on another weekday', async () => {
    const db = fakeDb({
      users: { u1: { phone: USER_PHONE } },
      reminders: {
        sent_today: { user_id: 'u1', title: 'A', frequency: 'daily', time: '10:00', active: true, last_sent_date: '2026-06-10' },
        too_early: { user_id: 'u1', title: 'B', frequency: 'daily', time: '10:30', active: true },
        too_late: { user_id: 'u1', title: 'C', frequency: 'daily', time: '09:00', active: true },
        wrong_day: { user_id: 'u1', title: 'D', frequency: 'weekly', schedule_days: 'mon,fri', time: '10:00', active: true },
        right_day: { user_id: 'u1', title: 'E', frequency: 'weekly', schedule_days: 'wed', time: '10:00', active: true },
      },
    });
    const result = await processDueReminders(asFirestore(db), base);

    expect(result).toEqual({ checked: 5, sent: 1 });
    expect(messages(db)).toHaveLength(1);
    expect(messages(db)[0]).toMatchObject({ reminder_id: 'right_day' });
  });
});
