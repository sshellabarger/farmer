import { describe, it, expect, vi } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { processMarketDates, computeSchedule, listRecipients, TEMPLATES } from '../src/services/checkin-workflow.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../src/services/markets.js';
import type { FarmersMarket } from '../src/services/markets.js';
import { splitMessage } from '../src/services/sms.js';
import type { Env } from '../src/config/env.js';

// Contract §7 test env: console providers, so nothing can leave this process.
const env = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example',
  VOIPMS_DID: '5015550999',
  ALERT_EMAIL: 'alerts@example.com',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as Env;

function wlrfmMarket(overrides: Partial<FarmersMarket> = {}): FarmersMarket {
  return {
    id: 'wlrfm',
    name: 'West Little Rock Farmers Market',
    slug: 'wlrfm',
    location: { name: 'Breckenridge Village', address: '' },
    timezone: 'America/Chicago',
    schedule: { versions: [], skipped_dates: [], special_dates: [] },
    workflow: DEFAULT_WORKFLOW,
    quiet_hours: DEFAULT_QUIET_HOURS,
    active: true,
    created_by: 'test',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

function argentaMarket(overrides: Partial<FarmersMarket> = {}): FarmersMarket {
  return wlrfmMarket({ id: 'argenta', name: 'Argenta Farmers Market', slug: 'argenta', ...overrides });
}

function baseWlrfmActions() {
  return {
    checkin_sent_at: null,
    reminders_sent: [],
    deadline_at: new Date('2026-09-22T17:00:00Z'),
    deadline_processed_at: null,
    drafts_generated_at: null,
    approved_at: null,
    booth_texts_sent_at: null,
  };
}

function wlrfmDate(overrides: Record<string, unknown> = {}) {
  return {
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
    actions: baseWlrfmActions(),
    extra_questions: [],
    sponsor_id: null,
    cancellation_reason: null,
    cancelled_at: null,
    cancelled_by: null,
    generated_at: new Date('2026-09-01'),
    source: 'import',
    created_at: new Date('2026-09-01'),
    updated_at: new Date('2026-09-01'),
    ...overrides,
  };
}

function argentaDate(overrides: Record<string, unknown> = {}) {
  return {
    market_id: 'argenta',
    date: '2026-09-17',
    start_time: '17:00',
    end_time: '20:00',
    start_at: new Date('2026-09-17T22:00:00Z'),
    end_at: new Date('2026-09-18T01:00:00Z'),
    status: 'collecting',
    schedule_version: 'v1',
    special: false,
    note: '',
    actions: {
      checkin_sent_at: null,
      reminders_sent: [],
      deadline_at: new Date('2026-09-21T01:00:00Z'),
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
    generated_at: new Date('2026-09-01'),
    source: 'import',
    created_at: new Date('2026-09-01'),
    updated_at: new Date('2026-09-01'),
    ...overrides,
  };
}

function seedProducers() {
  return {
    p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
    p2: { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: '+15015550102', active: true },
    p3: { business_name: 'Gamma Farm', contact_name: 'Gail Grape', phone: null, active: true },
    p4: { business_name: 'Delta Farm', contact_name: 'Dan Date', phone: '+15015550104', active: true, sms_opt_out_at: new Date('2026-08-01') },
    p5: { business_name: 'Epsilon Farm', contact_name: 'Eve Elder', phone: '+15015550105', active: true },
    p6: { business_name: 'Zeta Farm', contact_name: 'Zoe Zin', phone: '+15015550106', active: false },
  };
}

function seedMemberships() {
  return {
    p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
    p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
    p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
    p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', status: 'active' },
    p5_wlrfm: { producer_id: 'p5', market_id: 'wlrfm', status: 'inactive' },
    p6_wlrfm: { producer_id: 'p6', market_id: 'wlrfm', status: 'active' },
    p1_argenta: { producer_id: 'p1', market_id: 'argenta', status: 'active' },
    p2_argenta: { producer_id: 'p2', market_id: 'argenta', status: 'active' },
  };
}

function seedUsers() {
  return {
    admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
    mgr_w: { name: 'WLRFM Manager', role: 'market_manager', phone: '+15015550002', assigned_market_ids: ['wlrfm'] },
    mgr_a: { name: 'Argenta Manager', role: 'market_manager', phone: '+15015550003', assigned_market_ids: ['argenta'] },
    nophone: { name: 'No Phone Admin', role: 'admin', phone: null },
  };
}

function seed(opts: {
  wlrfmDateOverrides?: Record<string, unknown>;
  includeArgenta?: boolean;
  extraDates?: Record<string, Record<string, unknown>>;
  producers?: Record<string, Record<string, unknown>>;
  memberships?: Record<string, Record<string, unknown>>;
  marketActive?: boolean;
} = {}) {
  const market_dates: Record<string, Record<string, unknown>> = {
    'wlrfm_2026-09-19': wlrfmDate(opts.wlrfmDateOverrides),
    ...(opts.includeArgenta ? { 'argenta_2026-09-17': argentaDate() } : {}),
    ...(opts.extraDates ?? {}),
  };
  return fakeDb({
    farmers_markets: {
      wlrfm: wlrfmMarket({ active: opts.marketActive ?? true }) as unknown as Record<string, unknown>,
      argenta: argentaMarket() as unknown as Record<string, unknown>,
    },
    market_dates,
    producers: opts.producers ?? seedProducers(),
    producer_memberships: opts.memberships ?? seedMemberships(),
    users: seedUsers(),
  });
}

function kindMessages(db: ReturnType<typeof fakeDb>, kind: string) {
  return Object.values(db.dump('messages')).filter((m) => (m as Record<string, unknown>).kind === kind) as Record<string, unknown>[];
}

describe('processMarketDates — Saturday timeline (wlrfm)', () => {
  it('checkin -> reminders -> deadline -> summary, idempotent on repeat runs', async () => {
    const db = seed();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T17:59:00Z') });
    expect(db.count('messages')).toBe(0);

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:00:00Z') });
    let linkMsgs = kindMessages(db, 'checkin_link');
    expect(linkMsgs).toHaveLength(2);
    expect(linkMsgs.map((m) => m.producer_id).sort()).toEqual(['p1', 'p2']);
    for (const m of linkMsgs) {
      expect(m.body as string).toContain('/checkin?t=');
      expect(m.body as string).toContain('Tue Sep 22, 12:00 PM');
    }
    const tokens = db.dump('link_tokens');
    expect(Object.keys(tokens)).toHaveLength(2);
    for (const t of Object.values(tokens)) {
      const tok = t as Record<string, unknown>;
      expect((tok.expires_at as Date).toISOString()).toBe('2026-09-25T17:00:00.000Z');
      expect(tok.created_by).toBe('engine');
      expect(tok.sent_message_id).toBeTruthy();
    }
    let dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    let actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(new Date('2026-09-19T18:00:00Z'));
    expect(actions.checkin_recipients).toBe(2);
    expect((actions.claims as Record<string, unknown>).checkin).toEqual(new Date('2026-09-19T18:00:00Z'));

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:01:00Z') });
    expect(kindMessages(db, 'checkin_link')).toHaveLength(2);

    await db.collection('checkins').doc('wlrfm_2026-09-19_p1').set({
      producer_id: 'p1',
      market_id: 'wlrfm',
      market_date_id: 'wlrfm_2026-09-19',
      submitted_at: new Date('2026-09-19T19:00:00Z'),
      source: 'form',
      token_id: 'x',
      estimated_sales: { value: null, raw: '', kind: 'none' },
      transactions_estimate: { value: null, raw: '' },
      sold_out_items: [],
      sold_out_raw: '',
      unsold_items: [],
      unsold_raw: '',
      attending_next: true,
      attending_next_raw: 'yes',
      bringing_next: [],
      bringing_next_raw: '',
      feedback: '',
      extra_answers: {},
      flags: [],
      raw_import: null,
      submissions: 1,
      partial: false,
      created_at: new Date('2026-09-19T19:00:00Z'),
      updated_at: new Date('2026-09-19T19:00:00Z'),
    });

    await processMarketDates(db as never, env, { now: new Date('2026-09-20T17:00:00Z') });
    let reminderMsgs = kindMessages(db, 'checkin_reminder');
    expect(reminderMsgs).toHaveLength(1);
    expect(reminderMsgs[0]!.producer_id).toBe('p2');
    expect(reminderMsgs[0]!.offset_min).toBe(1440);
    dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    actions = dateDoc.actions as Record<string, unknown>;
    let remindersSent = actions.reminders_sent as Record<string, unknown>[];
    expect(remindersSent).toHaveLength(1);
    expect(remindersSent[0]).toMatchObject({ offset_min: 1440, recipients: 1, failed: 0, skipped: null });
    const p2TokenCountAfter1 = Object.values(db.dump('link_tokens')).filter((t) => (t as Record<string, unknown>).producer_id === 'p2').length;
    expect(p2TokenCountAfter1).toBe(1); // reused p2's existing token, no new mint

    await processMarketDates(db as never, env, { now: new Date('2026-09-21T17:00:00Z') });
    reminderMsgs = kindMessages(db, 'checkin_reminder');
    expect(reminderMsgs).toHaveLength(2);
    dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    actions = dateDoc.actions as Record<string, unknown>;
    remindersSent = actions.reminders_sent as Record<string, unknown>[];
    expect(remindersSent).toHaveLength(2);
    expect(remindersSent[1]).toMatchObject({ offset_min: 2880, recipients: 1 });

    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:00:00Z') });
    dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.deadline_processed_at).toEqual(new Date('2026-09-22T17:00:00Z'));
    expect(dateDoc.non_responders).toEqual(['p2']);
    expect(dateDoc.spot_not_held).toEqual(['p2']);
    expect(dateDoc.deadline_recipient_count).toBe(2);
    expect(dateDoc.deadline_responded_count).toBe(1);

    const summaryMsgs = kindMessages(db, 'deadline_summary');
    expect(summaryMsgs).toHaveLength(2);
    expect(summaryMsgs.map((m) => m.user_id).sort()).toEqual(['admin1', 'mgr_w']);
    for (const m of summaryMsgs) {
      expect(m.body as string).toContain('1 of 2 responded');
      expect(m.body as string).toContain('Beta Farm');
    }
    expect(actions.summary_sent_at).toEqual(new Date('2026-09-22T17:00:00Z'));

    const emailLogs = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('[email:console]') && args[1] === env.ALERT_EMAIL);
    expect(emailLogs).toHaveLength(1);

    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:05:00Z') });
    expect(Object.keys(db.dump('messages'))).toHaveLength(6);

    logSpy.mockRestore();
  });
});

describe('processMarketDates — Thursday timeline (argenta), same engine code', () => {
  it('quiet-hours defers the check-in text; deadline and summary fire in the same run', async () => {
    const db = seed({ includeArgenta: true, wlrfmDateOverrides: { status: 'lineup_final' } });

    const market = argentaMarket();
    const date = argentaDate() as never;
    const schedule = computeSchedule(market, date);
    expect(schedule.checkin_at.toISOString()).toBe('2026-09-18T02:00:00.000Z');
    expect(schedule.checkin_effective_at.toISOString()).toBe('2026-09-18T13:00:00.000Z');
    expect(schedule.deadline_at.toISOString()).toBe('2026-09-21T01:00:00.000Z');

    await processMarketDates(db as never, env, { now: new Date('2026-09-18T02:00:00Z') });
    expect(db.count('messages')).toBe(0);

    await processMarketDates(db as never, env, { now: new Date('2026-09-18T13:00:00Z') });
    expect(kindMessages(db, 'checkin_link')).toHaveLength(2);

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T01:00:00Z') });
    // Neither p1 nor p2 has checked in yet, so both receive the 1440 reminder.
    const reminders = kindMessages(db, 'checkin_reminder').filter((m) => m.market_date_id === 'argenta_2026-09-17');
    expect(reminders).toHaveLength(2);
    expect(reminders.every((m) => m.offset_min === 1440)).toBe(true);

    await processMarketDates(db as never, env, { now: new Date('2026-09-21T01:00:00Z') });
    const dateDoc = db.dump('market_dates')['argenta_2026-09-17']! as Record<string, unknown>;
    const actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.deadline_processed_at).toEqual(new Date('2026-09-21T01:00:00Z'));
    const summaries = kindMessages(db, 'deadline_summary').filter((m) => m.market_date_id === 'argenta_2026-09-17');
    expect(summaries.map((m) => m.user_id).sort()).toEqual(['admin1', 'mgr_a']);
  });
});

describe('processMarketDates — late-deploy supersede', () => {
  it('a checkin sent after both reminder slots supersedes both, without sending either', async () => {
    // Deviation from the contract's literal example timestamp (2026-09-21T12:00Z,
    // which precedes the 2880-minute reminder's own natural instant and so cannot
    // by itself supersede it): this run is chosen to land after BOTH reminder
    // instants (Sun noon and Mon noon CDT) so the "checkin went out late, after
    // this slot" rule (§3.3) legitimately supersedes both in one run.
    const db = seed();
    await processMarketDates(db as never, env, { now: new Date('2026-09-21T20:00:00Z') });

    const dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    const actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(new Date('2026-09-21T20:00:00Z'));
    const remindersSent = actions.reminders_sent as Record<string, unknown>[];
    expect(remindersSent).toHaveLength(2);
    expect(remindersSent.every((r) => r.skipped === 'superseded')).toBe(true);
    expect(kindMessages(db, 'checkin_reminder')).toHaveLength(0);
    expect(kindMessages(db, 'checkin_link')).toHaveLength(2); // the checkin itself still sends
  });
});

describe('processMarketDates — after the deadline, nothing producer-facing is sent', () => {
  it('first run past the deadline: no checkin/reminder texts, deadline+summary still process', async () => {
    const db = seed();
    await processMarketDates(db as never, env, { now: new Date('2026-09-22T18:00:00Z') });

    expect(kindMessages(db, 'checkin_link')).toHaveLength(0);
    expect(kindMessages(db, 'checkin_reminder')).toHaveLength(0);
    const dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    const actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toBeNull();
    expect(actions.deadline_processed_at).toEqual(new Date('2026-09-22T18:00:00Z'));
    expect(dateDoc.deadline_recipient_count).toBe(2);
    expect(dateDoc.deadline_responded_count).toBe(0);
    expect(kindMessages(db, 'deadline_summary')).toHaveLength(2);
  });
});

describe('processMarketDates — past-date guard', () => {
  it('a collecting date more than 7 days old is scanned but never considered, and untouched', async () => {
    const db = seed({
      extraDates: {
        'wlrfm_2026-03-21': wlrfmDate({ date: '2026-03-21', start_at: new Date('2026-03-21T13:00:00Z'), end_at: new Date('2026-03-21T17:00:00Z') }),
      },
      wlrfmDateOverrides: { status: 'lineup_final' }, // keep only the March date 'collecting'
    });
    const before = JSON.stringify(db.dump('market_dates')['wlrfm_2026-03-21']);

    const result = await processMarketDates(db as never, env, { now: new Date('2026-09-21T12:00:00Z') });
    expect(result.scanned).toBe(1);
    expect(result.considered).toBe(0);
    expect(db.count('messages')).toBe(0);
    const after = JSON.stringify(db.dump('market_dates')['wlrfm_2026-03-21']);
    expect(after).toBe(before);
  });
});

describe('processMarketDates — zero recipients is silent', () => {
  it('no producer has a phone: no texts, no email, but the date is still marked handled', async () => {
    const producers = seedProducers();
    for (const p of Object.values(producers)) delete (p as Record<string, unknown>).phone;
    const db = seed({ producers: producers as never });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:00:00Z') });
    let dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    let actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.checkin_sent_at).toEqual(new Date('2026-09-19T18:00:00Z'));
    expect(actions.checkin_recipients).toBe(0);

    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:00:00Z') });
    dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    actions = dateDoc.actions as Record<string, unknown>;
    expect(actions.deadline_processed_at).toEqual(new Date('2026-09-22T17:00:00Z'));
    expect(actions.summary_skipped).toBe('no_recipients');
    expect(actions.summary_sent_at).toBeNull();
    expect(db.count('messages')).toBe(0);
    const emailLogs = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('[email:console]'));
    expect(emailLogs).toHaveLength(0);

    logSpy.mockRestore();
  });
});

describe('listRecipients — exclusions', () => {
  it('reports the right reason for each excluded producer', async () => {
    const producers = { ...seedProducers(), p7: { business_name: 'Eta Farm', contact_name: '', phone: '501-555-0107', active: true } };
    const memberships = { ...seedMemberships(), p7_wlrfm: { producer_id: 'p7', market_id: 'wlrfm', status: 'active' } };
    const db = seed({ producers, memberships });

    const { recipients, excluded } = await listRecipients(db as never, 'wlrfm');
    expect(recipients.map((r) => r.producer_id)).toEqual(['p1', 'p2']);
    expect(excluded.find((e) => e.producer_id === 'p3')?.reason).toBe('no_phone');
    expect(excluded.find((e) => e.producer_id === 'p4')?.reason).toBe('opted_out');
    expect(excluded.find((e) => e.producer_id === 'p6')?.reason).toBe('inactive_producer');
    expect(excluded.find((e) => e.producer_id === 'p7')?.reason).toBe('invalid_phone');
    expect(excluded.find((e) => e.producer_id === 'p5')).toBeUndefined(); // inactive membership — absent from both
    expect(recipients.find((r) => r.producer_id === 'p5')).toBeUndefined();
  });
});

describe('processMarketDates — idempotency across overlapping runs', () => {
  // Phase 3 fix: the guard is the atomic `workflow_locks/<date>__<key>` doc,
  // not `actions.claims` (which is still written, for the status page only).
  function lock(key: string, claimedAt: Date) {
    return { market_date_id: 'wlrfm_2026-09-19', key, claimed_at: claimedAt, run_id: 'previous-run', created_at: claimedAt };
  }

  it('a fresh, unexpired checkin lock blocks a concurrent run; a stale lock is taken over and the messages dedupe holds', async () => {
    const db = seed({
      wlrfmDateOverrides: {
        actions: { ...baseWlrfmActions(), claims: { checkin: new Date('2026-09-19T17:57:00Z') } },
      },
    });
    await db.collection('workflow_locks').doc('wlrfm_2026-09-19__checkin').set(lock('checkin', new Date('2026-09-19T17:57:00Z')));
    const result = await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:00:00Z') });
    expect(result.skipped_claimed).toBe(1);
    expect(db.count('messages')).toBe(0);

    // Age the lock past its TTL and seed a queued row for p1, simulating a
    // previous run that locked, sent to p1, then died before writing checkin_sent_at.
    await db.collection('workflow_locks').doc('wlrfm_2026-09-19__checkin').set(lock('checkin', new Date('2026-09-19T17:49:00Z')));
    await db.collection('messages').doc('checkin_link:wlrfm_2026-09-19:p1').set({
      direction: 'outbound', to: '+15015550101', from: 'console', body: 'x', provider: 'console', provider_message_id: 'console-m1',
      status: 'queued', status_at: new Date(), error: null, kind: 'checkin_link', segments: 1,
      producer_id: 'p1', market_date_id: 'wlrfm_2026-09-19', user_id: null, sent_by: null, created_at: new Date('2026-09-19T17:59:00Z'),
    });

    await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:00:00Z') });
    const linkMsgs = kindMessages(db, 'checkin_link');
    const p1Msgs = linkMsgs.filter((m) => m.producer_id === 'p1');
    const p2Msgs = linkMsgs.filter((m) => m.producer_id === 'p2');
    expect(p1Msgs).toHaveLength(1); // the pre-seeded queued row, not re-sent
    expect(p2Msgs).toHaveLength(1); // newly sent this run
    const dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    expect((dateDoc.actions as Record<string, unknown>).checkin_sent_at).toEqual(new Date('2026-09-19T18:00:00Z'));
    const takenOver = db.dump('workflow_locks')['wlrfm_2026-09-19__checkin']! as Record<string, unknown>;
    expect(takenOver.taken_over_from).toBe('previous-run');
    expect(takenOver.claimed_at).toEqual(new Date('2026-09-19T18:00:00Z'));
  });

  it('a stale informational claim on the market_date alone never blocks (the lock doc is the guard)', async () => {
    const db = seed({
      wlrfmDateOverrides: {
        actions: { ...baseWlrfmActions(), claims: { checkin: new Date('2026-09-19T17:57:00Z') } },
      },
    });
    const result = await processMarketDates(db as never, env, { now: new Date('2026-09-19T18:00:00Z') });
    expect(result.skipped_claimed).toBe(0);
    expect(kindMessages(db, 'checkin_link')).toHaveLength(2);
    const created = db.dump('workflow_locks')['wlrfm_2026-09-19__checkin']! as Record<string, unknown>;
    expect(created).toMatchObject({ key: 'checkin', market_date_id: 'wlrfm_2026-09-19' });
    expect(created).not.toHaveProperty('taken_over_from'); // created fresh, not taken over
  });

  it('a fresh deadline lock blocks a concurrent run; a stale one is taken over without a second summary', async () => {
    const db = seed({
      wlrfmDateOverrides: {
        actions: {
          ...baseWlrfmActions(),
          checkin_sent_at: new Date('2026-09-19T18:00:00Z'),
          claims: { deadline: new Date('2026-09-22T16:58:00Z') },
        },
      },
    });
    await db.collection('workflow_locks').doc('wlrfm_2026-09-19__deadline').set(lock('deadline', new Date('2026-09-22T16:58:00Z')));
    const result = await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:00:00Z') });
    expect(result.skipped_claimed).toBeGreaterThanOrEqual(1);
    let dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    expect((dateDoc.actions as Record<string, unknown>).deadline_processed_at).toBeNull();

    await db.collection('workflow_locks').doc('wlrfm_2026-09-19__deadline').set(lock('deadline', new Date('2026-09-22T16:48:00Z')));
    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:00:00Z') });
    dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    expect((dateDoc.actions as Record<string, unknown>).deadline_processed_at).toEqual(new Date('2026-09-22T17:00:00Z'));
    expect(kindMessages(db, 'deadline_summary')).toHaveLength(2);

    // Running again must not double the summary.
    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:05:00Z') });
    expect(kindMessages(db, 'deadline_summary')).toHaveLength(2);
  });

  it('a stale summary lock is taken over: texts are re-attempted (refused as duplicates) but the email is not re-sent', async () => {
    // A previous run created the summary lock, texted admin1 + mgr_w, emailed,
    // then died before writing summary_sent_at.
    const db = seed({
      wlrfmDateOverrides: {
        non_responders: ['p1', 'p2'],
        spot_not_held: ['p1', 'p2'],
        deadline_recipient_count: 2,
        deadline_responded_count: 0,
        actions: {
          ...baseWlrfmActions(),
          checkin_sent_at: new Date('2026-09-19T18:00:00Z'),
          deadline_processed_at: new Date('2026-09-22T17:00:00Z'),
          claims: { deadline: new Date('2026-09-22T17:00:00Z'), summary: new Date('2026-09-22T17:00:00Z') },
        },
      },
    });
    await db.collection('workflow_locks').doc('wlrfm_2026-09-19__summary').set(lock('summary', new Date('2026-09-22T17:00:00Z')));
    for (const userId of ['admin1', 'mgr_w']) {
      await db.collection('messages').doc(`deadline_summary:wlrfm_2026-09-19:${userId}`).set({
        direction: 'outbound', to: 'x', from: 'console', body: 'x', provider: 'console', provider_message_id: 'y',
        status: 'simulated', status_at: new Date(), error: null, kind: 'deadline_summary', segments: 1,
        producer_id: null, market_date_id: 'wlrfm_2026-09-19', user_id: userId, sent_by: null, created_at: new Date('2026-09-22T17:00:00Z'),
      });
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await processMarketDates(db as never, env, { now: new Date('2026-09-22T17:11:00Z') });

    expect(kindMessages(db, 'deadline_summary')).toHaveLength(2); // the two seeded rows, nothing new
    const emailLogs = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('[email:console]'));
    expect(emailLogs).toHaveLength(0);
    const dateDoc = db.dump('market_dates')['wlrfm_2026-09-19']! as Record<string, unknown>;
    expect((dateDoc.actions as Record<string, unknown>).summary_sent_at).toEqual(new Date('2026-09-22T17:11:00Z'));
    logSpy.mockRestore();
  });
});

describe('processMarketDates — inactive market / cancelled date', () => {
  it('an inactive market is never considered; a cancelled date is never scanned', async () => {
    const db = seed({ marketActive: false, extraDates: { 'wlrfm_2026-09-26': wlrfmDate({ date: '2026-09-26', status: 'cancelled' }) } });
    const result = await processMarketDates(db as never, env, { now: new Date('2026-09-22T18:00:00Z') });
    expect(result.scanned).toBe(1); // the cancelled date's status !== 'collecting', so the query excludes it
    expect(result.considered).toBe(0);
    expect(db.count('messages')).toBe(0);
  });
});

describe('TEMPLATES', () => {
  const long40 = 'A'.repeat(40);
  const longFirst20 = 'B'.repeat(20);

  it('every body stays within 2 GSM-7 segments and is pure ASCII', () => {
    const bodies = [
      TEMPLATES.checkin_link({ market_name: long40, first_name: longFirst20, deadline_label: 'Tue Sep 22, 12:00 PM', link: 'https://test.example/checkin?t=' + 'x'.repeat(43) }),
      TEMPLATES.checkin_reminder({ market_name: long40, deadline_label: 'Tue Sep 22, 12:00 PM', link: 'https://test.example/checkin?t=' + 'x'.repeat(43) }),
      TEMPLATES.deadline_summary({ market_name: long40, date_short: 'Sat Sep 19', responded: 1, recipients: 2, non_responder_names: ['Beta Farm'], admin_link: 'https://test.example/admin/market-dates?id=wlrfm_2026-09-19' }),
    ];
    for (const body of bodies) {
      expect(splitMessage(body).length).toBeLessThanOrEqual(2);
      expect(/^[\x20-\x7e\n]*$/.test(body)).toBe(true);
    }
  });

  it('the summary greedily fits non-responder names within 300 chars, ending with ", +N more. Details: ..."', () => {
    const names = Array.from({ length: 12 }, (_, i) => `Very Long Farm Business Name Number ${i + 1} LLC`);
    const body = TEMPLATES.deadline_summary({
      market_name: 'West Little Rock Farmers Market',
      date_short: 'Sat Sep 19',
      responded: 2,
      recipients: 14,
      non_responder_names: names,
      admin_link: 'https://test.example/admin/market-dates?id=wlrfm_2026-09-19',
    });
    expect(body.length).toBeLessThanOrEqual(300);
    expect(body).toMatch(/, \+\d+ more\. Details: /);
  });

  it('an empty non-responder list reads "Everyone responded." with no "No response:" clause', () => {
    const body = TEMPLATES.deadline_summary({
      market_name: 'WLRFM', date_short: 'Sat Sep 19', responded: 2, recipients: 2, non_responder_names: [], admin_link: 'https://test.example/x',
    });
    expect(body).toContain('Everyone responded.');
    expect(body).not.toContain('No response:');
  });

  it('checkin_link omits the name and its comma when first_name is empty', () => {
    const body = TEMPLATES.checkin_link({ market_name: 'WLRFM', first_name: '', deadline_label: 'Tue Sep 22, 12:00 PM', link: 'https://test.example/checkin?t=x' });
    expect(body).toContain('thanks for selling at WLRFM!');
    expect(body).not.toContain('WLRFM,');
  });
});
