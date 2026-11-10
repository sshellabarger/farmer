// Fix X8: a market manager never receives the evidence fields that belong to
// admins: producer.sms_consent.ip, the producer's street address, and
// membership.hold_harmless.ip / .token. Every staff route that returns a
// producer or a membership builds it through producerViewFor /
// membershipViewFor; admins still get everything. Driven through buildApp().
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { T_OPEN, adminAuth, authFor, boot, seed, type Db } from './helpers/a1-fixtures.js';
import { producerViewFor } from '../src/services/producers.js';
import { membershipFromData, membershipViewFor } from '../src/services/seasons.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Values that must never appear anywhere in a manager's response body.
const CONSENT_IP = '203.0.113.77';
const SIGN_IP = '198.51.100.23';
const SIGN_TOKEN = 'T'.repeat(43);
const STREET = '742 Evergreen Terrace';
const ZIP = '72299';
const NOTE = 'ADMIN NOTE: owes a certificate';
const SECRETS = [CONSENT_IP, SIGN_IP, SIGN_TOKEN, STREET, ZIP, NOTE];

const manager = () => authFor('mgr_w', 'market_manager');

function world(): Db {
  return seed({
    users: {
      admin1: { name: 'Admin', role: 'admin', active: true },
      mgr_w: { name: 'Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'], active: true },
      mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true },
    },
    producers: {
      p1: {
        business_name: 'Testfield Farm',
        contact_name: 'Terry Testfield',
        email: 'owner@testfield.example',
        emails: ['owner@testfield.example'],
        phone: '+15015550101',
        aliases: [],
        products: ['tomatoes'],
        notes: NOTE,
        address: { street: STREET, city: 'Little Rock', state: 'AR', zip: ZIP },
        sms_consent: { status: 'opted_in', at: new Date('2026-12-10T15:00:00Z'), source: 'application', text_version: 'sjca-sms-1', ip: CONSENT_IP },
        sms_opt_out_at: null,
        active: true,
        created_at: new Date('2026-09-01'),
        updated_at: new Date('2026-09-01'),
      },
    },
    producer_memberships: {
      p1_wlrfm_2027: {
        producer_id: 'p1',
        market_id: 'wlrfm',
        season: '2027',
        status: 'active',
        fee_plan: 'seasonal',
        spaces: 1,
        electric: false,
        approved_items: ['tomatoes'],
        item_requests: [{ id: 'r1', items: ['honey'], note: '', requested_at: new Date('2027-01-05'), source: 'producer', status: 'pending', decided_by: null, decided_at: null }],
        insurance: { status: 'on_file', expires_at: new Date('2027-07-01T05:00:00.000Z'), upload_id: null, verified_by: 'admin1', verified_at: new Date('2026-12-11'), note: '' },
        hold_harmless: { signed_at: new Date('2026-12-12T16:00:00Z'), name: 'Terry Testfield', ip: SIGN_IP, version: '2027-1', text_sha256: 'a'.repeat(64), token: SIGN_TOKEN },
        history: [],
        source: 'application',
        created_at: new Date('2026-12-11'),
        updated_at: new Date('2026-12-12'),
      },
    },
  });
}

/** No secret appears anywhere in the body, under any key. */
function expectClean(res: { body: string; statusCode: number }, label: string) {
  expect(res.statusCode, label).toBeLessThan(300);
  for (const secret of SECRETS) expect(res.body, `${label}: ${secret}`).not.toContain(secret);
}

describe('what a market manager receives', () => {
  it('GET /api/producers: no notes, no address, consent without its IP', async () => {
    const app = await boot(world());
    const res = await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: manager() });
    expectClean(res, 'list');
    const p = res.json().producers.find((x: { id: string }) => x.id === 'p1');
    expect(p).toMatchObject({ business_name: 'Testfield Farm', phone: '+15015550101', email: 'owner@testfield.example' });
    expect(p).not.toHaveProperty('notes');
    expect(p).not.toHaveProperty('address');
    expect(p.sms_consent).toEqual({ status: 'opted_in', at: '2026-12-10T15:00:00.000Z', source: 'application', text_version: 'sjca-sms-1' });
    expect(p.memberships).toEqual([{ market_id: 'wlrfm', status: 'active', season: '2027', fee_plan: 'seasonal', spaces: 1, electric: false }]);
  });

  it('GET /api/producers/:id: the same producer view, and the signature without ip or token', async () => {
    const app = await boot(world());
    const res = await app.inject({ method: 'GET', url: '/api/producers/p1', headers: manager() });
    expectClean(res, 'detail');
    const body = res.json();
    expect(body.producer).not.toHaveProperty('notes');
    expect(body.producer).not.toHaveProperty('address');
    expect(body.producer.sms_consent).not.toHaveProperty('ip');
    expect(body.producer.sms_consent.status).toBe('opted_in');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].hold_harmless).toEqual({ signed_at: '2026-12-12T16:00:00.000Z', name: 'Terry Testfield', version: '2027-1' });
    expect(body.invite).toBeNull();
  });

  it('GET /api/memberships (by market and by producer): the signature without ip or token', async () => {
    const app = await boot(world());
    for (const qs of ['market_id=wlrfm', 'producer_id=p1']) {
      const res = await app.inject({ method: 'GET', url: `/api/memberships?${qs}`, headers: manager() });
      expectClean(res, qs);
      const m = res.json().memberships[0];
      expect(m.hold_harmless).toEqual({ signed_at: '2026-12-12T16:00:00.000Z', name: 'Terry Testfield', version: '2027-1' });
      expect(m.producer).toEqual({ id: 'p1', business_name: 'Testfield Farm' });
    }
  });

  it('PATCH /api/memberships/:id: the response is the trimmed view, and the stored signature is untouched', async () => {
    const db = world();
    const app = await boot(db);
    const res = await app.inject({ method: 'PATCH', url: '/api/memberships/p1_wlrfm_2027', headers: manager(), payload: { spaces: 2 } });
    expectClean(res, 'patch');
    expect(res.json().membership).toMatchObject({ spaces: 2, hold_harmless: { name: 'Terry Testfield', version: '2027-1' } });
    expect(res.json().membership.hold_harmless).not.toHaveProperty('ip');
    expect(res.json().membership.hold_harmless).not.toHaveProperty('token');
    expect((db.dump('producer_memberships').p1_wlrfm_2027 as Record<string, any>).hold_harmless).toMatchObject({ ip: SIGN_IP, token: SIGN_TOKEN });
  });

  it('POST /api/memberships/:id/items: the trimmed view', async () => {
    const app = await boot(world());
    const res = await app.inject({ method: 'POST', url: '/api/memberships/p1_wlrfm_2027/items', headers: manager(), payload: { action: 'approve', request_id: 'r1' } });
    expectClean(res, 'items');
    expect(res.json().membership.approved_items).toEqual(['tomatoes', 'honey']);
    expect(res.json().membership.hold_harmless).toEqual({ signed_at: '2026-12-12T16:00:00.000Z', name: 'Terry Testfield', version: '2027-1' });
  });

  it('PATCH /api/memberships/:id/insurance: the trimmed view', async () => {
    const app = await boot(world());
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/memberships/p1_wlrfm_2027/insurance',
      headers: manager(),
      payload: { status: 'on_file', expires_on: '2027-12-31', note: 'Renewed' },
    });
    expectClean(res, 'insurance');
    expect(res.json().membership.insurance).toMatchObject({ status: 'on_file', expires_on: '2027-12-31' });
    expect(res.json().membership.hold_harmless).toEqual({ signed_at: '2026-12-12T16:00:00.000Z', name: 'Terry Testfield', version: '2027-1' });
  });

  it('a manager of another market still sees nothing of this producer', async () => {
    const app = await boot(world());
    const other = authFor('mgr1', 'market_manager');
    expect((await app.inject({ method: 'GET', url: '/api/producers/p1', headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: other })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/memberships?market_id=wlrfm', headers: other })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/memberships?producer_id=p1', headers: other })).json().memberships).toEqual([]);
  });
});

describe('what an admin receives', () => {
  it('everything, on the same routes', async () => {
    const app: FastifyInstance = await boot(world());
    const list = (await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: adminAuth() })).json().producers[0];
    expect(list).toMatchObject({ notes: NOTE, address: { street: STREET, zip: ZIP }, sms_consent: { ip: CONSENT_IP } });

    const detail = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers: adminAuth() })).json();
    expect(detail.producer).toMatchObject({ notes: NOTE, address: { street: STREET }, sms_consent: { ip: CONSENT_IP, text_version: 'sjca-sms-1' } });
    expect(detail.memberships[0].hold_harmless).toMatchObject({ name: 'Terry Testfield', ip: SIGN_IP, token: SIGN_TOKEN, version: '2027-1' });

    const memberships = (await app.inject({ method: 'GET', url: '/api/memberships?producer_id=p1', headers: adminAuth() })).json().memberships;
    expect(memberships[0].hold_harmless).toMatchObject({ ip: SIGN_IP, token: SIGN_TOKEN });

    const patched = await app.inject({ method: 'PATCH', url: '/api/memberships/p1_wlrfm_2027', headers: adminAuth(), payload: { electric: true } });
    expect(patched.json().membership.hold_harmless).toMatchObject({ ip: SIGN_IP, token: SIGN_TOKEN });

    const insured = await app.inject({ method: 'PATCH', url: '/api/memberships/p1_wlrfm_2027/insurance', headers: adminAuth(), payload: { status: 'waived' } });
    expect(insured.json().membership.hold_harmless).toMatchObject({ ip: SIGN_IP, token: SIGN_TOKEN });

    const edited = await app.inject({ method: 'PATCH', url: '/api/producers/p1', headers: adminAuth(), payload: { contact_name: 'Terry T.' } });
    expect(edited.json().producer).toMatchObject({ contact_name: 'Terry T.', notes: NOTE, address: { street: STREET }, sms_consent: { ip: CONSENT_IP } });
  });
});

describe('every staff view carries the insurance date as a calendar day (fix X11)', () => {
  it('derives it for a document that only stores the instant, in the market timezone, for admins and managers alike', async () => {
    const app = await boot(world());
    for (const headers of [adminAuth(), manager()]) {
      const detail = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers })).json();
      // Stored: the instant 2027-07-01T05:00Z (midnight on July 1 in Chicago). Shown: valid through June 30.
      expect(detail.memberships[0].insurance).toMatchObject({ status: 'on_file', expires_on: '2027-06-30', expires_at: '2027-07-01T05:00:00.000Z' });
      const listed = (await app.inject({ method: 'GET', url: '/api/memberships?market_id=wlrfm', headers })).json().memberships[0];
      expect(listed.insurance.expires_on).toBe('2027-06-30');
    }
  });
});

describe('producerViewFor / membershipViewFor', () => {
  const producer = { business_name: 'X', notes: 'n', address: { street: 's', city: 'c', state: 'AR', zip: 'z' }, sms_consent: { status: 'opted_in', ip: '1.2.3.4', text_version: 'v' }, phone: '+15015550100' };

  it('an admin gets the document as it is, plus its id', () => {
    expect(producerViewFor({ role: 'admin' }, 'p9', producer)).toEqual({ id: 'p9', ...producer });
  });

  it('anyone else loses notes, address and the consent IP, and nothing else; the stored object is not modified', () => {
    for (const role of ['market_manager', 'producer', '']) {
      expect(producerViewFor({ role }, 'p9', producer)).toEqual({ id: 'p9', business_name: 'X', sms_consent: { status: 'opted_in', text_version: 'v' }, phone: '+15015550100' });
    }
    expect(producer.sms_consent.ip).toBe('1.2.3.4');
    expect(producer.notes).toBe('n');
    // A producer with no consent object, or a malformed one, passes through.
    expect(producerViewFor({ role: 'market_manager' }, 'p9', { business_name: 'X' })).toEqual({ id: 'p9', business_name: 'X' });
    expect(producerViewFor({ role: 'market_manager' }, 'p9', { sms_consent: null })).toEqual({ id: 'p9', sms_consent: null });
  });

  it('the membership view trims the signature for a manager and keeps it for an admin; an unsigned membership stays null', () => {
    const signed = membershipFromData('m1', {
      producer_id: 'p',
      market_id: 'wlrfm',
      season: '2027',
      status: 'active',
      hold_harmless: { signed_at: new Date('2027-01-01T00:00:00Z'), name: 'N', ip: '9.9.9.9', version: 'v1', token: 'tok' },
    });
    expect(membershipViewFor({ role: 'market_manager' }, signed, { timezone: 'UTC' }).hold_harmless).toEqual({ signed_at: new Date('2027-01-01T00:00:00Z'), name: 'N', version: 'v1' });
    expect(membershipViewFor({ role: 'admin' }, signed, { timezone: 'UTC' }).hold_harmless).toMatchObject({ ip: '9.9.9.9', token: 'tok' });
    const unsigned = membershipFromData('m2', { producer_id: 'p', market_id: 'wlrfm', status: 'approved' });
    expect(membershipViewFor({ role: 'market_manager' }, unsigned, { timezone: 'UTC' }).hold_harmless).toBeNull();
    expect(membershipViewFor({ role: 'market_manager' }, unsigned, { timezone: 'UTC' }).insurance.expires_on).toBeNull();
  });
});
