// Shared fixtures for the Phase 4 application tests (executor A1): a WLRFM-shaped
// market with a 2026 and a 2027 schedule version, a booth set, a valid public
// submission, and the real app booted over the fake Firestore with fake
// storage and the console providers. FAKE names and +1501555xxxx phones only.
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { fakeDb } from './fake-db.js';
import { fakeStorage } from './fake-storage.js';
import { signJwt } from '../../src/utils/jwt.js';
import { DEFAULT_QUIET_HOURS, DEFAULT_WORKFLOW } from '../../src/services/markets.js';
import type { Env } from '../../src/config/env.js';

vi.mock('../../src/services/error-notify.js', () => ({ notifyError: vi.fn(async () => {}) }));

export const env = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example',
  FROM_EMAIL: 'markets@test.example',
  VOIPMS_DID: '5015550999',
  VOIPMS_WEBHOOK_SECRET: '',
  ALERT_EMAIL: '',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as Env;

export type Db = ReturnType<typeof fakeDb>;
type Seed = Record<string, Record<string, Record<string, unknown>>>;

/** Applications are open in this window (market-local 2026-12-15 noon). */
export const T_OPEN = new Date('2026-12-15T18:00:00Z');
export const DRAFT_ID = '3f2b8c1e-5d4a-4e7b-9c1d-2a6f8e0b7c11';
export const ADMIN_PHONE = '+15015550001';
export const P1_PHONE = '+15015550101';
export const APPLICANT_PHONE_RAW = '(501) 555-0142';
export const APPLICANT_PHONE = '+15015550142';

export function market(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'West Little Rock Farmers Market',
    slug: 'wlrfm',
    location: { name: 'Breckenridge Village', address: '1 Market St' },
    timezone: 'America/Chicago',
    schedule: {
      versions: [
        {
          id: 'v26',
          effective_from: '2026-04-18',
          season_start: '2026-04-18',
          season_end: '2026-10-31',
          days_of_week: ['saturday'],
          start_time: '08:00',
          end_time: '12:00',
          created_at: new Date('2026-01-01'),
          created_by: 'import',
        },
        {
          id: 'v27',
          effective_from: '2027-01-01',
          season_start: '2027-04-03',
          season_end: '2027-11-27',
          days_of_week: ['saturday'],
          start_time: '08:00',
          end_time: '12:00',
          created_at: new Date('2026-11-08'),
          created_by: 'admin1',
        },
      ],
      skipped_dates: [],
      special_dates: [],
    },
    workflow: DEFAULT_WORKFLOW,
    quiet_hours: DEFAULT_QUIET_HOURS,
    season: { label: '2027', application_open: '2026-12-01', application_close: null, schedule_version_id: 'v27' },
    payment_links: { application_fee_url: 'https://pay.test.example/apply?email={email}', booth_fee_url: 'https://pay.test.example/booth' },
    legal: {
      rules_markdown: '# Rules\n\nSell what you grow.',
      rules_version: '2027-1',
      rules_url: null,
      hold_harmless_markdown: 'Hold harmless text.',
      hold_harmless_version: '2027-1',
      insurance_help_url: 'https://help.test.example/insurance',
      adh_guidelines_url: null,
      food_freedom_url: null,
    },
    booth_map_url: '/wlrfm-vendor-map.jpg',
    active: true,
    created_by: 'import',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...over,
  };
}

export function booths(): Record<string, Record<string, unknown>> {
  const row = (label: string, order: number, power = false) => ({
    market_id: 'wlrfm',
    label,
    row: 'west',
    order,
    kind: 'stall',
    power,
    size: '12x12',
    notes: '',
    active: true,
    created_at: new Date('2026-11-01'),
    updated_at: new Date('2026-11-01'),
  });
  return { wlrfm_v1: row('V1', 1), wlrfm_v2: row('V2', 2), wlrfm_v3: row('V3', 3, true) };
}

/** The standard seed: the market, one admin, one manager of another market, producer p1 with a 2026 membership (a Phase 2 doc, no season field). */
export function seed(extra: Seed = {}, marketOver: Record<string, unknown> = {}): Db {
  return fakeDb({
    farmers_markets: { wlrfm: market(marketOver), other: market({ name: 'Other Market', slug: 'other' }) },
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: ADMIN_PHONE, active: true },
      mgr1: { name: 'Manager', role: 'market_manager', phone: '+15015550002', assigned_market_ids: ['other'], active: true },
    },
    producers: {
      p1: {
        business_name: 'Testfield Farm',
        contact_name: 'Terry Testfield',
        email: 'owner@testfield.example',
        emails: ['owner@testfield.example'],
        phone: null,
        aliases: [],
        products: [],
        active: true,
        sms_opt_out_at: null,
        created_at: new Date('2026-09-01'),
        updated_at: new Date('2026-09-01'),
      },
    },
    producer_memberships: {
      p1_wlrfm: {
        producer_id: 'p1',
        market_id: 'wlrfm',
        status: 'active',
        fee_plan: 'weekly',
        usual_booth_id: null,
        history: [],
        source: 'import',
        created_at: new Date('2026-09-01'),
        updated_at: new Date('2026-09-01'),
      },
    },
    booths: booths(),
    ...extra,
  });
}

export async function boot(db: Db, storage = fakeStorage()): Promise<FastifyInstance & { fake: ReturnType<typeof fakeStorage> }> {
  const app = await buildApp({ db: db as never, env, storage, notifyOnError: false, logLevel: 'silent' });
  await app.ready();
  return Object.assign(app, { fake: storage });
}

export const authFor = (userId: string, role = 'admin') => ({ authorization: `Bearer ${signJwt({ sub: userId, role }, env.JWT_SECRET)}` });
export const adminAuth = () => authFor('admin1');

export function validSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: 'wlrfm',
    draft_id: DRAFT_ID,
    prefill_token: null,
    contact: {
      name: 'Terry Testfield',
      business_name: 'Testfield Farm',
      email: 'Owner@Testfield.example',
      mobile: APPLICANT_PHONE_RAW,
      website: 'https://testfield.example',
      social: '',
      address: { street: '1 Farm Rd', city: 'Little Rock', state: 'AR', zip: '72201' },
      description: 'Vegetables and eggs.',
      years_in_operation: 5,
      outlets: '',
      agricultural_practices: 'no_chemicals',
      additional_info: '',
    },
    sms_consent: true,
    sms_consent_version: 'sjca-sms-1',
    returning: { is_returning: false, last_stall: null },
    categories: ['farmers_ranchers'],
    products: [{ type: 'produce', items: ['tomatoes', 'peppers'], practices: ['compost'], description: '', details: {} }],
    permits: {},
    booth: { rate: 'seasonal', frequency: null, months: [], spaces: 2, electric: true, pay_in_full: true, stall_preference: [], food_truck: false },
    payment_methods: ['cash', 'card'],
    insurance: { status: 'none', certificate_upload_id: null, carrier: '', expires_on: null },
    acknowledgements: { rules: true, weekly_report: true, farm_visits: true, marketing: true, products_listed_only: true, own_booth_only: true },
    rules_version: '2027-1',
    signature_name: 'Terry Testfield',
    ...over,
  };
}

/** A multipart/form-data body with text fields and one file. */
export function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = '----a1boundary7MA4YWxkTrZu0gW';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake permit '.repeat(20))]);

export const rowsOfKind = (db: Db, kind: string) =>
  Object.entries(db.dump('messages'))
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, ...(m as Record<string, unknown>) }));

/** Lines the console providers printed, joined. Install with `vi.spyOn(console, 'log')` first. */
export function printed(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}
