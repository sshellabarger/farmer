import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { adminAuth, authFor, boot, market, seed, T_OPEN } from './helpers/a1-fixtures.js';
import { DEFAULT_CATEGORIES, DEFAULT_FEES, DEFAULT_PRODUCT_TYPES } from '../src/services/markets.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
});
afterEach(() => {
  vi.useRealTimers();
});

const get = async (db: ReturnType<typeof seed>, url: string, headers: Record<string, string> = {}) => {
  const app = await boot(db);
  return app.inject({ method: 'GET', url, headers });
};

describe('GET /api/applications/config', () => {
  it('describes the 2027 season: 35 Saturdays, April to November, open now', async () => {
    const res = await get(seed(), '/api/applications/config?market=wlrfm');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market).toMatchObject({ id: 'wlrfm', name: 'West Little Rock Farmers Market', timezone: 'America/Chicago', booth_map_url: '/wlrfm-vendor-map.jpg' });
    expect(body.season).toMatchObject({
      label: '2027',
      schedule_version_id: 'v27',
      start: '2027-04-03',
      end: '2027-11-27',
      market_count: 35,
      days_of_week: ['saturday'],
      start_time: '08:00',
      end_time: '12:00',
      open_now: true,
    });
    expect(body.months.map((m: { key: string }) => m.key)).toEqual(['april', 'may', 'june', 'july', 'august', 'september', 'october', 'november']);
  });

  it('a skipped date lowers the count; a special date inside the range raises it', async () => {
    const skipped = market();
    (skipped.schedule as { skipped_dates: unknown[] }).skipped_dates = [{ date: '2027-07-03', reason: 'July 4th weekend' }];
    expect((await get(seed({}, skipped), '/api/applications/config?market=wlrfm')).json().season.market_count).toBe(34);

    const special = market();
    (special.schedule as { special_dates: unknown[] }).special_dates = [{ date: '2027-12-18', start_time: '09:00', end_time: '13:00', note: 'x' }, { date: '2027-06-09', start_time: '16:00', end_time: '19:00', note: 'evening' }];
    // 2027-12-18 is outside the season range and is not counted; 2027-06-09 (a Wednesday) is.
    expect((await get(seed({}, special), '/api/applications/config?market=wlrfm')).json().season.market_count).toBe(36);
  });

  it('open_now follows the application window in the market zone', async () => {
    const window = { label: '2027', application_open: '2026-12-01', application_close: '2026-12-31', schedule_version_id: 'v27' };
    const check = async (at: string) => {
      vi.setSystemTime(new Date(at));
      return (await get(seed({}, { season: window }), '/api/applications/config?market=wlrfm')).json().season.open_now;
    };
    expect(await check('2026-11-30T12:00:00Z')).toBe(false);
    expect(await check('2026-12-01T07:00:00Z')).toBe(true); // 01:00 on the 1st in Chicago
    expect(await check('2026-12-31T12:00:00Z')).toBe(true);
    expect(await check('2027-01-01T07:00:00Z')).toBe(false); // 01:00 on Jan 1 in Chicago
  });

  it('applications are closed until the season label is set; the label then reads as the inferred season', async () => {
    const res = await get(seed({}, { season: null }), '/api/applications/config?market=wlrfm');
    expect(res.statusCode).toBe(200);
    expect(res.json().season).toMatchObject({ label: '2026', open_now: false, schedule_version_id: 'v27' }); // greatest season_start when none is named
  });

  it('serves the fee, category and product-type defaults and withholds the legal bodies', async () => {
    const body = (await get(seed(), '/api/applications/config?market=wlrfm')).json();
    expect(body.fees).toEqual(DEFAULT_FEES);
    expect(body.categories).toEqual(DEFAULT_CATEGORIES);
    expect(body.product_types).toHaveLength(DEFAULT_PRODUCT_TYPES.length);
    expect(body.product_types.map((t: { key: string }) => t.key)).toEqual([
      'produce', 'meat_poultry', 'eggs', 'dairy', 'honey_sorghum', 'value_added', 'prepared_food', 'non_food', 'education',
    ]);
    expect(body.legal.has_rules_text).toBe(true);
    expect(body.legal.rules_version).toBe('2027-1');
    expect(body.legal.sms_consent_version).toBe('sjca-sms-1');
    expect(body.legal.rules_markdown).toBeUndefined();
    expect(body.legal.hold_harmless_markdown).toBeUndefined();
    expect(body.limits).toEqual({ upload_max_bytes: 10 * 1024 * 1024, upload_mimes: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'], stall_preference_max: 3, upload_retention_hours: 48 });
    expect(body.payment_links.application_fee_url).toContain('{email}'); // the template; the submit response fills it
  });

  it('lists active booths in row/order with usually_taken from current-season memberships only', async () => {
    const db = seed({
      booths: {
        wlrfm_v2: { market_id: 'wlrfm', label: 'V2', row: 'west', order: 2, kind: 'stall', power: false, size: '12x12', active: true },
        wlrfm_v1: { market_id: 'wlrfm', label: 'V1', row: 'west', order: 1, kind: 'stall', power: true, size: '12x12', active: true },
        wlrfm_v3: { market_id: 'wlrfm', label: 'V3', row: 'west', order: 3, kind: 'stall', power: false, size: '12x12', active: false },
        other_v1: { market_id: 'other', label: 'V1', row: 'west', order: 1, kind: 'stall', power: false, size: '12x12', active: true },
      },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', usual_booth_id: 'wlrfm_v2' }, // 2026: does not count
        p2_wlrfm_2027: { producer_id: 'p2', market_id: 'wlrfm', season: '2027', status: 'approved', usual_booth_id: 'wlrfm_v1' },
      },
    });
    const stalls = (await get(db, '/api/applications/config?market=wlrfm')).json().stalls;
    expect(stalls.map((s: { label: string }) => s.label)).toEqual(['V1', 'V2']);
    expect(stalls[0]).toMatchObject({ id: 'wlrfm_v1', power: true, usually_taken: true, kind: 'stall', row: 'west', order: 1, size: '12x12' });
    expect(stalls[1]).toMatchObject({ id: 'wlrfm_v2', usually_taken: false });
  });

  it('404s an unknown or inactive market and 400s a malformed one', async () => {
    const db = seed({ farmers_markets: { closed: market({ active: false }) } });
    expect((await get(db, '/api/applications/config?market=closed')).statusCode).toBe(404);
    expect((await get(db, '/api/applications/config?market=nope')).statusCode).toBe(404);
    expect((await get(db, '/api/applications/config?market=NOPE!')).statusCode).toBe(400);
    expect((await get(db, '/api/applications/config')).statusCode).toBe(400);
  });
});

describe('GET /api/markets/:id/rules', () => {
  it('serves the rules text, version and season to the public', async () => {
    const res = await get(seed(), '/api/markets/wlrfm/rules');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ market_id: 'wlrfm', market_name: 'West Little Rock Farmers Market', season: '2027', rules_version: '2027-1', rules_markdown: '# Rules\n\nSell what you grow.', rules_url: null });
    expect(res.json().updated_at).toBeTruthy();
  });

  it('404s when the market has no rules text and no rules link, or does not exist', async () => {
    const empty = seed({}, { legal: undefined });
    expect((await get(empty, '/api/markets/wlrfm/rules')).statusCode).toBe(404);
    expect((await get(seed(), '/api/markets/nope/rules')).statusCode).toBe(404);
  });

  it('a link alone is enough', async () => {
    const db = seed({}, { legal: { rules_markdown: '', rules_url: 'https://rules.test.example/2027.pdf', rules_version: '2027-1' } });
    const res = await get(db, '/api/markets/wlrfm/rules');
    expect(res.statusCode).toBe(200);
    expect(res.json().rules_url).toBe('https://rules.test.example/2027.pdf');
  });

  it('404s an inactive market even when it has rules', async () => {
    const db = seed({ farmers_markets: { wlrfm: market(), gone: market({ slug: 'gone', active: false }) } });
    expect((await get(db, '/api/markets/gone/rules')).statusCode).toBe(404);
    expect((await get(db, '/api/markets/wlrfm/rules')).statusCode).toBe(200);
  });

  it('404s an id that is not a market slug without asking Firestore (the admin SDK throws on such ids)', async () => {
    const db = seed();
    // What the real SDK does with a document id that is empty, has a slash, or is reserved.
    const collection = db.collection.bind(db);
    const asked: string[] = [];
    db.collection = ((name: string) => {
      const col = collection(name);
      if (name !== 'farmers_markets') return col;
      const doc = col.doc.bind(col);
      col.doc = ((id?: string) => {
        asked.push(String(id));
        if (!id || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
          throw new Error(`Value for argument "documentPath" is not a valid resource path: "${id}"`);
        }
        return doc(id);
      }) as never;
      return col;
    }) as never;
    const app = await boot(db);
    for (const bad of ['a%2Fb', 'wlrfm%2Fsecret', '%2Fwlrfm', 'a%2F%2E%2E%2Fb', '__name__', 'WLRFM', 'has%20space', 'x', 'a'.repeat(40), '%00']) {
      const res = await app.inject({ method: 'GET', url: `/api/markets/${bad}/rules` });
      expect(res.statusCode, bad).toBe(404);
    }
    expect(asked).toEqual([]);
    // A well-formed id still reaches the database.
    expect((await app.inject({ method: 'GET', url: '/api/markets/wlrfm/rules' })).statusCode).toBe(200);
    expect(asked).toEqual(['wlrfm']);
  });
});

describe('PATCH /api/markets/:id — season, fees, payment links, legal texts, booth map', () => {
  const patch = async (db: ReturnType<typeof seed>, payload: unknown, headers = adminAuth()) => {
    const app = await boot(db);
    return app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers, payload: payload as never });
  };

  it('writes season as a whole field and audits before/after', async () => {
    const db = seed({}, { season: null });
    const res = await patch(db, { season: { label: '2027', application_open: '2026-12-01', application_close: '2027-03-01', schedule_version_id: 'v27' } });
    expect(res.statusCode).toBe(200);
    expect(db.dump('farmers_markets').wlrfm!.season).toEqual({ label: '2027', application_open: '2026-12-01', application_close: '2027-03-01', schedule_version_id: 'v27' });
    const audit = Object.values(db.dump('audit_log')).find((a) => a.action === 'market.update')!;
    expect(audit.before).toMatchObject({ season: null });
    expect(audit.after).toMatchObject({ season: { label: '2027' } });
  });

  it('rejects a season whose schedule version does not exist, a bad label and an inverted window', async () => {
    const db = seed();
    expect((await patch(db, { season: { label: '2027', schedule_version_id: 'nope' } })).statusCode).toBe(400);
    expect((await patch(db, { season: { label: 'next year' } })).statusCode).toBe(400);
    expect((await patch(db, { season: { label: '2027', application_open: '2027-02-01', application_close: '2027-01-01' } })).statusCode).toBe(400);
  });

  it('null clears the season', async () => {
    const db = seed();
    expect((await patch(db, { season: null })).statusCode).toBe(200);
    expect(db.dump('farmers_markets').wlrfm!.season).toBeNull();
  });

  it('merges fee keys into the defaults and writes the whole object', async () => {
    const db = seed();
    const res = await patch(db, { fees: { daily: 30, currency: 'usd' } });
    expect(res.statusCode).toBe(200);
    expect(db.dump('farmers_markets').wlrfm!.fees).toEqual({ ...DEFAULT_FEES, daily: 30 });
    expect((await patch(db, { fees: { daily: -1 } })).statusCode).toBe(400);
    expect((await patch(db, { fees: { daily: 2.5 } })).statusCode).toBe(400);
    expect((await patch(db, { fees: { currency: 'dollars' } })).statusCode).toBe(400);
  });

  it('only http(s) links are accepted, and the booth map is a path or a link', async () => {
    const db = seed();
    expect((await patch(db, { payment_links: { booth_fee_url: 'javascript:alert(1)' } })).statusCode).toBe(400);
    expect((await patch(db, { legal: { insurance_help_url: 'data:text/html,hi' } })).statusCode).toBe(400);
    expect((await patch(db, { booth_map_url: '//evil.example/x.jpg' })).statusCode).toBe(400);
    expect((await patch(db, { payment_links: { booth_fee_url: 'https://pay.test.example/booth?e={email}' } })).statusCode).toBe(200);
    expect((await patch(db, { booth_map_url: '/wlrfm-vendor-map.jpg' })).statusCode).toBe(200);
    expect(db.dump('farmers_markets').wlrfm!.booth_map_url).toBe('/wlrfm-vendor-map.jpg');
    expect((await patch(db, { booth_map_url: null })).statusCode).toBe(200);
  });

  it('legal merges and the audit row carries versions and lengths, not the bodies', async () => {
    const db = seed();
    const res = await patch(db, { legal: { rules_version: '2027-2', rules_markdown: 'New rules text.' } });
    expect(res.statusCode).toBe(200);
    const legal = db.dump('farmers_markets').wlrfm!.legal as Record<string, unknown>;
    expect(legal).toMatchObject({ rules_version: '2027-2', rules_markdown: 'New rules text.', hold_harmless_version: '2027-1', sms_consent_version: 'sjca-sms-1' });
    const audit = Object.values(db.dump('audit_log')).find((a) => a.action === 'market.update')!;
    expect(JSON.stringify(audit)).not.toContain('New rules text.');
    expect((audit.after as { legal: Record<string, unknown> }).legal).toMatchObject({ rules_version: '2027-2', rules_markdown_length: 15 });
  });

  it('the insurance requirement is market data: empty by default, set through PATCH, served on the public config (fix X7)', async () => {
    const db = seed();
    const app = await boot(db);
    const config = async () => (await app.inject({ method: 'GET', url: '/api/applications/config?market=wlrfm' })).json();
    // A market that has not set it says nothing.
    expect((await config()).legal.insurance_requirements_text).toBe('');

    const wording = '  All vendors must carry $1,000,000 in general liability insurance naming Example Landlord, LLC as additional insured.  ';
    const res = await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: adminAuth(), payload: { legal: { insurance_requirements_text: wording } } });
    expect(res.statusCode).toBe(200);
    const legal = db.dump('farmers_markets').wlrfm!.legal as Record<string, unknown>;
    expect(legal.insurance_requirements_text).toBe(wording.trim());
    expect(legal).toMatchObject({ rules_version: '2027-1', hold_harmless_version: '2027-1' }); // the other legal fields are kept
    expect((await config()).legal.insurance_requirements_text).toBe(wording.trim());
    expect(res.json().market.legal.insurance_requirements_text).toBe(wording.trim());

    // It can be cleared again, and it is bounded.
    expect((await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: adminAuth(), payload: { legal: { insurance_requirements_text: '' } } })).statusCode).toBe(200);
    expect((await config()).legal.insurance_requirements_text).toBe('');
    expect((await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: adminAuth(), payload: { legal: { insurance_requirements_text: 'x'.repeat(2001) } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/markets/wlrfm', headers: adminAuth(), payload: { legal: { insurance_requirements_text: 7 } } })).statusCode).toBe(400);
  });

  it('categories and product types are validated as whole arrays, keys unique and cross-referenced', async () => {
    const db = seed();
    const category = { key: 'farmers_ranchers', label: 'Farmers', description: '', events_only: false, sort: 1 };
    expect((await patch(db, { categories: [category, category] })).statusCode).toBe(400);
    expect((await patch(db, { categories: [{ ...category, key: 'Bad Key' }] })).statusCode).toBe(400);
    const type = { key: 'honey', label: 'Honey', category_keys: ['unknown_cat'], permit_upload: 'none', sort: 1 };
    expect((await patch(db, { product_types: [type] })).statusCode).toBe(400);
    const ok = await patch(db, { categories: [category], product_types: [{ ...type, category_keys: ['farmers_ranchers'] }] });
    expect(ok.statusCode).toBe(200);
    expect(db.dump('farmers_markets').wlrfm!.categories).toEqual([category]);
    expect((db.dump('farmers_markets').wlrfm!.product_types as unknown[])).toHaveLength(1);
  });

  it('is admin only', async () => {
    const db = seed();
    expect((await patch(db, { fees: { daily: 30 } }, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await patch(db, { fees: { daily: 30 } }, {} as never)).statusCode).toBe(401);
  });
});
