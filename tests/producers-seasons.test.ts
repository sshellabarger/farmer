import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { T_OPEN, adminAuth, authFor, boot, seed, type Db } from './helpers/a1-fixtures.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
});
afterEach(() => {
  vi.useRealTimers();
});

function seasons(marketOver: Record<string, unknown> = {}): Db {
  return seed(
    {
      users: {
        admin1: { name: 'Admin', role: 'admin', active: true },
        mgr_w: { name: 'Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'], active: true },
        mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true },
      },
      producers: {
        p1: { business_name: 'Alpha Farm', notes: 'admin only note', aliases: [], active: true },
        p2: { business_name: 'Bravo Farm', notes: 'another note', aliases: [], active: true },
        p3: { business_name: 'Charlie Farm', notes: '', aliases: [], active: true },
      },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly', created_at: new Date('2026-09-01') },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', fee_plan: 'seasonal', spaces: 2, electric: true, created_at: new Date('2026-12-01') },
        p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active', fee_plan: 'both', created_at: new Date('2026-09-01') },
        p3_wlrfm_2027: { producer_id: 'p3', market_id: 'wlrfm', season: '2027', status: 'active', fee_plan: 'daily', created_at: new Date('2026-12-02') },
      },
    },
    marketOver,
  );
}

const list = async (db: Db, qs: string, headers = adminAuth()) => {
  const app = await boot(db);
  const res = await app.inject({ method: 'GET', url: `/api/producers?${qs}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json().producers as { id: string; memberships: Record<string, unknown>[]; notes?: string }[];
};

describe('GET /api/producers with a market: the current season only', () => {
  it('status=active counts current-season memberships only', async () => {
    // Season label 2027: p1 (2026 active, 2027 approved) is NOT active in 2027; p2 has no 2027 row.
    expect((await list(seasons(), 'market_id=wlrfm&status=active')).map((p) => p.id)).toEqual(['p3']);
    expect((await list(seasons(), 'market_id=wlrfm&status=approved')).map((p) => p.id)).toEqual(['p1']);
  });

  it('without a status, lists the vendors of the current season', async () => {
    const producers = await list(seasons(), 'market_id=wlrfm');
    expect(producers.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(producers[0]!.memberships).toEqual([{ market_id: 'wlrfm', status: 'approved', season: '2027', fee_plan: 'seasonal', spaces: 2, electric: true }]);
    expect(producers[1]!.memberships[0]).toMatchObject({ season: '2027', fee_plan: 'daily', spaces: 1, electric: false });
  });

  it('before the season label is set the current season is the inferred one (2026)', async () => {
    const db = seasons({ season: null });
    expect((await list(db, 'market_id=wlrfm&status=active')).map((p) => p.id)).toEqual(['p1', 'p2']);
    const entry = (await list(db, 'market_id=wlrfm')).find((p) => p.id === 'p2')!.memberships[0]!;
    expect(entry).toMatchObject({ season: '2026', fee_plan: 'seasonal' }); // Phase 2 "both" reads as seasonal
  });

  it('an explicit season overrides; all producers across seasons without a market', async () => {
    expect((await list(seasons(), 'market_id=wlrfm&season=2026')).map((p) => p.id)).toEqual(['p1', 'p2']);
    const all = await list(seasons(), '');
    expect(all.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(all[0]!.memberships).toHaveLength(2); // history stays attached
  });

  it('a manager still needs a market and never sees notes', async () => {
    const managers = await list(seasons(), 'market_id=wlrfm', authFor('mgr_w', 'market_manager'));
    expect(managers.every((p) => p.notes === undefined)).toBe(true);
    const app = await boot(seasons());
    expect((await app.inject({ method: 'GET', url: '/api/producers', headers: authFor('mgr_w', 'market_manager') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/producers?market_id=wlrfm', headers: authFor('mgr1', 'market_manager') })).statusCode).toBe(403);
  });
});

describe('GET /api/producers/:id', () => {
  it('lists every season newest first, with the current season of each market', async () => {
    const app = await boot(seasons());
    const body = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers: adminAuth() })).json();
    expect(body.memberships.map((m: { id: string; season: string }) => [m.id, m.season])).toEqual([
      ['p1_wlrfm_2027', '2027'],
      ['p1_wlrfm', '2026'],
    ]);
    expect(body.memberships[1]).toMatchObject({ fee_plan: 'daily', fee_plan_raw: 'weekly', insurance: { status: 'missing' }, hold_harmless: null });
    expect(body.current_season_by_market).toEqual({ wlrfm: '2027' });
    expect(body.invite).toBeNull();
    expect(body.producer.notes).toBe('admin only note');
  });

  it('a manager sees only their market\'s memberships and no notes', async () => {
    const db = seasons();
    await db.collection('producer_memberships').doc('p1_other_2027').set({ producer_id: 'p1', market_id: 'other', season: '2027', status: 'active' });
    const app = await boot(db);
    const body = (await app.inject({ method: 'GET', url: '/api/producers/p1', headers: authFor('mgr_w', 'market_manager') })).json();
    expect(body.memberships.every((m: { market_id: string }) => m.market_id === 'wlrfm')).toBe(true);
    expect(body.producer.notes).toBeUndefined();
    expect(Object.keys(body.current_season_by_market)).toEqual(['wlrfm']);
    expect((await app.inject({ method: 'GET', url: '/api/producers/p2', headers: authFor('mgr1', 'market_manager') })).statusCode).toBe(404);
  });
});

describe('POST /api/producers', () => {
  it('creates its memberships in the market\'s current season', async () => {
    const db = seasons();
    const app = await boot(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/producers',
      headers: adminAuth(),
      payload: { business_name: 'New Farm', email: 'new@example.test', memberships: [{ market_id: 'wlrfm', fee_plan: 'season' }] },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().producer.id as string;
    expect(res.json().memberships[0]).toMatchObject({ id: `${id}_wlrfm_2027`, season: '2027', status: 'approved', fee_plan: 'seasonal' });
    expect(db.dump('producer_memberships')[`${id}_wlrfm_2027`]).toMatchObject({ season: '2027', fee_plan: 'seasonal', spaces: 1 });
  });
});

describe('PATCH /api/producers/:id — profile fields (contract §2.3)', () => {
  const patch = (app: Awaited<ReturnType<typeof boot>>, payload: Record<string, unknown>, headers = adminAuth()) =>
    app.inject({ method: 'PATCH', url: '/api/producers/p1', headers, payload: payload as never });

  it('stores the application profile fields', async () => {
    const db = seasons();
    const app = await boot(db);
    const res = await patch(app, {
      website: 'https://alpha.example',
      social: '@alphafarm',
      address: { street: '2 Farm Rd', city: 'Conway', state: 'AR', zip: '72032' },
      description_public: 'Pastured poultry.',
      years_in_operation: 12,
      outlets: 'Two other markets',
      agricultural_practices: 'certified_naturally_grown',
      categories: ['farmers_ranchers'],
      payment_methods: ['cash', 'snap'],
      products: [{ type: 'eggs', items: ['eggs'], practices: ['free_range'], description: '', details: {} }],
      logo_upload_id: '3f2b8c1e-5d4a-4e7b-9c1d-2a6f8e0b7c11',
    });
    expect(res.statusCode).toBe(200);
    expect(db.dump('producers').p1).toMatchObject({
      website: 'https://alpha.example',
      address: { street: '2 Farm Rd', city: 'Conway', state: 'AR', zip: '72032' },
      years_in_operation: 12,
      agricultural_practices: 'certified_naturally_grown',
      categories: ['farmers_ranchers'],
      payment_methods: ['cash', 'snap'],
      logo_upload_id: '3f2b8c1e-5d4a-4e7b-9c1d-2a6f8e0b7c11',
    });
    expect((db.dump('producers').p1!.products as unknown[])[0]).toMatchObject({ type: 'eggs', items: ['eggs'] });
    expect((await patch(app, { address: null, years_in_operation: null, agricultural_practices: null, logo_upload_id: null })).statusCode).toBe(200);
    expect(db.dump('producers').p1).toMatchObject({ address: null, years_in_operation: null, agricultural_practices: null, logo_upload_id: null });
  });

  it('rejects malformed profile values', async () => {
    const app = await boot(seasons());
    expect((await patch(app, { agricultural_practices: 'organic-ish' })).statusCode).toBe(400);
    expect((await patch(app, { products: [{ type: 'eggs', items: [] }] })).statusCode).toBe(400);
    expect((await patch(app, { payment_methods: ['bitcoin'] })).statusCode).toBe(400);
    expect((await patch(app, { years_in_operation: -2 })).statusCode).toBe(400);
  });

  it('refuses a phone number another producer holds', async () => {
    const db = seasons();
    await db.collection('producers').doc('p2').update({ phone: '+15015550102' });
    const app = await boot(db);
    const res = await patch(app, { phone: '+15015550102' });
    expect(res.statusCode).toBe(409);
    expect(res.json().producer_id).toBe('p2');
    expect((await patch(app, { phone: '+15015550103' })).statusCode).toBe(200);
  });

  it('is admin only', async () => {
    const app = await boot(seasons());
    expect((await patch(app, { website: 'https://x.example' }, authFor('mgr_w', 'market_manager'))).statusCode).toBe(403);
  });
});
