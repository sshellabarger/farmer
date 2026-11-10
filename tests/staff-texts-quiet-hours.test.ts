// Fix X5: texts that staff trigger (the invitation to re-apply, the acceptance,
// the agreement link) respect the market's quiet hours and the application
// window. Emails still go; the text is held and a later run sends exactly what
// is missing. Driven through the real buildApp() with the console providers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { P1_PHONE, T_OPEN, adminAuth, boot, env, rowsOfKind, seed, validSubmission, type Db } from './helpers/a1-fixtures.js';
import { planInvite, inviteFromData } from '../src/services/invites.js';
import { issueAgreementLink, loadAgreementContext } from '../src/services/agreements.js';
import { quietUntil } from '../src/services/markets.js';

// The fixture market keeps the default quiet window, 21:00-08:00 America/Chicago (CST in December, UTC-6).
const NIGHT = new Date('2026-12-16T04:30:00Z'); // 22:30 on the 15th
const STILL_NIGHT = new Date('2026-12-16T13:59:59Z'); // 07:59:59 on the 16th
const MORNING = new Date('2026-12-16T14:00:00Z'); // 08:00:00 on the 16th: the window's end is allowed
const QUIET_ENDS = '2026-12-16T14:00:00.000Z';

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emailPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[email:console]'));
const invite = (app: FastifyInstance, producer = 'p1', qs = '') =>
  app.inject({ method: 'POST', url: `/api/producers/${producer}/invite?market_id=wlrfm${qs}`, headers: adminAuth() });
const bulk = (app: FastifyInstance, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/markets/wlrfm/invite-reapply', headers: adminAuth(), payload: payload as never });
const inviteDoc = (db: Db, producer = 'p1') => db.dump('application_invites')[`wlrfm_2027_${producer}`] as Record<string, any>;

const person = (name: string, extra: Record<string, unknown> = {}) => ({
  business_name: name,
  contact_name: `${name.split(' ')[0]} Owner`,
  aliases: [],
  active: true,
  sms_opt_out_at: null,
  ...extra,
});

/** p1 with an email and a phone. */
function withPhone(marketOver: Record<string, unknown> = {}): Db {
  return seed({ producers: { p1: person('Testfield Farm', { email: 'owner@testfield.example', emails: ['owner@testfield.example'], phone: P1_PHONE }) } }, marketOver);
}

/** Four returning vendors: email only, email + phone, phone only, email + phone but opted out. */
function crowd(): Db {
  return seed({
    producers: {
      p1: person('Alpha Farm', { email: 'alpha@example.test', emails: ['alpha@example.test'], phone: null }),
      p2: person('Bravo Farm', { email: 'bravo@example.test', emails: ['bravo@example.test'], phone: '+15015550102' }),
      p3: person('Charlie Farm', { email: null, emails: [], phone: '+15015550103' }),
      p4: person('Delta Farm', { email: 'delta@example.test', emails: ['delta@example.test'], phone: '+15015550104', sms_opt_out_at: new Date('2026-10-01') }),
    },
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
      p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
      p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
      p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', status: 'active' },
    },
  });
}

describe('quietUntil', () => {
  const m = { timezone: 'America/Chicago', quiet_hours: { start: '21:00', end: '08:00' } };
  it('is null outside the window and the window end inside it, in the market timezone', () => {
    expect(quietUntil(m, T_OPEN)).toBeNull();
    expect(quietUntil(m, NIGHT)?.toISOString()).toBe(QUIET_ENDS);
    expect(quietUntil(m, STILL_NIGHT)?.toISOString()).toBe(QUIET_ENDS);
    expect(quietUntil(m, MORNING)).toBeNull();
    // The same instant is mid-evening in Los Angeles: not quiet there.
    expect(quietUntil({ ...m, timezone: 'America/Los_Angeles' }, new Date('2026-12-16T03:30:00Z'))).toBeNull();
    expect(quietUntil(m, new Date('2026-12-16T03:30:00Z'))).not.toBeNull();
  });

  it('falls back to the default window when the market has none or an unreadable one', () => {
    expect(quietUntil({ timezone: 'America/Chicago' } as never, NIGHT)?.toISOString()).toBe(QUIET_ENDS);
    expect(quietUntil({ timezone: 'America/Chicago', quiet_hours: { start: 'late', end: 'early' } }, NIGHT)?.toISOString()).toBe(QUIET_ENDS);
    expect(quietUntil({ timezone: 'America/Chicago', quiet_hours: { start: '08:00', end: '08:00' } }, NIGHT)).toBeNull(); // no window at all
  });
});

describe('invitations are only sent while applications are open', () => {
  it('POST /api/producers/:id/invite: 409 applications_not_open before the window, after it and with no season; nothing is written or sent', async () => {
    for (const season of [
      { label: '2027', application_open: '2027-01-05', application_close: null, schedule_version_id: 'v27' }, // opens in three weeks
      { label: '2027', application_open: '2026-11-01', application_close: '2026-12-14', schedule_version_id: 'v27' }, // closed yesterday
      null,
    ]) {
      const db = withPhone({ season });
      const app = await boot(db);
      const res = await invite(app);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('applications_not_open');
      expect(db.count('application_invites')).toBe(0);
      expect(db.count('link_tokens')).toBe(0);
      expect(db.count('messages')).toBe(0);
      expect(log.mock.calls).toHaveLength(0);
      // Forcing does not get round it.
      expect((await invite(app, 'p1', '&force=true')).statusCode).toBe(409);
    }
  });

  it('the window is the market calendar: open on the last day in the market timezone', async () => {
    const db = withPhone({ season: { label: '2027', application_open: '2026-12-01', application_close: '2026-12-15', schedule_version_id: 'v27' } });
    const app = await boot(db);
    vi.setSystemTime(new Date('2026-12-16T03:00:00Z')); // 21:00 on the 15th in Chicago: still the 15th there, the 16th in UTC
    expect((await invite(app)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-12-16T06:00:00Z')); // 00:00 on the 16th in Chicago
    expect((await invite(app, 'p1', '&force=true')).json().code).toBe('applications_not_open');
  });

  it('POST /api/markets/:id/invite-reapply: a real run is refused, a dry run still answers', async () => {
    const db = crowd();
    await db.collection('farmers_markets').doc('wlrfm').update({ season: { label: '2027', application_open: '2027-01-05', application_close: null, schedule_version_id: 'v27' } });
    const app = await boot(db);

    const real = await bulk(app);
    expect(real.statusCode).toBe(409);
    expect(real.json().code).toBe('applications_not_open');
    expect((await bulk(app, { force: true })).statusCode).toBe(409);

    const dry = await bulk(app, { dry_run: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ season: '2027', applications_open: false, candidates: 4, invited: 4 });

    expect(db.count('application_invites')).toBe(0);
    expect(db.count('link_tokens')).toBe(0);
    expect(db.count('messages')).toBe(0);
    expect(log.mock.calls).toHaveLength(0);
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'market.invite_reapply')).toHaveLength(0);

    // No season at all: there is nothing to preview either.
    await db.collection('farmers_markets').doc('wlrfm').update({ season: null });
    const none = await bulk(app, { dry_run: true });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('applications_not_open');
  });
});

describe('POST /api/producers/:id/invite during quiet hours', () => {
  it('sends the email, holds the text, and a re-run after quiet hours texts with the same token, once', async () => {
    const db = withPhone();
    const app = await boot(db);

    vi.setSystemTime(NIGHT);
    const first = await invite(app);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ completed: false, quiet_until: QUIET_ENDS, invite: { email_status: 'simulated', sms_status: 'skipped_quiet_hours', message_id: null } });
    expect(emailPrints()).toHaveLength(1);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(0);
    expect(db.count('messages')).toBe(0);
    expect(inviteDoc(db)).toMatchObject({ email_status: 'simulated', email_sent_at: NIGHT, sms_status: 'skipped_quiet_hours', sms_sent_at: null, phone: P1_PHONE });

    // Still quiet: nothing more to do, and the answer says when the text can go.
    vi.setSystemTime(STILL_NIGHT);
    const waiting = await invite(app);
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json()).toMatchObject({ error: 'Already invited', code: 'already_invited', quiet_until: QUIET_ENDS, invite: { sms_status: 'skipped_quiet_hours' } });
    expect(db.count('messages')).toBe(0);
    expect(emailPrints()).toHaveLength(1);

    // 08:00: the text goes, with the link the email carried, under the per-producer dedupe key. No second email.
    vi.setSystemTime(MORNING);
    const second = await invite(app);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ completed: true, quiet_until: null, url: first.json().url, invite: { sms_status: 'simulated', email_status: 'simulated' } });
    const texts = rowsOfKind(db, 'application_invite');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ id: 'application_invite:wlrfm:2027:p1', to: P1_PHONE, status: 'simulated' });
    expect(String(texts[0]!.body)).toContain(first.json().url);
    expect(emailPrints()).toHaveLength(1);
    expect(Object.values(db.dump('link_tokens'))).toHaveLength(1);
    expect(inviteDoc(db)).toMatchObject({
      token: new URL(first.json().url).searchParams.get('t'),
      email_sent_at: NIGHT,
      sms_status: 'simulated',
      sms_sent_at: MORNING,
      message_id: 'application_invite:wlrfm:2027:p1',
      resends: [],
      completions: [{ at: MORNING, by: 'admin1', email_status: null, sms_status: 'simulated' }],
    });

    // And then it is simply "already invited".
    const third = await invite(app);
    expect(third.statusCode).toBe(409);
    expect(third.json().quiet_until).toBeNull();
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);

    const audits = Object.values(db.dump('audit_log')).filter((a) => a.action === 'producer.invite_reapply');
    expect(audits.map((a) => (a.after as Record<string, unknown>).completed)).toEqual([false, true]);
  });

  it('two re-runs at once after quiet hours still send one text', async () => {
    const db = withPhone();
    const app = await boot(db);
    vi.setSystemTime(NIGHT);
    await invite(app);
    vi.setSystemTime(MORNING);
    const both = await Promise.all([invite(app), invite(app)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 200]);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[sms:console]'))).toHaveLength(1);
    expect(['simulated', 'duplicate']).toContain(inviteDoc(db).sms_status);
  });

  it('a producer who gained a phone number since the first invite gets the text on a re-run', async () => {
    const db = seed(); // p1: an email, no phone (the production shape)
    const app = await boot(db);
    const first = await invite(app);
    expect(first.json().invite).toMatchObject({ email_status: 'simulated', sms_status: 'skipped_no_phone' });
    expect((await invite(app)).statusCode).toBe(409); // nothing has changed yet

    await db.collection('producers').doc('p1').update({ phone: P1_PHONE });
    vi.setSystemTime(new Date(T_OPEN.getTime() + 24 * 60 * 60 * 1000));
    const again = await invite(app);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ completed: true, url: first.json().url, invite: { sms_status: 'simulated', phone: P1_PHONE } });
    const texts = rowsOfKind(db, 'application_invite');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ id: 'application_invite:wlrfm:2027:p1', to: P1_PHONE });
    expect(emailPrints()).toHaveLength(1); // the email is not repeated
  });

  it('a producer who gained an email address since gets the email on a re-run, not a second text', async () => {
    const db = seed({ producers: { p1: person('Testfield Farm', { email: null, emails: [], phone: P1_PHONE }) } });
    const app = await boot(db);
    const first = await invite(app);
    expect(first.json().invite).toMatchObject({ email_status: 'skipped_no_email', sms_status: 'simulated' });
    await db.collection('producers').doc('p1').update({ email: 'owner@testfield.example', emails: ['owner@testfield.example'] });
    const again = await invite(app);
    expect(again.json()).toMatchObject({ completed: true, url: first.json().url, invite: { email_status: 'simulated', email: 'owner@testfield.example' } });
    expect(emailPrints()).toHaveLength(1);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);
  });

  it('a held text is not sent to a producer who opted out in the meantime, and the record says why', async () => {
    const db = withPhone();
    const app = await boot(db);
    vi.setSystemTime(NIGHT);
    await invite(app);
    await db.collection('producers').doc('p1').update({ sms_opt_out_at: new Date() });
    vi.setSystemTime(MORNING);
    const res = await invite(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().invite.sms_status).toBe('skipped_opted_out');
    expect(inviteDoc(db).sms_status).toBe('skipped_opted_out');
    expect(db.count('messages')).toBe(0);
  });

  it('a forced resend at night re-sends the email and holds the text', async () => {
    const db = withPhone();
    const app = await boot(db);
    await invite(app); // noon: email and text
    vi.setSystemTime(NIGHT);
    const forced = await invite(app, 'p1', '&force=true');
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ quiet_until: QUIET_ENDS, invite: { email_status: 'simulated', sms_status: 'skipped_quiet_hours' } });
    expect(emailPrints()).toHaveLength(2);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1); // only the noon text
    expect(inviteDoc(db).resends).toEqual([expect.objectContaining({ email_status: 'simulated', sms_status: 'skipped_quiet_hours' })]);
    expect(inviteDoc(db).sms_sent_at).toEqual(T_OPEN); // the text that did go out keeps its time
  });

  it('a text the provider failed is not retried by a plain re-run (its log row holds the key); force sends it', async () => {
    const db = withPhone();
    const app = await boot(db);
    await invite(app);
    await db.collection('application_invites').doc('wlrfm_2027_p1').update({ sms_status: 'failed', sms_sent_at: null });
    const plain = await invite(app);
    expect(plain.statusCode).toBe(409);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);
    const forced = await invite(app, 'p1', '&force=true');
    expect(forced.json().invite.sms_status).toBe('simulated');
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(2);
  });

  it('a record left `pending` by a request that died before its sends is completed by the next run', async () => {
    const db = withPhone();
    const app = await boot(db);
    const first = await invite(app);
    const token = new URL(first.json().url).searchParams.get('t')!;
    // What the record looks like between create() and the sends.
    await db.collection('application_invites').doc('wlrfm_2027_p1').update({ email_status: 'pending', email_sent_at: null, sms_status: 'pending', sms_sent_at: null, message_id: null });
    await db.collection('messages').doc('application_invite:wlrfm:2027:p1').delete();
    log.mockClear();

    const again = await invite(app);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ completed: true, invite: { token, email_status: 'simulated', sms_status: 'simulated' } });
    expect(emailPrints()).toHaveLength(1);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);
  });

  it('a completion mints a new link only when the old one can no longer be opened', async () => {
    const db = withPhone();
    const app = await boot(db);
    vi.setSystemTime(NIGHT);
    const first = await invite(app);
    const oldToken = new URL(first.json().url).searchParams.get('t')!;
    await db.collection('link_tokens').doc(oldToken).update({ expires_at: new Date('2026-12-16T05:00:00Z') });
    vi.setSystemTime(MORNING);
    const again = await invite(app);
    expect(again.json().completed).toBe(true);
    expect(again.json().url).not.toBe(first.json().url);
    expect(String(rowsOfKind(db, 'application_invite')[0]!.body)).toContain(again.json().url);
    expect(inviteDoc(db).token).toBe(new URL(again.json().url).searchParams.get('t'));
  });

  it('the quiet window is the market\'s own: a lunchtime window holds a noon text', async () => {
    const db = withPhone({ quiet_hours: { start: '11:00', end: '13:00' } });
    const app = await boot(db);
    const res = await invite(app); // 12:00 in Chicago
    expect(res.json()).toMatchObject({ quiet_until: '2026-12-15T19:00:00.000Z', invite: { sms_status: 'skipped_quiet_hours' } });
    expect(db.count('messages')).toBe(0);
  });
});

describe('POST /api/markets/:id/invite-reapply during quiet hours', () => {
  it('emails everyone, holds every text, and the re-run after quiet hours texts exactly the producers not texted yet', async () => {
    const db = crowd();
    const app = await boot(db);

    vi.setSystemTime(NIGHT);
    const dry = await bulk(app, { dry_run: true });
    expect(dry.json()).toMatchObject({ applications_open: true, invited: 4, completed: 0, held_quiet_hours: 2, quiet_until: QUIET_ENDS });
    expect(Object.fromEntries(dry.json().results.map((r: { producer_id: string; sms_status: string }) => [r.producer_id, r.sms_status]))).toEqual({
      p1: 'skipped_no_phone',
      p2: 'skipped_quiet_hours',
      p3: 'skipped_quiet_hours',
      p4: 'skipped_opted_out',
    });
    expect(db.count('application_invites')).toBe(0);

    const night = await bulk(app);
    expect(night.statusCode).toBe(200);
    expect(night.json()).toMatchObject({ candidates: 4, invited: 4, completed: 0, skipped_already: 0, held_quiet_hours: 2, quiet_until: QUIET_ENDS });
    const nightById = Object.fromEntries(night.json().results.map((r: { producer_id: string }) => [r.producer_id, r]));
    expect(nightById.p1).toMatchObject({ email_status: 'simulated', sms_status: 'skipped_no_phone' });
    expect(nightById.p2).toMatchObject({ email_status: 'simulated', sms_status: 'skipped_quiet_hours' });
    expect(nightById.p3).toMatchObject({ email_status: 'skipped_no_email', sms_status: 'skipped_quiet_hours' });
    expect(nightById.p4).toMatchObject({ email_status: 'simulated', sms_status: 'skipped_opted_out' });
    expect(emailPrints()).toHaveLength(3);
    expect(db.count('messages')).toBe(0);
    const tokensAtNight = Object.fromEntries(Object.entries(db.dump('application_invites')).map(([id, i]) => [id, i.token]));

    // A second run while it is still quiet changes nothing.
    vi.setSystemTime(STILL_NIGHT);
    const stillNight = await bulk(app);
    expect(stillNight.json()).toMatchObject({ invited: 0, completed: 0, skipped_already: 4, held_quiet_hours: 2 });
    expect(db.count('messages')).toBe(0);
    expect(emailPrints()).toHaveLength(3);

    // After 08:00: p2 and p3 are texted, with the tokens they were invited with. Nobody is emailed again.
    vi.setSystemTime(MORNING);
    const preview = await bulk(app, { dry_run: true });
    expect(preview.json()).toMatchObject({ invited: 0, completed: 2, skipped_already: 2, held_quiet_hours: 0, quiet_until: null });
    const morning = await bulk(app);
    expect(morning.json()).toMatchObject({ invited: 0, completed: 2, skipped_already: 2, held_quiet_hours: 0, quiet_until: null });
    expect(morning.json().results.map((r: { producer_id: string }) => r.producer_id)).toEqual(['p2', 'p3']);
    const texts = rowsOfKind(db, 'application_invite');
    expect(texts.map((m) => m.id).sort()).toEqual(['application_invite:wlrfm:2027:p2', 'application_invite:wlrfm:2027:p3']);
    for (const t of texts) expect(String(t.body)).toContain(`/apply?t=${tokensAtNight[`wlrfm_2027_${t.producer_id as string}`] as string}`);
    expect(emailPrints()).toHaveLength(3);
    expect(db.count('link_tokens')).toBe(4);

    // And a further run sends nothing at all.
    const done = await bulk(app);
    expect(done.json()).toMatchObject({ invited: 0, completed: 0, skipped_already: 4 });
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(2);

    const audits = Object.values(db.dump('audit_log')).filter((a) => a.action === 'market.invite_reapply');
    expect(audits.map((a) => [(a.after as Record<string, unknown>).invited, (a.after as Record<string, unknown>).completed, (a.after as Record<string, unknown>).held_quiet_hours])).toEqual([
      [4, 0, 2],
      [0, 0, 2],
      [0, 2, 0],
      [0, 0, 0],
    ]);
  });

  it('a daytime re-run texts a producer who gained a phone since, and nobody else', async () => {
    const db = crowd();
    const app = await boot(db);
    await bulk(app); // noon: p2 and p3 are texted
    expect(rowsOfKind(db, 'application_invite').map((m) => m.producer_id).sort()).toEqual(['p2', 'p3']);
    await db.collection('producers').doc('p1').update({ phone: '+15015550101' });
    const again = await bulk(app);
    expect(again.json()).toMatchObject({ invited: 0, completed: 1, skipped_already: 3 });
    expect(rowsOfKind(db, 'application_invite').map((m) => m.producer_id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(emailPrints()).toHaveLength(3);
  });
});

describe('planInvite', () => {
  const base = { market_id: 'm', season: '2027', producer_id: 'p', token: 't', sent_by: 'a', sent_at: T_OPEN, resends: [], email: 'e@example.test', phone: P1_PHONE };
  const rec = (email_status: string, sms_status: string) => inviteFromData({ ...base, email_status, sms_status });

  it('first invite and forced resend send what can be sent now', () => {
    expect(planInvite(null, { force: false, email: 'e@example.test', hold: null })).toEqual({ action: 'first', email: true, sms: true });
    expect(planInvite(null, { force: false, email: null, hold: 'skipped_quiet_hours' })).toEqual({ action: 'first', email: false, sms: false });
    expect(planInvite(rec('sent', 'sent'), { force: true, email: 'e@example.test', hold: 'skipped_quiet_hours' })).toEqual({ action: 'resend', email: true, sms: false });
  });

  it('a plain re-run completes only the missing channel', () => {
    const free = { force: false, email: 'e@example.test', hold: null };
    expect(planInvite(rec('sent', 'sent'), free)).toEqual({ action: 'none', email: false, sms: false });
    expect(planInvite(rec('simulated', 'duplicate'), free).action).toBe('none');
    expect(planInvite(rec('sent', 'skipped_quiet_hours'), free)).toEqual({ action: 'complete', email: false, sms: true });
    expect(planInvite(rec('sent', 'skipped_no_phone'), free)).toEqual({ action: 'complete', email: false, sms: true });
    expect(planInvite(rec('sent', 'skipped_opted_out'), free)).toEqual({ action: 'complete', email: false, sms: true });
    expect(planInvite(rec('sent', 'pending'), free)).toEqual({ action: 'complete', email: false, sms: true });
    expect(planInvite(rec('sent', 'failed'), free).action).toBe('none');
    expect(planInvite(rec('failed', 'sent'), free)).toEqual({ action: 'complete', email: true, sms: false });
    expect(planInvite(rec('skipped_no_email', 'sent'), free)).toEqual({ action: 'complete', email: true, sms: false });
    expect(planInvite(rec('skipped_no_email', 'sent'), { ...free, email: null }).action).toBe('none');
    expect(planInvite(rec('sent', 'skipped_quiet_hours'), { ...free, hold: 'skipped_quiet_hours' }).action).toBe('none');
    expect(planInvite(rec('sent', 'skipped_quiet_hours'), { ...free, hold: 'skipped_opted_out' }).action).toBe('none');
  });

  it('a record written before the channels were tracked apart reads as sent at its creation', () => {
    const old = rec('sent', 'skipped_no_phone');
    expect(old.email_sent_at).toEqual(T_OPEN);
    expect(old.sms_sent_at).toBeNull();
    expect(old.completions).toEqual([]);
  });
});

describe('approving with send during quiet hours', () => {
  const approveBody = { action: 'approve', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true };
  const submit = (app: FastifyInstance) => app.inject({ method: 'POST', url: '/api/applications', payload: validSubmission() as never });
  const approve = (app: FastifyInstance, id: string, over: Record<string, unknown> = {}) =>
    app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: { ...approveBody, ...over } as never });
  const link = (app: FastifyInstance, membershipId: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/memberships/${membershipId}/agreement-link`, headers: adminAuth(), payload: payload as never });
  const agreementTokens = (db: Db) => Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement');

  it('sends the email, holds the text, and staff send the agreement link after quiet hours', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;

    vi.setSystemTime(NIGHT);
    const res = await approve(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().sends).toEqual({ sms: 'skipped_quiet_hours', email: true, quiet_until: QUIET_ENDS });
    expect(res.json().application.status).toBe('approved');
    expect(emailPrints()).toHaveLength(1);
    expect(db.count('messages')).toBe(0);
    expect(agreementTokens(db)).toHaveLength(1);
    expect(agreementTokens(db)[0]!.sent_message_id).toBeNull();
    const membershipId = res.json().membership.id as string;

    // The agreement-link text follows the same rule: refused at night, before a token is minted.
    const refused = await link(app, membershipId, { send: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'quiet_hours', quiet_until: QUIET_ENDS });
    expect(agreementTokens(db)).toHaveLength(1);
    expect(db.count('messages')).toBe(0);
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'membership.agreement_link')).toHaveLength(0);
    // The default is send: true.
    expect((await link(app, membershipId)).statusCode).toBe(409);

    // A link without a text is always available.
    const silent = await link(app, membershipId, { send: false });
    expect(silent.statusCode).toBe(200);
    expect(silent.json().sms).toBe('skipped_not_requested');
    expect(db.count('messages')).toBe(0);

    // 08:00: the text goes.
    vi.setSystemTime(MORNING);
    const sent = await link(app, membershipId, { send: true });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().sms).toBe('simulated');
    const texts = rowsOfKind(db, 'acceptance');
    expect(texts).toHaveLength(1);
    expect(String(texts[0]!.body)).toContain(sent.json().url);
  });

  it('approving in the daytime still texts at once', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await approve(app, id);
    expect(res.json().sends).toEqual({ sms: 'simulated', email: true, quiet_until: null });
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(1);
  });

  it('issueAgreementLink itself never texts during quiet hours, whoever calls it', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const membershipId = (await approve(app, id, { send: false })).json().membership.id as string;
    vi.setSystemTime(NIGHT);
    const ctx = (await loadAgreementContext(db as never, membershipId))!;
    const issued = await issueAgreementLink(db as never, env, ctx, { user_id: 'admin1', now: new Date(), send: true });
    expect(issued.sms).toBe('skipped_quiet_hours');
    expect(db.count('messages')).toBe(0);
  });
});
