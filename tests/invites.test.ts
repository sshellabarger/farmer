import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { P1_PHONE, T_OPEN, adminAuth, authFor, boot, printed, rowsOfKind, seed, type Db } from './helpers/a1-fixtures.js';
import { mintPurposeToken, resolvePurposeToken } from '../src/services/purpose-tokens.js';
import { mintCheckinToken } from '../src/services/link-tokens.js';
import { TEMPLATES_A1 } from '../src/services/invites.js';

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
const invite = (app: FastifyInstance, producer = 'p1', qs = '', headers = adminAuth()) =>
  app.inject({ method: 'POST', url: `/api/producers/${producer}/invite?market_id=wlrfm${qs}`, headers });
const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;

/** p1 has an email and no phone (the production shape); p2 has both. */
function withPhoneOnP1(): Db {
  return seed({
    producers: {
      p1: { business_name: 'Testfield Farm', contact_name: 'Terry Testfield', email: 'owner@testfield.example', emails: ['owner@testfield.example'], phone: P1_PHONE, aliases: [], active: true, sms_opt_out_at: null },
    },
  });
}

describe('POST /api/producers/:id/invite', () => {
  it('mints an application token, writes the invite, sends one email and no text to a producer without a phone', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await invite(app);
    expect(res.statusCode).toBe(200);
    const { invite: doc, url } = res.json();

    const token = tokenOf(url);
    expect(url).toBe(`https://test.example/apply?t=${token}`);
    expect(db.dump('link_tokens')[token]).toMatchObject({ purpose: 'application', producer_id: 'p1', market_id: 'wlrfm', season: '2027', membership_id: null, max_uses: 25, created_by: 'admin1', uses: 0 });
    // No close date: 120 days out.
    expect((db.dump('link_tokens')[token]!.expires_at as Date).getTime() - T_OPEN.getTime()).toBe(120 * 24 * 60 * 60 * 1000);

    expect(db.dump('application_invites').wlrfm_2027_p1).toMatchObject({
      market_id: 'wlrfm',
      season: '2027',
      producer_id: 'p1',
      token,
      email: 'owner@testfield.example',
      email_status: 'simulated',
      phone: null,
      sms_status: 'skipped_no_phone',
      message_id: null,
      sent_by: 'admin1',
      resends: [],
    });
    expect(doc).toMatchObject({ token, email_status: 'simulated', sms_status: 'skipped_no_phone' });
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(0);
    expect(emailPrints()).toHaveLength(1);
    const email = printed(log);
    expect(email).toContain('Apply for the 2027 West Little Rock Farmers Market season');
    expect(email).toContain(url);
    expect(email).toContain('non-refundable application fee of $15');
    expect(email).toContain('https://test.example/rules?market=wlrfm');
    expect(db.dump('link_tokens')[token]!.email_sent_at).toBeInstanceOf(Date);

    const audit = Object.values(db.dump('audit_log')).filter((a) => a.action === 'producer.invite_reapply');
    expect(audit).toEqual([expect.objectContaining({ actor_id: 'admin1', target: { collection: 'producers', id: 'p1' } })]);
  });

  it('texts a producer with a phone once, keyed by market, season and producer', async () => {
    const db = withPhoneOnP1();
    const app = await boot(db);
    const res = await invite(app);
    expect(res.statusCode).toBe(200);
    const texts = rowsOfKind(db, 'application_invite');
    expect(texts).toHaveLength(1);
    const token = tokenOf(res.json().url);
    expect(texts[0]).toMatchObject({
      id: 'application_invite:wlrfm:2027:p1',
      to: P1_PHONE,
      producer_id: 'p1',
      status: 'simulated',
      token,
      market_id: 'wlrfm',
      season: '2027',
    });
    expect(texts[0]!.body).toBe(
      `SJCA Markets: applications for the 2027 West Little Rock Farmers Market season are open. Terry, your returning-vendor application is prefilled here: https://test.example/apply?t=${token}\nReply STOP to opt out.`,
    );
    expect(String(texts[0]!.body)).toMatch(/^[\x20-\x7e\n]+$/);
    expect(res.json().invite).toMatchObject({ sms_status: 'simulated', email_status: 'simulated', message_id: 'application_invite:wlrfm:2027:p1' });
    expect(db.dump('link_tokens')[token]!.sent_message_id).toBe('application_invite:wlrfm:2027:p1');
  });

  it('a second invite is a 409 with the existing invite and sends nothing', async () => {
    const db = withPhoneOnP1();
    const app = await boot(db);
    const first = await invite(app);
    const printsBefore = log.mock.calls.length;
    const again = await invite(app);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'Already invited', invite: { token: tokenOf(first.json().url), producer_id: 'p1' } });
    expect(log.mock.calls.length).toBe(printsBefore);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(1);
    expect(Object.values(db.dump('link_tokens'))).toHaveLength(1); // no orphan token
  });

  it('force sends again without a dedupe key, mints a new token and keeps the old one working', async () => {
    const db = withPhoneOnP1();
    const app = await boot(db);
    const first = await invite(app);
    vi.setSystemTime(new Date(T_OPEN.getTime() + 3 * 24 * 60 * 60 * 1000));
    const again = await invite(app, 'p1', '&force=true');
    expect(again.statusCode).toBe(200);
    const [t1, t2] = [tokenOf(first.json().url), tokenOf(again.json().url)];
    expect(t2).not.toBe(t1);

    const texts = rowsOfKind(db, 'application_invite');
    expect(texts).toHaveLength(2);
    expect(texts.filter((m) => m.id === 'application_invite:wlrfm:2027:p1')).toHaveLength(1); // only the first carried the key
    expect(emailPrints()).toHaveLength(2);

    const stored = db.dump('application_invites').wlrfm_2027_p1!;
    expect(stored.token).toBe(t2);
    expect(stored.resends).toEqual([expect.objectContaining({ by: 'admin1', token: t2, email_status: 'simulated', sms_status: 'simulated' })]);
    expect((await resolvePurposeToken(db as never, t1, 'application', new Date())).status).toBe('ok');
    expect((await resolvePurposeToken(db as never, t2, 'application', new Date())).status).toBe('ok');
  });

  it('does not text an opted-out producer but still emails', async () => {
    const db = seed({
      producers: { p1: { business_name: 'Testfield Farm', contact_name: 'Terry', email: 'owner@testfield.example', emails: ['owner@testfield.example'], phone: P1_PHONE, active: true, sms_opt_out_at: new Date('2026-10-01') } },
    });
    const app = await boot(db);
    const res = await invite(app);
    expect(res.json().invite).toMatchObject({ sms_status: 'skipped_opted_out', email_status: 'simulated' });
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(0);
  });

  it('texts only when there is no email address', async () => {
    const db = seed({ producers: { p1: { business_name: 'Testfield Farm', contact_name: 'Terry', phone: P1_PHONE, emails: [], active: true } } });
    const app = await boot(db);
    const res = await invite(app);
    expect(res.json().invite).toMatchObject({ email_status: 'skipped_no_email', sms_status: 'simulated', email: null });
    expect(emailPrints()).toHaveLength(0);
  });

  it('expires at the market-local midnight after the application close date', async () => {
    const db = seed({}, { season: { label: '2027', application_open: '2026-12-01', application_close: '2027-02-28', schedule_version_id: 'v27' } });
    const app = await boot(db);
    const res = await invite(app);
    const token = tokenOf(res.json().url);
    expect((db.dump('link_tokens')[token]!.expires_at as Date).toISOString()).toBe('2027-03-01T06:00:00.000Z'); // 00:00 on Mar 1 in Chicago (CST)
  });

  it('409s when the market has no season label, 404s unknown producer and market, is admin only', async () => {
    const closed = await boot(seed({}, { season: null }));
    expect((await invite(closed)).statusCode).toBe(409);

    const app = await boot(seed());
    expect((await invite(app, 'nobody')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/producers/p1/invite?market_id=nowhere', headers: adminAuth() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/producers/p1/invite', headers: adminAuth() })).statusCode).toBe(400);
    expect((await invite(app, 'p1', '', authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/producers/p1/invite?market_id=wlrfm' })).statusCode).toBe(401);
  });
});

describe('GET /api/applications/prefill/:token', () => {
  async function invited() {
    const db = seed({
      producers: {
        p1: {
          business_name: 'Testfield Farm',
          contact_name: 'Terry Testfield',
          email: 'owner@testfield.example',
          emails: ['owner@testfield.example'],
          phone: P1_PHONE,
          notes: 'ADMIN ONLY: owes a certificate',
          website: 'https://testfield.example',
          address: { street: '1 Farm Rd', city: 'Little Rock', state: 'AR', zip: '72201' },
          description_public: 'Vegetables.',
          years_in_operation: 7,
          categories: ['farmers_ranchers'],
          payment_methods: ['cash'],
          products: ['tomatoes', { type: 'eggs', items: ['eggs'], practices: [], description: '', details: {} }],
          active: true,
          sms_opt_out_at: null,
        },
      },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'both', spaces: 2, electric: true, usual_booth_id: 'wlrfm_v2', created_at: new Date('2026-09-01') },
      },
    });
    const app = await boot(db);
    const res = await invite(app);
    return { db, app, token: tokenOf(res.json().url) };
  }

  it('returns the producer\'s profile and last season\'s booth without notes or ids', async () => {
    const { app, token } = await invited();
    const res = await app.inject({ method: 'GET', url: `/api/applications/prefill/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ market_id: 'wlrfm', season: '2027' });
    expect(body.producer).toMatchObject({
      business_name: 'Testfield Farm',
      contact_name: 'Terry Testfield',
      email: 'owner@testfield.example',
      phone: P1_PHONE,
      website: 'https://testfield.example',
      address: { street: '1 Farm Rd', city: 'Little Rock', state: 'AR', zip: '72201' },
      description_public: 'Vegetables.',
      years_in_operation: 7,
      categories: ['farmers_ranchers'],
      payment_methods: ['cash'],
    });
    expect(body.producer.products).toEqual([
      { type: 'produce', items: ['tomatoes'], practices: [], description: '', details: {} }, // a Phase 2 string list shows as one produce entry
      { type: 'eggs', items: ['eggs'], practices: [], description: '', details: {} },
    ]);
    expect(body.last_membership).toEqual({ season: '2026', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: false, usual_booth_label: 'V2' });
    expect(res.body).not.toMatch(/ADMIN ONLY|notes|"id"|producer_id|p1/);
  });

  it('404s an unknown or wrong-kind token and 410s an expired or used-up one', async () => {
    const { db, app, token } = await invited();
    expect((await app.inject({ method: 'GET', url: `/api/applications/prefill/${'z'.repeat(43)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/applications/prefill/short' })).statusCode).toBe(404);

    const checkin = await mintCheckinToken(db as never, { producer_id: 'p1', market_id: 'wlrfm', market_date_id: 'wlrfm_2026-09-19', deadline_at: new Date('2027-01-01'), now: T_OPEN, created_by: 'engine' });
    expect((await app.inject({ method: 'GET', url: `/api/applications/prefill/${checkin.token}` })).statusCode).toBe(404);
    const agreement = await mintPurposeToken(db as never, { purpose: 'agreement', producer_id: 'p1', market_id: 'wlrfm', season: '2027', membership_id: 'x', expires_at: new Date('2027-01-01'), now: T_OPEN, created_by: 'admin1' });
    expect((await app.inject({ method: 'GET', url: `/api/applications/prefill/${agreement.token}` })).statusCode).toBe(410);

    await db.collection('link_tokens').doc(token).update({ uses: 25 });
    expect((await app.inject({ method: 'GET', url: `/api/applications/prefill/${token}` })).statusCode).toBe(410);
    await db.collection('link_tokens').doc(token).update({ uses: 0 });
    vi.setSystemTime(new Date(T_OPEN.getTime() + 200 * 24 * 60 * 60 * 1000));
    expect((await app.inject({ method: 'GET', url: `/api/applications/prefill/${token}` })).statusCode).toBe(410);
  });

  it('a check-in link presented to the check-in route is unaffected, and an application link there is unknown', async () => {
    const { app, token } = await invited();
    expect((await app.inject({ method: 'GET', url: `/api/checkin/${token}` })).statusCode).toBe(404);
  });
});

describe('POST /api/markets/:id/invite-reapply', () => {
  function crowd(): Db {
    const person = (name: string, extra: Record<string, unknown> = {}) => ({ business_name: name, contact_name: `${name} Owner`, aliases: [], active: true, sms_opt_out_at: null, ...extra });
    return seed({
      producers: {
        p1: person('Alpha Farm', { email: 'alpha@example.test', emails: ['alpha@example.test'], phone: null }),
        p2: person('Bravo Farm', { email: 'bravo@example.test', emails: ['bravo@example.test'], phone: '+15015550102' }),
        p3: person('Charlie Farm', { email: null, emails: [], phone: null }),
        p4: person('Delta Farm', { email: 'delta@example.test', emails: ['delta@example.test'], phone: null }),
        p5: person('Echo Farm', { email: 'echo@example.test', emails: ['echo@example.test'], active: false }),
        p6: person('Foxtrot Farm', { email: 'fox@example.test', emails: ['fox@example.test'] }),
        p7: person('Golf Farm', { email: 'golf@example.test', emails: ['golf@example.test'], phone: '+15015550107', sms_opt_out_at: new Date('2026-10-01') }),
      },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
        p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active' },
        p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
        p4_wlrfm: { producer_id: 'p4', market_id: 'wlrfm', status: 'active' },
        p5_wlrfm: { producer_id: 'p5', market_id: 'wlrfm', status: 'active' },
        p6_wlrfm_2027: { producer_id: 'p6', market_id: 'wlrfm', season: '2027', status: 'approved' }, // already has a 2027 membership
        p7_wlrfm: { producer_id: 'p7', market_id: 'wlrfm', status: 'inactive' },
        p8_other: { producer_id: 'p8', market_id: 'other', status: 'active' }, // another market
      },
      applications: {
        a4: { market_id: 'wlrfm', season: '2027', status: 'new', producer_id: null, prefill_producer_id: 'p4', contact: { email: 'delta@example.test' }, schema_version: 2 },
        a5: { market_id: 'wlrfm', season: '2027', status: 'declined', producer_id: null, prefill_producer_id: 'p1', contact: { email: 'x@example.test' }, schema_version: 2 }, // a declined one does not count
      },
    });
  }
  const bulk = (app: FastifyInstance, payload: Record<string, unknown> = {}, headers = adminAuth()) =>
    app.inject({ method: 'POST', url: '/api/markets/wlrfm/invite-reapply', headers, payload: payload as never });

  it('a dry run counts and writes nothing', async () => {
    const db = crowd();
    const app = await boot(db);
    const res = await bulk(app, { dry_run: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ season: '2027', candidates: 5, invited: 3, skipped_already: 0, skipped_applied: 1, skipped_no_contact: 1 });
    expect(res.json().results.map((r: { producer_id: string }) => r.producer_id)).toEqual(['p1', 'p2', 'p3', 'p7']);
    expect(res.json().results.find((r: { producer_id: string }) => r.producer_id === 'p2')).toMatchObject({ email_status: 'would_send', sms_status: 'would_send' });
    expect(res.json().results.find((r: { producer_id: string }) => r.producer_id === 'p7')).toMatchObject({ email_status: 'would_send', sms_status: 'skipped_opted_out' });
    expect(db.count('application_invites')).toBe(0);
    expect(db.count('link_tokens')).toBe(0);
    expect(log.mock.calls).toHaveLength(0);
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'market.invite_reapply')).toHaveLength(0);
  });

  it('invites exactly the producers with another season\'s membership and nothing for a 2027 applicant', async () => {
    const db = crowd();
    const app = await boot(db);
    const res = await bulk(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ season: '2027', candidates: 5, invited: 3, skipped_already: 0, skipped_applied: 1, skipped_no_contact: 1 });
    expect(Object.keys(db.dump('application_invites')).sort()).toEqual(['wlrfm_2027_p1', 'wlrfm_2027_p2', 'wlrfm_2027_p7']);

    // p2: email and text. p1: email only (no phone). p7: email only (opted out).
    const texts = rowsOfKind(db, 'application_invite');
    expect(texts.map((m) => m.producer_id)).toEqual(['p2']);
    expect(emailPrints()).toHaveLength(3);
    const byId = Object.fromEntries(res.json().results.map((r: { producer_id: string }) => [r.producer_id, r]));
    expect(byId.p1).toMatchObject({ email_status: 'simulated', sms_status: 'skipped_no_phone' });
    expect(byId.p2).toMatchObject({ email_status: 'simulated', sms_status: 'simulated' });
    expect(byId.p3).toMatchObject({ email_status: 'skipped_no_email', sms_status: 'skipped_no_phone' });
    expect(byId.p7).toMatchObject({ sms_status: 'skipped_opted_out' });

    const audit = Object.values(db.dump('audit_log')).filter((a) => a.action === 'market.invite_reapply');
    expect(audit).toEqual([expect.objectContaining({ actor_id: 'admin1', after: expect.objectContaining({ season: '2027', invited: 3 }) })]);
  });

  it('a repeat skips everyone already invited; force invites them again', async () => {
    const db = crowd();
    const app = await boot(db);
    await bulk(app);
    const prints = log.mock.calls.length;
    const again = await bulk(app);
    expect(again.json()).toMatchObject({ invited: 0, skipped_already: 3, skipped_applied: 1, skipped_no_contact: 1 });
    expect(log.mock.calls.length).toBe(prints);

    const forced = await bulk(app, { force: true });
    expect(forced.json()).toMatchObject({ invited: 3, skipped_already: 0 });
    expect((db.dump('application_invites').wlrfm_2027_p2!.resends as unknown[]).length).toBe(1);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(2); // p2 twice: the first keyed, the resend not
  });

  it('skips a returning producer who already applied WITHOUT the prefill link: the application is matched by its contact email (fix X12)', async () => {
    const db = crowd();
    // p2 typed the public form from scratch, from a second address the market has on file for them:
    // the application names no producer at all.
    await db.collection('producers').doc('p2').update({ emails: ['bravo@example.test', 'bravo.office@example.test'] });
    await db.collection('applications').doc('a_direct').set({
      market_id: 'wlrfm',
      season: '2027',
      status: 'under_review',
      producer_id: null,
      prefill_producer_id: null,
      contact: { email: ' Bravo.Office@Example.test ', name: 'Bravo Owner' },
      schema_version: 2,
    });
    const app = await boot(db);

    const dry = await bulk(app, { dry_run: true });
    expect(dry.json()).toMatchObject({ candidates: 5, invited: 2, skipped_applied: 2, skipped_no_contact: 1 });
    expect(dry.json().results.map((r: { producer_id: string }) => r.producer_id)).toEqual(['p1', 'p3', 'p7']);

    const res = await bulk(app);
    expect(res.json()).toMatchObject({ candidates: 5, invited: 2, skipped_applied: 2, skipped_no_contact: 1 });
    expect(Object.keys(db.dump('application_invites')).sort()).toEqual(['wlrfm_2027_p1', 'wlrfm_2027_p7']);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(0); // p2 was the only textable producer
    expect(emailPrints()).toHaveLength(2);
    expect(printed(log)).not.toContain('bravo');
  });

  it('an email match counts only for a live application of this market and season', async () => {
    const db = crowd();
    const direct = (over: Record<string, unknown>) => ({ market_id: 'wlrfm', season: '2027', status: 'new', producer_id: null, prefill_producer_id: null, contact: { email: 'bravo@example.test' }, schema_version: 2, ...over });
    await db.collection('applications').doc('declined').set(direct({ status: 'declined' }));
    await db.collection('applications').doc('withdrawn').set(direct({ status: 'withdrawn' }));
    await db.collection('applications').doc('last_year').set(direct({ season: '2026' }));
    await db.collection('applications').doc('elsewhere').set(direct({ market_id: 'other' }));
    await db.collection('applications').doc('no_contact').set(direct({ contact: null }));
    await db.collection('applications').doc('bad_email').set(direct({ contact: { email: 'not an address' } }));
    const app = await boot(db);
    const res = await bulk(app);
    // Exactly as without those applications: p2 is still invited.
    expect(res.json()).toMatchObject({ candidates: 5, invited: 3, skipped_applied: 1, skipped_no_contact: 1 });
    expect(Object.keys(db.dump('application_invites')).sort()).toEqual(['wlrfm_2027_p1', 'wlrfm_2027_p2', 'wlrfm_2027_p7']);
  });

  it('only the configured season can be invited, and only once it is set', async () => {
    const app = await boot(crowd());
    expect((await bulk(app, { season: '2028' })).statusCode).toBe(409);
    expect((await bulk(app, { season: '2027' })).statusCode).toBe(200);
    const closed = await boot(seed({}, { season: null }));
    expect((await bulk(closed)).statusCode).toBe(409);
    expect((await bulk(app, { season: 'soon' })).statusCode).toBe(400);
  });

  it('is admin only and 404s an unknown market', async () => {
    const app = await boot(crowd());
    expect((await bulk(app, {}, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/markets/nowhere/invite-reapply', headers: adminAuth(), payload: {} })).statusCode).toBe(404);
  });
});

describe('GET /api/producers/:id — the re-apply link', () => {
  it('shows the current-season invite to an admin and hides it from a market manager', async () => {
    const db = seed({
      users: {
        admin1: { name: 'Admin', role: 'admin', active: true },
        mgr_w: { name: 'Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'], active: true },
      },
    });
    const app = await boot(db);
    expect((await app.inject({ method: 'GET', url: '/api/producers/p1', headers: adminAuth() })).json().invite).toBeNull();
    const res = await invite(app);
    const detail = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers: adminAuth() })).json();
    expect(detail.invite).toMatchObject({ token_url: res.json().url });
    expect(detail.invite.sent_at).toBeTruthy();
    const asManager = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers: authFor('mgr_w', 'market_manager') })).json();
    expect(asManager.invite).toBeNull();
    expect(JSON.stringify(asManager)).not.toContain(tokenOf(res.json().url));
  });
});

describe('TEMPLATES_A1', () => {
  it('the acceptance text omits the pay sentence when the market has no booth-fee link', () => {
    const body = TEMPLATES_A1.acceptance({ season: '2027', market_name: 'WLRFM', first_name: 'Terry', agreement_link: 'https://x.test/agreement?t=a', total: 30, per_market: true, booth_fee_url: null });
    expect(body).toBe('SJCA Markets: your 2027 WLRFM application is approved, Terry! Please sign the Hold Harmless agreement here: https://x.test/agreement?t=a\nBooth fee: $30 per market.\nReply STOP to opt out.');
  });

  it('copes with a missing first name', () => {
    expect(TEMPLATES_A1.acceptance({ season: '2027', market_name: 'WLRFM', first_name: '', agreement_link: 'L', total: 700, per_market: false, booth_fee_url: 'P' })).toContain('application is approved! Please');
    expect(TEMPLATES_A1.application_invite({ season: '2027', market_name: 'WLRFM', first_name: '', link: 'L' })).toContain('open. Your returning-vendor application');
  });
});
