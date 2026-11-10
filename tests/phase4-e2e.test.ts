// Phase 4 end-to-end (contract §5.5, the integrator's test): the whole 2027
// path through the real app — buildApp() over a fake Firestore and fake
// storage with the console providers — from the booth map and an invite, through
// the prefilled application, approval, the Hold Harmless e-sign, the Phase 3
// check-in workflow of the first 2027 Saturday, to the drafted, approved and
// (after quiet hours) texted booth assignment. One controllable `now` drives
// the engine (injected) and the routes (they read `new Date()`, faked here).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeStorage } from './helpers/fake-storage.js';
import { DRAFT_ID, PDF_BYTES, adminAuth, boot, env, market, multipart, rowsOfKind, seed, validSubmission, APPLICANT_PHONE } from './helpers/a1-fixtures.js';
import { DEDUPE_KEYS, TEMPLATES, processMarketDates } from '../src/services/checkin-workflow.js';
import { ACCEPTANCE_MAX_SEGMENTS, TEMPLATES_A1 } from '../src/services/invites.js';
import { splitMessage } from '../src/services/sms.js';
import { generateMarketDates } from '../src/services/market-dates.js';
import { membershipDocId } from '../src/services/seasons.js';
import type { FarmersMarket } from '../src/services/markets.js';

vi.mock('../src/services/error-notify.js', () => ({ notifyError: vi.fn(async () => {}) }));

// Tue 12:00 CST: applications are open (opened 2026-12-01) and it is outside the market's
// quiet hours, so the staff-triggered acceptance text goes out with the approval.
const T_SETUP = new Date('2026-12-15T18:00:00Z');
// The market's own insurance sentence (legal.insurance_requirements_text): market data, not code.
const INSURANCE_TEXT = 'Test policy: one million per occurrence, the market named as additional insured.';
const MARKET_NAME = 'West Little Rock Farmers Market';
// First 2027 Saturday is 2027-04-03 (08:00-12:00 CDT = 13:00-17:00Z); CDT is UTC-5 by then.
const D1 = 'wlrfm_2027-04-03';
const D2 = 'wlrfm_2027-04-10'; // the target date the booths are drafted for
const T_CHECKIN = new Date('2027-04-03T18:00:00Z'); // close + 60 min
const T_YES = new Date('2027-04-03T19:00:00Z');
const T_DEADLINE = new Date('2027-04-06T17:00:00Z'); // close + 4320 min (Tue noon CDT)
const T_DRAFTS = new Date('2027-04-06T18:00:00Z'); // close + 4380 min (Tue 13:00 CDT)
const T_APPROVE = new Date('2027-04-07T03:00:00Z'); // Tue 22:00 CDT: inside quiet hours
const T_TOO_EARLY = new Date('2027-04-07T12:59:00Z'); // Wed 07:59 CDT
const T_WINDOW_END = new Date('2027-04-07T13:00:00Z'); // Wed 08:00 CDT

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const now = (t: Date) => vi.setSystemTime(t);
const tokenOf = (text: string, path: string) => {
  const m = new RegExp(`${path}\\?t=([A-Za-z0-9_-]{43})`).exec(text);
  expect(m).not.toBeNull();
  return m![1]!;
};

describe('Phase 4 end-to-end — invite, prefilled application, approval, agreement, check-in, booth texts', () => {
  it('runs the whole 2027 timeline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T_SETUP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const emailPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[email:console]'));
    const smsPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[sms:console]'));

    // ── Seed: 2026 + 2027 versions, label 2027, defaults for fees, no booths yet ──
    const db = seed(
      { booths: {} },
      {
        season: { label: '2027', application_open: '2026-12-01', application_close: null, schedule_version_id: 'v27' },
        legal: { ...(market().legal as Record<string, unknown>), insurance_requirements_text: INSURANCE_TEXT },
      },
    );
    const storage = fakeStorage();
    const app = await boot(db, storage);
    const p1Before = JSON.stringify(db.dump('producer_memberships').p1_wlrfm);
    // Tokens carry an expiry, so mint one per request: the clock jumps months ahead.
    const authed = { get headers() { return adminAuth(); } };

    // ── The 2027 schedule is data: generate the dates for the whole schedule ──
    const marketDoc = { id: 'wlrfm', ...(db.dump('farmers_markets').wlrfm as Record<string, unknown>) } as unknown as FarmersMarket;
    const gen = await generateMarketDates(db as never, marketDoc, { scope: 'season', now: T_SETUP, actor: 'test' });
    expect(gen.created).toBeGreaterThan(0);
    expect(db.dump('market_dates')[D1]).toMatchObject({ date: '2027-04-03', status: 'collecting' });
    expect(db.dump('market_dates')[D2]).toMatchObject({ date: '2027-04-10' });

    // ── The public config: 35 markets, applications open ──
    const config = await app.inject({ method: 'GET', url: '/api/applications/config?market=wlrfm' });
    expect(config.statusCode).toBe(200);
    expect(config.json().season).toMatchObject({ label: '2027', market_count: 35, start: '2027-04-03', end: '2027-11-27', open_now: true });
    // The consent wording the applicant agrees to is versioned, and the insurance sentence is the market's.
    expect(config.json().legal).toMatchObject({ sms_consent_version: 'sjca-sms-1', insurance_requirements_text: INSURANCE_TEXT });
    const consentVersion = config.json().legal.sms_consent_version as string;

    // ── The booth map: V1-V11 west, V12-V22 east, a food truck slot; V12-V14 powered ──
    const labels = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `V${a + i}`);
    const seedRes = await app.inject({
      method: 'POST',
      url: '/api/markets/wlrfm/booths/seed',
      ...authed,
      payload: { rows: [{ row: 'west', labels: labels(1, 11) }, { row: 'east', labels: labels(12, 22) }], food_truck: { label: 'Food truck', row: 'center', order: 8 } },
    });
    expect(seedRes.statusCode).toBe(200);
    expect(seedRes.json()).toEqual({ created: 23, existing: 0 });
    for (const id of ['wlrfm_v12', 'wlrfm_v13', 'wlrfm_v14']) {
      const res = await app.inject({ method: 'PATCH', url: `/api/markets/wlrfm/booths/${id}`, ...authed, payload: { power: true } });
      expect(res.statusCode).toBe(200);
    }
    expect(Object.keys(db.dump('booths'))).toHaveLength(23);

    // ── The admin invites p1 to re-apply: a row, an email, no text (no phone) ──
    const inviteRes = await app.inject({ method: 'POST', url: '/api/producers/p1/invite?market_id=wlrfm', ...authed });
    expect(inviteRes.statusCode).toBe(200);
    expect(db.dump('application_invites').wlrfm_2027_p1).toMatchObject({ producer_id: 'p1', season: '2027', sms_status: 'skipped_no_phone' });
    expect(emailPrints()).toHaveLength(1);
    expect(rowsOfKind(db, 'application_invite')).toHaveLength(0);
    const prefillToken = tokenOf(inviteRes.json().url, '/apply');

    // ── The applicant opens the prefilled link ──
    const prefill = await app.inject({ method: 'GET', url: `/api/applications/prefill/${prefillToken}` });
    expect(prefill.statusCode).toBe(200);
    expect(prefill.json().producer.business_name).toBe('Testfield Farm');
    expect(prefill.json().last_membership).toMatchObject({ season: '2026' });

    // ── A permit upload, then the application ──
    const up = multipart({ market: 'wlrfm', draft_id: DRAFT_ID, kind: 'permit' }, { name: 'dairy-permit.pdf', type: 'application/pdf', data: PDF_BYTES });
    const upload = await app.inject({ method: 'POST', url: '/api/applications/uploads', payload: up.payload, headers: up.headers });
    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json().upload_id as string;
    expect(storage.dump().size).toBe(1);

    const submission = validSubmission({
      prefill_token: prefillToken,
      returning: { is_returning: true, last_stall: 'V12' },
      categories: ['farmers_ranchers'],
      products: [
        { type: 'produce', items: ['tomatoes', 'peppers'], practices: ['compost'], description: '', details: {} },
        { type: 'dairy', items: ['goat cheese'], practices: ['pasture_raised'], description: '', details: { facility: 'On-farm creamery' } },
      ],
      permits: { dairy: { status: 'uploaded', upload_id: uploadId, note: '' } },
      booth: { rate: 'seasonal', frequency: null, months: [], spaces: 2, electric: true, pay_in_full: true, stall_preference: ['wlrfm_v12'], food_truck: false },
    });
    expect(submission.sms_consent_version).toBe(consentVersion);

    // A form loaded before the consent wording changed is refused and stores nothing.
    const stale = await app.inject({ method: 'POST', url: '/api/applications', payload: { ...submission, sms_consent_version: 'sjca-sms-0' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('sms_consent_changed');
    expect(db.dump('applications')).toEqual({});

    const submit = await app.inject({ method: 'POST', url: '/api/applications', payload: submission });
    expect(submit.statusCode).toBe(201);
    const applicationId = submit.json().id as string;
    expect(submit.json().season_total).toMatchObject({ total: 1250, installments: 1, basis: 'season' });
    expect(submit.json().fee.amount).toBe(15);
    expect(submit.json().fee.url).toContain('https://pay.test.example/apply?email=');
    expect(JSON.stringify(submit.json())).not.toMatch(/"ip"|notes|prefill/);
    expect(db.dump('applications')[applicationId]).toMatchObject({ season: '2027', status: 'new', prefill_producer_id: 'p1' });

    // ── The queue shows it as returning and unpaid ──
    const queue = await app.inject({ method: 'GET', url: '/api/applications?market_id=wlrfm', ...authed });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().applications).toHaveLength(1);
    expect(queue.json().applications[0]).toMatchObject({ id: applicationId, is_returning: true, fee_status: 'unpaid', status: 'new', rate: 'seasonal', spaces: 2, electric: true });

    // ── Approve with V12 as the usual booth ──
    const approve = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${applicationId}`,
      ...authed,
      payload: { action: 'approve', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true, booth_kind: 'stall', usual_booth_id: 'wlrfm_v12', trial_period: false, note: '', send: true },
    });
    expect(approve.statusCode).toBe(200);
    const memberId = membershipDocId('p1', 'wlrfm', '2027');
    expect(memberId).toBe('p1_wlrfm_2027');
    expect(approve.json().sends).toMatchObject({ sms: 'simulated', email: true });
    expect(db.dump('producers').p1).toMatchObject({
      phone: APPLICANT_PHONE,
      sms_consent: { status: 'opted_in', source: 'application', text_version: consentVersion, at: T_SETUP },
    });
    expect(db.dump('producer_memberships')[memberId]).toMatchObject({ season: '2027', status: 'approved', spaces: 2, electric: true, usual_booth_id: 'wlrfm_v12', fee_plan: 'seasonal' });
    expect(JSON.stringify(db.dump('producer_memberships').p1_wlrfm)).toBe(p1Before); // the 2026 row is untouched
    const acceptance = rowsOfKind(db, 'acceptance');
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]).toMatchObject({ id: `acceptance:${applicationId}`, to: APPLICANT_PHONE, producer_id: 'p1' });
    expect(String(acceptance[0]!.body)).toContain('/agreement?t=');
    const agreementToken = tokenOf(String(acceptance[0]!.body), '/agreement');
    // The acceptance text, exactly: the news and where the details are in the first SMS, the
    // agreement link and the opt-out line in the second. No amounts and no payment link.
    const acceptanceBody = String(acceptance[0]!.body);
    expect(acceptanceBody).toBe(
      TEMPLATES_A1.acceptance({
        season: '2027',
        market_name: MARKET_NAME,
        first_name: 'Terry',
        agreement_link: `${env.APP_URL}/agreement?t=${agreementToken}`,
        details_in_email: true,
      }),
    );
    expect(splitMessage(acceptanceBody)).toEqual([
      `SJCA Markets: your 2027 ${MARKET_NAME} application is approved, Terry! Details are in your email.`,
      `Sign your Hold Harmless agreement: ${env.APP_URL}/agreement?t=${agreementToken}\nReply STOP to opt out.`,
    ]);
    expect(acceptance[0]!.segments).toBe(ACCEPTANCE_MAX_SEGMENTS);
    expect(acceptanceBody).not.toMatch(/\$|pay\.test\.example/);
    // The amounts, the payment link and the market's insurance sentence travel in the email.
    expect(emailPrints()).toHaveLength(2);
    const acceptanceEmail = emailPrints()[1]!.map(String).join('\n');
    expect(acceptanceEmail).toContain('application is approved');
    expect(acceptanceEmail).toContain(INSURANCE_TEXT);
    expect(acceptanceEmail).toContain('https://pay.test.example/booth');
    expect(acceptanceEmail).toContain('Booth fee: $1250 for the season.');

    // ── The Hold Harmless e-sign: approved -> active ──
    const agreementGet = await app.inject({ method: 'GET', url: `/api/agreements/${agreementToken}` });
    expect(agreementGet.statusCode).toBe(200);
    expect(agreementGet.json()).toMatchObject({ status: 'open', season: '2027', business_name: 'Testfield Farm' });
    const textsBeforeSign = rowsOfKind(db, 'acceptance').length;
    const sign = await app.inject({ method: 'POST', url: `/api/agreements/${agreementToken}`, payload: { signature_name: 'Terry Testfield', agree: true } });
    expect(sign.statusCode).toBe(200);
    expect(sign.json()).toMatchObject({ ok: true, membership_status: 'active' });
    expect(db.dump('producer_memberships')[memberId]).toMatchObject({ status: 'active', hold_harmless: { name: 'Terry Testfield', version: '2027-1', token: agreementToken } });
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(textsBeforeSign); // signing sends nothing

    // ── The staff mark the application fee paid ──
    const fee = await app.inject({ method: 'PATCH', url: `/api/applications/${applicationId}`, ...authed, payload: { action: 'fee', status: 'paid', reference: 'zeffy-1' } });
    expect(fee.statusCode).toBe(200);
    expect(db.dump('applications')[applicationId]).toMatchObject({ fee: { status: 'paid' } });

    // ── The certificate of insurance arrives: its last valid day is a calendar date ──
    const oldPage = await app.inject({ method: 'PATCH', url: `/api/memberships/${memberId}/insurance`, ...authed, payload: { status: 'on_file', expires_at: '2027-12-31T00:00:00.000Z' } });
    expect(oldPage.statusCode).toBe(400);
    expect(oldPage.json().code).toBe('expires_on_required');
    const insured = await app.inject({ method: 'PATCH', url: `/api/memberships/${memberId}/insurance`, ...authed, payload: { status: 'on_file', expires_on: '2027-12-31' } });
    expect(insured.statusCode).toBe(200);
    // Valid through Dec 31 in the market's zone: the instant is the local midnight that ends it (CST, UTC-6).
    expect(db.dump('producer_memberships')[memberId]).toMatchObject({
      status: 'active',
      insurance: { status: 'on_file', expires_on: '2027-12-31', expires_at: new Date('2028-01-01T06:00:00Z'), verified_by: 'admin1' },
    });

    // ── First Saturday of 2027: the Phase 3 check-in link goes to p1 ──
    now(T_CHECKIN);
    const smsBeforeSeason = smsPrints().length;
    const r1 = await processMarketDates(db as never, env, { now: T_CHECKIN });
    expect(r1.errors).toEqual([]);
    expect(r1.checkin_sent).toBe(1);
    const links = rowsOfKind(db, 'checkin_link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ to: APPLICANT_PHONE, producer_id: 'p1', market_date_id: D1 });
    expect(smsPrints().length).toBe(smsBeforeSeason + 1);

    // ── p1 texts YES (the voip.ms webhook shape): attending the next market ──
    now(T_YES);
    const yes = await app.inject({ method: 'GET', url: `/api/sms/voipms/inbound?from=${APPLICANT_PHONE.replace('+', '')}&message=YES&id=sms-e2e-1` });
    expect(yes.statusCode).toBe(200);
    expect(db.dump('checkins')[`${D1}_p1`]).toMatchObject({ attending_next: true });

    // ── The deadline passes, then the drafts step runs at drafts_at ──
    now(T_DEADLINE);
    const r2 = await processMarketDates(db as never, env, { now: T_DEADLINE });
    expect(r2.errors).toEqual([]);
    expect(r2.deadlines_processed).toBe(1);
    expect(db.dump('booth_assignments')).toEqual({});

    now(T_DRAFTS);
    const r3 = await processMarketDates(db as never, env, { now: T_DRAFTS });
    expect(r3.errors).toEqual([]);
    expect(r3.drafts_generated).toBe(1);
    const current = Object.values(db.dump('booth_assignments')).filter((a) => a.superseded_by == null);
    expect(current.map((a) => a.booth_id).sort()).toEqual(['wlrfm_v12', 'wlrfm_v13']);
    expect(current.every((a) => a.producer_id === 'p1' && a.market_date_id === D2 && a.source_date_id === D1)).toBe(true);
    expect(current.find((a) => a.booth_id === 'wlrfm_v12')).toMatchObject({ source: 'usual', assigned_by: 'engine' });
    const d1Actions = (db.dump('market_dates')[D1] as { actions: Record<string, unknown> }).actions;
    expect(d1Actions.drafts_generated_at).toEqual(T_DRAFTS);
    expect(d1Actions.assignments_target_date_id).toBe(D2);

    // ── The staff status page carries the assignments view ──
    const status = await app.inject({ method: 'GET', url: `/api/market-dates/${D1}/status`, ...authed });
    expect(status.statusCode).toBe(200);
    const view = status.json().assignments;
    expect(view.target_date.id).toBe(D2);
    expect(view.season).toBe('2027');
    expect(view.attending).toHaveLength(1);
    expect(view.attending[0]).toMatchObject({ producer_id: 'p1', spaces: 2, booth_ids: ['wlrfm_v12', 'wlrfm_v13'] });
    expect(view.approved_at).toBeNull();

    // ── Approve inside quiet hours: nothing is texted, the send is deferred ──
    now(T_APPROVE);
    const boothTextsBefore = rowsOfKind(db, 'booth').length;
    const approveRes = await app.inject({ method: 'POST', url: `/api/market-dates/${D1}/assignments/approve`, ...authed, payload: {} });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().texts).toMatchObject({ sent: 0 });
    expect(approveRes.json().texts.deferred_until).toBe(T_WINDOW_END.toISOString());
    expect(rowsOfKind(db, 'booth')).toHaveLength(boothTextsBefore);

    // ── 07:59 sends nothing; 08:00 sends exactly once ──
    now(T_TOO_EARLY);
    const r4 = await processMarketDates(db as never, env, { now: T_TOO_EARLY });
    expect(r4.errors).toEqual([]);
    expect(r4.booth_texts_sent).toBe(0);
    expect(rowsOfKind(db, 'booth')).toHaveLength(0);

    now(T_WINDOW_END);
    const r5 = await processMarketDates(db as never, env, { now: T_WINDOW_END });
    expect(r5.errors).toEqual([]);
    const booth = rowsOfKind(db, 'booth');
    expect(booth).toHaveLength(1);
    expect(booth[0]).toMatchObject({ producer_id: 'p1', to: APPLICANT_PHONE, market_date_id: D2, segments: 1 });
    // Keyed on the target date, the producer and the producer's newest current assignment row.
    expect(String(booth[0]!.id)).toMatch(new RegExp(`^booth:${D2}:p1:[0-9a-f-]{36}$`));
    expect(current.map((a) => a.id)).toContain(String(booth[0]!.id).split(':')[3]);
    expect(String(booth[0]!.body)).toContain('V12 and V13');
    // The key and the wording, exactly: one segment, greeted by first name, no opt-out line.
    const newest = current.find((a) => a.id === String(booth[0]!.id).split(':')[3])!;
    expect(booth[0]!.id).toBe(DEDUPE_KEYS.booth(D2, 'p1', String(newest.id)));
    expect(booth[0]!.body).toBe(TEMPLATES.booth({ market_name: MARKET_NAME, date_short: 'Sat Apr 10', labels: ['V12', 'V13'], first_name: 'Terry' }));
    expect(booth[0]!.body).toBe(`SJCA Markets: Terry, your booth at ${MARKET_NAME} on Sat Apr 10 is V12 and V13. Please check in at the table when you arrive.`);
    expect(String(booth[0]!.body)).not.toContain('STOP');
    expect(splitMessage(String(booth[0]!.body))).toHaveLength(1);
    // Both sides of the fix round on one timeline: the acceptance row is still the only one of its kind.
    expect(rowsOfKind(db, 'acceptance').map((m) => m.id)).toEqual([`acceptance:${applicationId}`]);

    // ── A later tick and a second approve change nothing ──
    const messageCount = db.count('messages');
    const later = new Date('2027-04-07T14:00:00Z');
    now(later);
    const r6 = await processMarketDates(db as never, env, { now: later });
    expect(r6.errors).toEqual([]);
    expect(r6.booth_texts_sent).toBe(0);
    const again = await app.inject({ method: 'POST', url: `/api/market-dates/${D1}/assignments/approve`, ...authed, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(db.count('messages')).toBe(messageCount);
    expect(rowsOfKind(db, 'booth')).toHaveLength(1);

    await app.close();
  });
});
