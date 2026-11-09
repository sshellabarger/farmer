import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ADMIN_PHONE,
  APPLICANT_PHONE,
  DRAFT_ID,
  PDF_BYTES,
  T_OPEN,
  adminAuth,
  authFor,
  boot,
  market,
  multipart,
  printed,
  rowsOfKind,
  seed,
  validSubmission,
  type Db,
} from './helpers/a1-fixtures.js';
import { mintPurposeToken } from '../src/services/purpose-tokens.js';
import { membershipDocId } from '../src/services/seasons.js';

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

const submit = (app: FastifyInstance, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/applications', payload: validSubmission(over) as never });

const emailPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[email:console]'));
const smsPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[sms:console]'));

/** Upload a PDF for a draft through the real route; returns its id. */
async function upload(app: FastifyInstance, draft = DRAFT_ID, kind = 'permit') {
  const mp = multipart({ draft_id: draft, kind }, { name: 'permit.pdf', type: 'application/pdf', data: PDF_BYTES });
  const res = await app.inject({ method: 'POST', url: '/api/applications/uploads', headers: mp.headers, payload: mp.payload });
  expect(res.statusCode).toBe(201);
  return res.json().upload_id as string;
}

describe('POST /api/applications — a valid submission', () => {
  it('stores the 2027 document and returns the fee link and the frozen season total', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('new');
    expect(body.fee).toEqual({ amount: 15, currency: 'USD', url: 'https://pay.test.example/apply?email=owner%40testfield.example' });
    expect(body.season_total).toMatchObject({
      rate: 'seasonal',
      spaces: 2,
      electric: true,
      pay_in_full: true,
      market_count: 35,
      booth_fee: 1200,
      electric_fee: 50,
      total: 1250,
      basis: 'season',
      installments: 1,
      application_fee: 15,
      currency: 'USD',
    });

    const doc = db.dump('applications')[body.id]!;
    expect(doc).toMatchObject({
      market_id: 'wlrfm',
      season: '2027',
      status: 'new',
      draft_id: DRAFT_ID,
      prefill_token: null,
      prefill_producer_id: null,
      schema_version: 2,
      source: 'web',
      producer_id: null,
      membership_id: null,
    });
    expect(doc.contact).toMatchObject({ email: 'owner@testfield.example', mobile: APPLICANT_PHONE, business_name: 'Testfield Farm' });
    expect(doc.sms_consent).toMatchObject({ status: 'opted_in', text_version: 'sjca-sms-1', ip: '127.0.0.1' });
    expect(doc.sms_consent).toHaveProperty('at');
    expect(doc.signature).toMatchObject({ name: 'Terry Testfield', ip: '127.0.0.1' });
    expect(doc.acknowledgements).toMatchObject({ rules: { version: '2027-1' }, own_booth_only: true, products_listed_only: true });
    expect(doc.fee).toMatchObject({ status: 'unpaid', amount: 15, currency: 'USD', paid_at: null });
    expect(doc.review).toMatchObject({ notes: '', trial_period: false, decline_reason: null });
    expect(doc.products).toEqual([expect.objectContaining({ type: 'produce', category: 'farmers_ranchers', items: ['tomatoes', 'peppers'] })]);
    expect(typeof doc.user_agent).toBe('string');
    // A submission creates no producer and no membership: identity is resolved at approval.
    expect(db.count('producers')).toBe(1);
    expect(db.count('producer_memberships')).toBe(1);
  });

  it('the public response carries no admin field, no token, no ip', async () => {
    const app = await boot(seed());
    const text = (await submit(app)).body;
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['fee', 'id', 'season_total', 'status']);
    expect(text).not.toMatch(/127\.0\.0\.1|user_agent|notes|token/);
  });

  it('daily rate: per-market total, no installments, pay-in-full ignored', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app, { booth: { rate: 'daily', frequency: 'monthly', months: ['may', 'june'], spaces: 1, electric: true, pay_in_full: true, stall_preference: [], food_truck: false } });
    expect(res.statusCode).toBe(201);
    expect(res.json().season_total).toMatchObject({ rate: 'daily', booth_fee: 25, electric_fee: 5, total: 30, basis: 'per_market', installments: 0, pay_in_full: false });
  });

  it('seasonal installments when not paying in full', async () => {
    const app = await boot(seed());
    const res = await submit(app, { booth: { rate: 'seasonal', frequency: null, months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: [], food_truck: false } });
    expect(res.json().season_total).toMatchObject({ booth_fee: 700, electric_fee: 0, total: 700, installments: 2 });
  });
});

describe('POST /api/applications — validation', () => {
  const rejects = async (over: Record<string, unknown>, message: RegExp | string, status = 400) => {
    const app = await boot(seed());
    const res = await submit(app, over);
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toMatch(message instanceof RegExp ? message : new RegExp(message));
  };

  it('requires text consent', async () => {
    await rejects({ sms_consent: false }, 'Text consent is required');
  });

  it('requires every acknowledgement, including the own-booth statement (D32)', async () => {
    const ok = { rules: true, weekly_report: true, farm_visits: true, marketing: true, products_listed_only: true, own_booth_only: true };
    for (const key of Object.keys(ok)) await rejects({ acknowledgements: { ...ok, [key]: false } }, /Please/);
  });

  it('rejects a duplicate product type, an upload without an id, a daily rate without a frequency and four stall picks', async () => {
    const produce = { type: 'produce', items: ['kale'], practices: [], description: '', details: {} };
    await rejects({ products: [produce, produce] }, 'duplicate product type');
    await rejects({ products: [produce], permits: { produce: { status: 'uploaded' } } }, 'upload_id is required');
    await rejects({ booth: { rate: 'daily', frequency: null, months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: [], food_truck: false } }, 'frequency is required');
    await rejects({ booth: { rate: 'seasonal', frequency: null, months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: ['a', 'b', 'c', 'd'], food_truck: false } }, /3|many/i);
  });

  it('rejects an unknown product type key and a type outside the selected categories', async () => {
    await rejects({ products: [{ type: 'unicorn', items: ['x'], practices: [], description: '', details: {} }] }, "Unknown product type 'unicorn'");
    await rejects({ products: [{ type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} }], permits: { dairy: { status: 'will_provide' } }, categories: ['food_adjacent'] }, /category you selected/);
  });

  it('dairy needs a permit upload or a promise; Food Freedom is not an answer for dairy', async () => {
    const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };
    await rejects({ products: [dairy] }, /permit is required for Dairy/);
    await rejects({ products: [dairy], permits: { dairy: { status: 'food_freedom' } } }, /permit is required for Dairy/);
    await rejects({ products: [dairy], permits: { dairy: { status: 'not_required' } } }, /permit is required for Dairy/);

    const app = await boot(seed());
    const ok = await submit(app, { products: [dairy], permits: { dairy: { status: 'will_provide' } } });
    expect(ok.statusCode).toBe(201);
  });

  it('value-added foods accept Food Freedom', async () => {
    const app = await boot(seed());
    const res = await submit(app, {
      categories: ['specialty_food'],
      products: [{ type: 'value_added', items: ['jam'], practices: ['food_freedom_labelled'], description: '', details: {} }],
      permits: { value_added: { status: 'food_freedom' } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('a permit entry for a type the applicant did not select is dropped', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app, { permits: { dairy: { status: 'will_provide' } } });
    expect(res.statusCode).toBe(201);
    expect(db.dump('applications')[res.json().id]!.permits).toEqual({});
  });

  it('requires the current rules version', async () => {
    await rejects({ rules_version: '2026-9' }, 'Please re-read the current rules');
  });

  it('skips the rules-version check when the market has none', async () => {
    const app = await boot(seed({}, { legal: { rules_markdown: '', rules_version: '', hold_harmless_markdown: '' } }));
    expect((await submit(app, { rules_version: '' })).statusCode).toBe(201);
  });

  it('rejects an invalid email, an invalid mobile number and unknown stalls', async () => {
    const contact = validSubmission().contact as Record<string, unknown>;
    await rejects({ contact: { ...contact, email: 'not-an-email' } }, /email/i);
    await rejects({ contact: { ...contact, mobile: '12345' } }, /mobile|10/i);
    await rejects({ booth: { rate: 'seasonal', frequency: null, months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: ['wlrfm_v99'], food_truck: false } }, /stalls you picked/);
  });

  it('accepts stalls that exist and are active', async () => {
    const app = await boot(seed());
    const res = await submit(app, { booth: { rate: 'seasonal', frequency: null, months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: ['wlrfm_v1', 'wlrfm_v3'], food_truck: false } });
    expect(res.statusCode).toBe(201);
  });

  it('404s an unknown or inactive market and 409s when applications are closed', async () => {
    const closed = await boot(seed({}, { season: null }));
    const res = await submit(closed);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Applications are closed for this market');

    const outside = await boot(seed({}, { season: { label: '2027', application_open: '2027-01-01', application_close: null, schedule_version_id: 'v27' } }));
    expect((await submit(outside)).statusCode).toBe(409);

    const app = await boot(seed({ farmers_markets: { gone: market({ active: false }) } }));
    expect((await submit(app, { market_id: 'gone' })).statusCode).toBe(404);
    expect((await submit(app, { market_id: 'nowhere' })).statusCode).toBe(404);
  });
});

describe('POST /api/applications — one application per email and season', () => {
  it('409s a second application for the same email, with the first one\'s id', async () => {
    const app = await boot(seed());
    const first = await submit(app);
    const second = await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'We already have an application for this email this season', application_id: first.json().id });
  });

  it('matches the email after normalisation', async () => {
    const app = await boot(seed());
    await submit(app);
    const contact = { ...(validSubmission().contact as object), email: '  OWNER@testfield.EXAMPLE ' };
    expect((await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', contact })).statusCode).toBe(409);
  });

  it('a declined or withdrawn application does not block a new one', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    const patch = await app.inject({ method: 'PATCH', url: `/api/applications/${first.json().id}`, headers: adminAuth(), payload: { action: 'decline', reason: 'incomplete' } });
    expect(patch.statusCode).toBe(200);
    const again = await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(first.json().id);
  });

  it('a repeat of the same draft is the same submission, not a second application', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    const again = await submit(app);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    expect(db.count('applications')).toBe(1);
  });

  it('a different email is a different applicant', async () => {
    const db = seed();
    const app = await boot(db);
    await submit(app);
    const contact = { ...(validSubmission().contact as object), email: 'someone.else@example.test' };
    expect((await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', contact })).statusCode).toBe(201);
    expect(db.count('applications')).toBe(2);
  });
});

describe('POST /api/applications — returning-vendor prefill token', () => {
  const tokenFor = (db: Db, over: Record<string, unknown> = {}) =>
    mintPurposeToken(db as never, {
      purpose: 'application',
      producer_id: 'p1',
      market_id: 'wlrfm',
      season: '2027',
      expires_at: new Date('2027-02-01T00:00:00Z'),
      now: T_OPEN,
      created_by: 'admin1',
      ...over,
    });

  it('links prefill_producer_id and counts a use on the token', async () => {
    const db = seed();
    const t = await tokenFor(db);
    const app = await boot(db);
    const res = await submit(app, { prefill_token: t.token });
    expect(res.statusCode).toBe(201);
    expect(db.dump('applications')[res.json().id]).toMatchObject({ prefill_producer_id: 'p1', prefill_token: t.token });
    expect(db.dump('link_tokens')[t.token]).toMatchObject({ uses: 1, application_id: res.json().id });
  });

  it('410s an expired token, a token for another market and an unknown token', async () => {
    const db = seed();
    const expired = await tokenFor(db, { expires_at: new Date('2026-12-01T00:00:00Z') });
    const other = await tokenFor(db, { market_id: 'other' });
    const app = await boot(db);
    expect((await submit(app, { prefill_token: expired.token })).statusCode).toBe(410);
    expect((await submit(app, { prefill_token: other.token })).statusCode).toBe(410);
    expect((await submit(app, { prefill_token: 'x'.repeat(43) })).statusCode).toBe(410);
    expect(db.count('applications')).toBe(0);
  });
});

describe('POST /api/applications — uploads', () => {
  it('attaches the uploads it references', async () => {
    const db = seed();
    const app = await boot(db);
    const permitId = await upload(app);
    const certId = await upload(app, DRAFT_ID, 'insurance');
    const res = await submit(app, {
      categories: ['farmers_ranchers'],
      products: [{ type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} }],
      permits: { dairy: { status: 'uploaded', upload_id: permitId } },
      insurance: { status: 'have', certificate_upload_id: certId, carrier: 'Acme Mutual', expires_on: '2027-12-31' },
    });
    expect(res.statusCode).toBe(201);
    const doc = db.dump('applications')[res.json().id]!;
    expect([...(doc.upload_ids as string[])].sort()).toEqual([permitId, certId].sort());
    expect(db.dump('application_uploads')[permitId]).toMatchObject({ application_id: res.json().id });
    expect(db.dump('application_uploads')[permitId]!.attached_at).toBeInstanceOf(Date);
  });

  it('400s an upload that belongs to another draft or to another application', async () => {
    const db = seed();
    const app = await boot(db);
    const other = await upload(app, '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a');
    const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };
    const res = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: other } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/uploaded files/);

    const missing = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: '11111111-2222-4333-8444-555555555555' } } });
    expect(missing.statusCode).toBe(400);
  });
});

describe('GET /api/applications (queue) and /:id (detail)', () => {
  async function twoApplications() {
    const db = seed();
    const app = await boot(db);
    const a = await submit(app);
    vi.setSystemTime(new Date(T_OPEN.getTime() + 60 * 60 * 1000));
    const contact = { ...(validSubmission().contact as object), email: 'second@example.test', business_name: 'Second Acres', name: 'Sam Second' };
    const b = await submit(app, {
      draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
      contact,
      returning: { is_returning: true, last_stall: 'V2' },
      categories: ['specialty_food'],
      products: [{ type: 'value_added', items: ['jam'], practices: [], description: '', details: {} }],
      permits: { value_added: { status: 'will_provide' } },
      booth: { rate: 'daily', frequency: 'monthly', months: [], spaces: 1, electric: false, pay_in_full: false, stall_preference: [], food_truck: false },
    });
    return { db, app, a: a.json().id as string, b: b.json().id as string };
  }

  it('lists newest first with the queue fields', async () => {
    const { app, a, b } = await twoApplications();
    const res = await app.inject({ method: 'GET', url: '/api/applications?market_id=wlrfm', headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    const list = res.json().applications;
    expect(list.map((x: { id: string }) => x.id)).toEqual([b, a]);
    expect(list[0]).toMatchObject({
      market_id: 'wlrfm',
      season: '2027',
      status: 'new',
      business_name: 'Second Acres',
      contact_name: 'Sam Second',
      email: 'second@example.test',
      mobile: APPLICANT_PHONE,
      categories: ['specialty_food'],
      product_types: ['value_added'],
      rate: 'daily',
      spaces: 1,
      electric: false,
      is_returning: true,
      fee_status: 'unpaid',
      insurance_status: 'none',
      permits_pending: 1,
      producer_id: null,
    });
    expect(list[1]).toMatchObject({ rate: 'seasonal', spaces: 2, electric: true, is_returning: false, permits_pending: 0 });
  });

  it('filters by status, fee, category, returning and search', async () => {
    const { app, a, b } = await twoApplications();
    const ids = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/applications?${qs}`, headers: adminAuth() })).json().applications.map((x: { id: string }) => x.id);
    expect(await ids('returning=true')).toEqual([b]);
    expect(await ids('returning=false')).toEqual([a]);
    expect(await ids('category=farmers_ranchers')).toEqual([a]);
    expect(await ids('q=second')).toEqual([b]);
    expect(await ids('q=TESTFIELD')).toEqual([a]);
    expect(await ids('fee=paid')).toEqual([]);
    await app.inject({ method: 'PATCH', url: `/api/applications/${a}`, headers: adminAuth(), payload: { action: 'fee', status: 'paid', reference: 'ZF-1' } });
    expect(await ids('fee=paid')).toEqual([a]);
    expect(await ids('status=under_review')).toEqual([]);
    expect(await ids('status=new&season=all')).toHaveLength(2);
    expect(await ids('season=2026')).toEqual([]);
  });

  it('asks the database one equality question: status, else market, else nothing', async () => {
    const { db, app } = await twoApplications();
    const wheres: string[][] = [];
    const collection = db.collection.bind(db);
    db.collection = ((name: string) => {
      const col = collection(name);
      if (name !== 'applications') return col;
      const where = col.where.bind(col);
      col.where = ((f: string, op: string, v: unknown) => {
        wheres.push([f, String(v)]);
        return where(f, op, v);
      }) as never;
      return col;
    }) as never;
    await app.inject({ method: 'GET', url: '/api/applications?status=new&market_id=wlrfm&fee=unpaid&q=x', headers: adminAuth() });
    expect(wheres).toEqual([['status', 'new']]);
    wheres.length = 0;
    await app.inject({ method: 'GET', url: '/api/applications?market_id=wlrfm', headers: adminAuth() });
    expect(wheres).toEqual([['market_id', 'wlrfm']]);
    wheres.length = 0;
    await app.inject({ method: 'GET', url: '/api/applications', headers: adminAuth() });
    expect(wheres).toEqual([]);
  });

  it('is admin only', async () => {
    const { app, a } = await twoApplications();
    for (const url of ['/api/applications', `/api/applications/${a}`]) {
      expect((await app.inject({ method: 'GET', url, headers: authFor('mgr1', 'market_manager') })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'PATCH', url: `/api/applications/${a}`, headers: authFor('mgr1', 'market_manager'), payload: { action: 'review' } })).statusCode).toBe(403);
  });

  it('detail returns the document, its uploads (metadata only), the matched producer and every prior season', async () => {
    const db = seed();
    const app = await boot(db);
    const permitId = await upload(app);
    const res = await submit(app, {
      products: [{ type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} }],
      permits: { dairy: { status: 'uploaded', upload_id: permitId } },
    });
    const detail = await app.inject({ method: 'GET', url: `/api/applications/${res.json().id}`, headers: adminAuth() });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.application).toMatchObject({ id: res.json().id, status: 'new', schema_version: 2, ip: '127.0.0.1' });
    expect(body.uploads).toEqual([expect.objectContaining({ id: permitId, kind: 'permit', mime: 'application/pdf', original_name: 'permit.pdf', application_id: res.json().id })]);
    expect(JSON.stringify(body.uploads)).not.toMatch(/storage_path|sha256|application-uploads/);
    expect(body.producer).toEqual({ id: 'p1', business_name: 'Testfield Farm' }); // recognised by email
    expect(body.prior_memberships).toEqual([expect.objectContaining({ id: 'p1_wlrfm', season: '2026', status: 'active' })]);
  });

  it('404s an unknown application', async () => {
    const app = await boot(seed());
    expect((await app.inject({ method: 'GET', url: '/api/applications/nope', headers: adminAuth() })).statusCode).toBe(404);
  });

  it('reads a Phase 2 application as schema_version 1 and lists it', async () => {
    const db = seed({
      applications: {
        old1: {
          email: 'old@example.test',
          business_name: 'Old Farm',
          contact_person: 'Olive Old',
          phone: '+15015550177',
          markets_applied: ['wlrfm'],
          extra: {},
          status: 'new',
          producer_id: null,
          membership_ids: [],
          submitted_at: new Date('2026-09-20T12:00:00Z'),
        },
      },
    });
    const app = await boot(db);
    const list = (await app.inject({ method: 'GET', url: '/api/applications?season=all', headers: adminAuth() })).json().applications;
    expect(list).toEqual([expect.objectContaining({ id: 'old1', market_id: 'wlrfm', business_name: 'Old Farm', contact_name: 'Olive Old', mobile: '+15015550177' })]);
    const detail = (await app.inject({ method: 'GET', url: '/api/applications/old1', headers: adminAuth() })).json();
    expect(detail.application.schema_version).toBe(1);
    // It cannot be approved through the 2027 flow.
    const approve = await app.inject({ method: 'PATCH', url: '/api/applications/old1', headers: adminAuth(), payload: { action: 'approve', fee_plan: 'daily', spaces: 1, electric: false, pay_in_full: false } });
    expect(approve.statusCode).toBe(409);
    expect(db.count('producer_memberships')).toBe(1);
  });
});

describe('PATCH /api/applications/:id — review, fee, notes, decline, withdraw', () => {
  const patch = (app: FastifyInstance, id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: payload as never });

  it('walks new -> under_review and rejects a repeat', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await patch(app, id, { action: 'review' });
    expect(res.statusCode).toBe(200);
    expect(res.json().application.status).toBe('under_review');
    expect((await patch(app, id, { action: 'review' })).statusCode).toBe(409);
    const audit = Object.values(db.dump('audit_log')).filter((a) => a.action === 'application.transition');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: 'admin1', before: { status: 'new' }, after: { status: 'under_review' } });
  });

  it('marks the fee paid, waived and unpaid with a reference, and audits it', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const paid = (await patch(app, id, { action: 'fee', status: 'paid', reference: 'ZF-123' })).json().application;
    expect(paid.fee).toMatchObject({ status: 'paid', marked_by: 'admin1', reference: 'ZF-123' });
    expect(paid.fee.paid_at).toBeTruthy();
    const waived = (await patch(app, id, { action: 'fee', status: 'waived' })).json().application;
    expect(waived.fee).toMatchObject({ status: 'waived', paid_at: null, reference: 'ZF-123' });
    const unpaid = (await patch(app, id, { action: 'fee', status: 'unpaid' })).json().application;
    expect(unpaid.fee).toMatchObject({ status: 'unpaid', marked_by: null });
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'application.fee')).toHaveLength(3);
  });

  it('saves staff notes without touching the rest of review', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await patch(app, id, { action: 'note', notes: 'Called the applicant.' });
    expect(res.json().application.review).toMatchObject({ notes: 'Called the applicant.', trial_period: false, decline_reason: null });
    const audit = JSON.stringify(Object.values(db.dump('audit_log')));
    expect(audit).not.toContain('Called the applicant.'); // the audit row holds a length, not the note
  });

  it('declines with a reason and withdraws; both are terminal', async () => {
    const app = await boot(seed());
    const a = (await submit(app)).json().id;
    const declined = (await patch(app, a, { action: 'decline', reason: 'Outside the category rules' })).json().application;
    expect(declined).toMatchObject({ status: 'declined' });
    expect(declined.review).toMatchObject({ decline_reason: 'Outside the category rules', reviewed_by: 'admin1' });
    expect((await patch(app, a, { action: 'review' })).statusCode).toBe(409);
    expect((await patch(app, a, { action: 'withdraw' })).statusCode).toBe(409);

    const contact = { ...(validSubmission().contact as object), email: 'w@example.test' };
    const b = (await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', contact })).json().id;
    expect((await patch(app, b, { action: 'withdraw' })).json().application.status).toBe('withdrawn');
    expect((await patch(app, b, { action: 'decline', reason: 'x' })).statusCode).toBe(409);
    // The fee can still be recorded on a closed application.
    expect((await patch(app, b, { action: 'fee', status: 'paid' })).statusCode).toBe(200);
  });

  it('400s a malformed action and 404s an unknown application', async () => {
    const app = await boot(seed());
    const id = (await submit(app)).json().id;
    expect((await patch(app, id, { action: 'explode' })).statusCode).toBe(400);
    expect((await patch(app, id, { action: 'decline' })).statusCode).toBe(400);
    expect((await patch(app, 'nope', { action: 'review' })).statusCode).toBe(404);
  });
});

describe('PATCH /api/applications/:id approve', () => {
  const approveBody = { action: 'approve', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true };
  const approve = (app: FastifyInstance, id: string, over: Record<string, unknown> = {}) =>
    app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: { ...approveBody, ...over } as never });

  it('matches the producer by email, creates the 2027 membership beside the untouched 2026 one, and sends the acceptance', async () => {
    const db = seed();
    const app = await boot(db);
    const permitId = await upload(app);
    const sub = await submit(app, {
      products: [
        { type: 'produce', items: ['Tomatoes', 'peppers'], practices: [], description: '', details: {} },
        { type: 'eggs', items: ['eggs', 'tomatoes'], practices: [], description: '', details: {} },
      ],
      insurance: { status: 'have', certificate_upload_id: permitId, carrier: 'Acme Mutual', expires_on: '2027-12-31' },
    });
    const id = sub.json().id;
    const before2026 = JSON.stringify(db.dump('producer_memberships').p1_wlrfm);

    const res = await approve(app, id, { usual_booth_id: 'wlrfm_v1', note: 'Welcome back' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Same producer, enriched; no second producer.
    expect(db.count('producers')).toBe(1);
    expect(body.producer.id).toBe('p1');
    const producer = db.dump('producers').p1!;
    expect(producer).toMatchObject({ phone: APPLICANT_PHONE, website: 'https://testfield.example', last_application_id: id, categories: ['farmers_ranchers'], payment_methods: ['cash', 'card'], agricultural_practices: 'no_chemicals' });
    expect(producer.sms_consent).toMatchObject({ status: 'opted_in', source: 'application', text_version: 'sjca-sms-1', ip: '127.0.0.1' });
    expect(producer.sms_opt_out_at).toBeNull();
    expect(producer.address).toEqual({ street: '1 Farm Rd', city: 'Little Rock', state: 'AR', zip: '72201' });
    expect((producer.products as Record<string, unknown>[])[0]).toMatchObject({ type: 'produce', items: ['Tomatoes', 'peppers'] });
    expect((producer.products as Record<string, unknown>[])[0]).not.toHaveProperty('category');

    // The 2027 membership; the 2026 row is byte-identical.
    const mid = membershipDocId('p1', 'wlrfm', '2027');
    expect(mid).toBe('p1_wlrfm_2027');
    const membership = db.dump('producer_memberships')[mid]!;
    expect(membership).toMatchObject({
      producer_id: 'p1',
      market_id: 'wlrfm',
      season: '2027',
      status: 'approved',
      fee_plan: 'seasonal',
      spaces: 2,
      electric: true,
      pay_in_full: true,
      booth_kind: 'stall',
      usual_booth_id: 'wlrfm_v1',
      trial_period: false,
      approved_by: 'admin1',
      application_id: id,
      hold_harmless: null,
      source: 'application',
    });
    expect(membership.approved_items).toEqual(['Tomatoes', 'peppers', 'eggs']); // flattened, de-duplicated
    expect(membership.insurance).toMatchObject({ status: 'on_file', upload_id: permitId, verified_by: null });
    expect((membership.insurance as { expires_at: Date }).expires_at.toISOString()).toBe('2028-01-01T05:59:00.000Z'); // 23:59 on the 31st in Chicago
    expect((membership.history as unknown[])[0]).toMatchObject({ from: null, to: 'approved', by: 'admin1', note: 'Welcome back' });
    expect(JSON.stringify(db.dump('producer_memberships').p1_wlrfm)).toBe(before2026);
    expect(body.membership).toMatchObject({ id: mid, season: '2027', status: 'approved' });

    // The application points at both.
    expect(db.dump('applications')[id]).toMatchObject({ status: 'approved', producer_id: 'p1', membership_id: mid });
    expect(db.dump('applications')[id]!.review).toMatchObject({ trial_period: false, reviewed_by: 'admin1' });

    // The agreement link.
    const tokens = Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ membership_id: mid, producer_id: 'p1', market_id: 'wlrfm', season: '2027', max_uses: 1, created_by: 'admin1' });
    const expiresMs = (tokens[0]!.expires_at as Date).getTime() - T_OPEN.getTime();
    expect(expiresMs).toBe(60 * 24 * 60 * 60 * 1000);

    // One acceptance text, keyed by the application.
    const texts = rowsOfKind(db, 'acceptance');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ id: `acceptance:${id}`, to: APPLICANT_PHONE, producer_id: 'p1', status: 'simulated', application_id: id, membership_id: mid });
    expect(String(texts[0]!.body)).toContain(`https://test.example/agreement?t=${tokens[0]!.token}`);
    expect(String(texts[0]!.body)).toContain('Booth fee: $1250. Pay here: https://pay.test.example/booth');
    expect(String(texts[0]!.body)).toContain('Terry');
    expect(String(texts[0]!.body)).toMatch(/^[\x20-\x7e\n]+$/); // ASCII only
    expect(body.sends).toEqual({ sms: 'simulated', email: true });

    // One acceptance email.
    expect(emailPrints()).toHaveLength(1);
    const email = printed(log);
    expect(email).toContain('[SJCA Markets] Your 2027 West Little Rock Farmers Market application is approved');
    expect(email).toContain('Booth fee: $1250 for the season');
    expect(email).toContain('KBK-Breck, LLC c/o Kelley Commercial Partners');
    expect(email).toContain('https://help.test.example/insurance');
    expect(email).toContain('2027-04-03');
    expect(email).toContain('https://test.example/rules?market=wlrfm');

    // Audit trail.
    const actions = Object.values(db.dump('audit_log')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['producer.update', 'membership.create', 'application.approve']));
  });

  it('a second approval is refused and sends nothing more', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    expect((await approve(app, id)).statusCode).toBe(200);
    const again = await approve(app, id);
    expect(again.statusCode).toBe(409);
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(1);
    expect(emailPrints()).toHaveLength(1);
    expect(Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement')).toHaveLength(1);
  });

  it('creates a new producer for a new email, with the phone and consent from the application', async () => {
    const db = seed();
    const app = await boot(db);
    const contact = { ...(validSubmission().contact as object), email: 'newbie@example.test', business_name: 'Newbie Gardens', name: 'Nora Newbie' };
    const id = (await submit(app, { contact })).json().id;
    const res = await approve(app, id, { fee_plan: 'daily', spaces: 1, electric: false, pay_in_full: false });
    expect(res.statusCode).toBe(200);
    expect(db.count('producers')).toBe(2);
    const producerId = res.json().producer.id as string;
    expect(producerId).not.toBe('p1');
    expect(db.dump('producers')[producerId]).toMatchObject({ business_name: 'Newbie Gardens', contact_name: 'Nora Newbie', phone: APPLICANT_PHONE, email: 'newbie@example.test', emails: ['newbie@example.test'], active: true, source: 'application' });
    expect(db.dump('producer_memberships')[`${producerId}_wlrfm_2027`]).toMatchObject({ fee_plan: 'daily', spaces: 1 });
    expect(rowsOfKind(db, 'acceptance')[0]!.body).toContain('per market');
  });

  it('a different business name for a known email becomes an alias; names never match', async () => {
    const db = seed();
    const app = await boot(db);
    const contact = { ...(validSubmission().contact as object), business_name: 'Terry T. Produce' };
    const id = (await submit(app, { contact })).json().id;
    const res = await approve(app, id);
    expect(res.json().producer.id).toBe('p1');
    expect(db.dump('producers').p1).toMatchObject({ business_name: 'Testfield Farm', aliases: ['Terry T. Produce'] });

    // The same business name under a different email is a different producer.
    const contact2 = { ...(validSubmission().contact as object), email: 'other.owner@example.test', business_name: 'Testfield Farm' };
    const id2 = (await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', contact: contact2 })).json().id;
    const res2 = await approve(app, id2, { fee_plan: 'daily' });
    expect(res2.statusCode).toBe(409); // ...whose mobile number p1 now holds
    expect(res2.json().producer_id).toBe('p1');
  });

  it('409s a phone number another producer already holds, writing nothing', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], phone: null, aliases: [], active: true },
        p9: { business_name: 'Holder Farm', emails: ['holder@example.test'], phone: APPLICANT_PHONE, aliases: [], active: true },
      },
    });
    const app = await boot(db);
    const contact = { ...(validSubmission().contact as object), email: 'brand.new@example.test' };
    const id = (await submit(app, { contact })).json().id;
    const res = await approve(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().producer_id).toBe('p9');
    expect(db.count('producers')).toBe(2);
    expect(db.count('producer_memberships')).toBe(1);
    expect(db.count('link_tokens')).toBe(0);
    expect(db.dump('applications')[id]!.status).toBe('new');
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(0);
  });

  it('409s when the producer already has a membership for the season, writing nothing', async () => {
    const db = seed({
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly' },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', fee_plan: 'seasonal' },
      },
    });
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await approve(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ membership_id: 'p1_wlrfm_2027' });
    expect(db.dump('producers').p1!.phone).toBeNull();
    expect(db.count('link_tokens')).toBe(0);
    expect(db.dump('applications')[id]!.status).toBe('new');
  });

  it('brings an inactive membership of the same season back instead of failing', async () => {
    const db = seed({
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly' },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'inactive', fee_plan: 'daily', history: [{ from: null, to: 'inactive' }] },
      },
    });
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await approve(app, id);
    expect(res.statusCode).toBe(200);
    expect(db.dump('producer_memberships').p1_wlrfm_2027).toMatchObject({ status: 'approved', fee_plan: 'seasonal', application_id: id });
    expect((db.dump('producer_memberships').p1_wlrfm_2027!.history as unknown[]).length).toBe(2);
  });

  it('a prefilled application merges into the prefilled producer even when the email changed', async () => {
    const db = seed();
    const t = await mintPurposeToken(db as never, { purpose: 'application', producer_id: 'p1', market_id: 'wlrfm', season: '2027', expires_at: new Date('2027-02-01T00:00:00Z'), now: T_OPEN, created_by: 'admin1' });
    const app = await boot(db);
    const contact = { ...(validSubmission().contact as object), email: 'terry.new.address@example.test' };
    const id = (await submit(app, { prefill_token: t.token, contact })).json().id;
    const res = await approve(app, id);
    expect(res.statusCode).toBe(200);
    expect(db.count('producers')).toBe(1);
    expect(db.dump('producers').p1!.emails).toEqual(['owner@testfield.example', 'terry.new.address@example.test']);
    expect(res.json().membership.producer_id).toBe('p1');
  });

  it('send: false sends no text and no email but still approves', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await approve(app, id, { send: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().sends).toEqual({ sms: 'skipped_not_requested', email: false });
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(0);
    expect(emailPrints()).toHaveLength(0);
    expect(smsPrints()).toHaveLength(0);
    expect(Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement')).toHaveLength(1);
  });

  it('refuses to send the acceptance while the Hold Harmless text is missing; approving without sending still works', async () => {
    const db = seed();
    await db.collection('farmers_markets').doc('wlrfm').update({ 'legal.hold_harmless_markdown': '' });
    const app = await boot(db);
    const id = (await submit(app)).json().id;

    const refused = await approve(app, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'hold_harmless_missing' });
    // Nothing was written or sent by the refusal.
    expect((db.dump('applications')[id] as Record<string, unknown>).status).not.toBe('approved');
    expect(Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement')).toHaveLength(0);
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(0);
    expect(emailPrints()).toHaveLength(0);

    const quiet = await approve(app, id, { send: false });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().sends).toEqual({ sms: 'skipped_not_requested', email: false });
    expect((db.dump('applications')[id] as Record<string, unknown>).status).toBe('approved');
  });

  it('does not text an opted-out producer', async () => {
    const db = seed({
      producers: { p1: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], phone: null, aliases: [], active: true, sms_opt_out_at: new Date('2026-10-01') } },
    });
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    const res = await approve(app, id);
    // The application's consent re-opts-in the number it names; an opt-out recorded on the producer stays untouched.
    expect(res.statusCode).toBe(200);
    expect(res.json().sends.sms).toBe('skipped_opted_out');
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(0);
    expect(db.dump('producers').p1!.sms_opt_out_at).toBeInstanceOf(Date);
  });

  it('validates the usual booth, the fee plan and the preconditions', async () => {
    const db = seed({ booths: { gone: { market_id: 'wlrfm', label: 'V9', row: 'west', order: 9, kind: 'stall', power: false, size: '12x12', active: false }, wlrfm_v1: { market_id: 'wlrfm', label: 'V1', row: 'west', order: 1, kind: 'stall', power: false, size: '12x12', active: true }, o1: { market_id: 'other', label: 'V1', row: 'west', order: 1, kind: 'stall', power: false, size: '12x12', active: true } } });
    const app = await boot(db);
    const id = (await submit(app)).json().id;
    expect((await approve(app, id, { usual_booth_id: 'gone' })).statusCode).toBe(400);
    expect((await approve(app, id, { usual_booth_id: 'o1' })).statusCode).toBe(400);
    expect((await approve(app, id, { usual_booth_id: 'nope' })).statusCode).toBe(400);
    expect((await approve(app, id, { fee_plan: 'weekly' })).statusCode).toBe(400);
    expect((await approve(app, id, { spaces: 3 })).statusCode).toBe(400);
    expect(db.count('link_tokens')).toBe(0);
    expect((await approve(app, id, { usual_booth_id: 'wlrfm_v1', booth_kind: 'food_truck', trial_period: true })).statusCode).toBe(200);
    expect(db.dump('producer_memberships').p1_wlrfm_2027).toMatchObject({ booth_kind: 'food_truck', trial_period: true });
    expect(db.dump('applications')[id]!.review).toMatchObject({ trial_period: true });
  });

  it('refuses to approve a declined or withdrawn application', async () => {
    const app = await boot(seed());
    const id = (await submit(app)).json().id;
    await app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: { action: 'decline', reason: 'no' } });
    expect((await approve(app, id)).statusCode).toBe(409);
  });

  it('works from under_review too', async () => {
    const app = await boot(seed());
    const id = (await submit(app)).json().id;
    await app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: { action: 'review' } });
    expect((await approve(app, id)).statusCode).toBe(200);
  });
});

describe('GET /api/applications/:id/uploads/:upload_id/url', () => {
  it('signs a read URL for the application\'s own upload, admin only', async () => {
    const db = seed();
    const app = await boot(db);
    const permitId = await upload(app);
    const id = (await submit(app, {
      products: [{ type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} }],
      permits: { dairy: { status: 'uploaded', upload_id: permitId } },
    })).json().id;

    const url = `/api/applications/${id}/uploads/${permitId}/url`;
    const res = await app.inject({ method: 'GET', url, headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    const stored = db.dump('application_uploads')[permitId]!;
    expect(res.json().url).toBe(`https://fake-storage.test/${stored.storage_path}?exp=${15 * 60_000}`);
    expect(new Date(res.json().expires_at).getTime()).toBe(T_OPEN.getTime() + 15 * 60_000);
    expect((await app.inject({ method: 'GET', url, headers: authFor('mgr1', 'market_manager') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('404s another application\'s upload', async () => {
    const db = seed();
    const app = await boot(db);
    const mine = await upload(app);
    const theirs = await upload(app, '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a');
    const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };
    const idA = (await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: mine } } })).json().id;
    const contact = { ...(validSubmission().contact as object), email: 'b@example.test' };
    const idB = (await submit(app, { draft_id: '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a', contact, products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: theirs } } })).json().id;
    expect(idB).not.toBe(idA);
    const res = await app.inject({ method: 'GET', url: `/api/applications/${idA}/uploads/${theirs}/url`, headers: adminAuth() });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/applications/${idA}/uploads/nope/url`, headers: adminAuth() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/applications/nope/uploads/${mine}/url`, headers: adminAuth() })).statusCode).toBe(404);
  });

  it('also signs the insurance certificate that moved onto the approved producer\'s membership', async () => {
    const db = seed();
    const app = await boot(db);
    const certId = await upload(app, DRAFT_ID, 'insurance');
    const id = (await submit(app, { insurance: { status: 'have', certificate_upload_id: certId, carrier: 'Acme', expires_on: '2027-12-31' } })).json().id;
    await app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: { action: 'approve', fee_plan: 'seasonal', spaces: 1, electric: false, pay_in_full: false } });
    // Detach it from the application to prove the membership link alone is enough.
    await db.collection('application_uploads').doc(certId).update({ application_id: 'something-else' });
    const res = await app.inject({ method: 'GET', url: `/api/applications/${id}/uploads/${certId}/url`, headers: adminAuth() });
    expect(res.statusCode).toBe(200);
  });
});

void ADMIN_PHONE;
