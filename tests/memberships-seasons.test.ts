import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { T_OPEN, adminAuth, authFor, boot, seed } from './helpers/a1-fixtures.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
});
afterEach(() => {
  vi.useRealTimers();
});

const managerOfWlrfm = { name: 'Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'], active: true };

describe('GET /api/memberships', () => {
  const twoSeasons = () =>
    seed({
      users: { admin1: { name: 'Admin', role: 'admin', active: true }, mgr_w: managerOfWlrfm, mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true } },
      producers: { p1: { business_name: 'Testfield Farm', active: true }, p2: { business_name: 'Sample Produce', active: true } },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly' },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', fee_plan: 'seasonal', spaces: 2 },
        p2_wlrfm: { producer_id: 'p2', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly' },
      },
    });

  it('a market\'s list defaults to its current season', async () => {
    const app = await boot(twoSeasons());
    const res = await app.inject({ method: 'GET', url: '/api/memberships?market_id=wlrfm', headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toEqual([expect.objectContaining({ id: 'p1_wlrfm_2027', season: '2027', fee_plan: 'seasonal', spaces: 2, producer: { id: 'p1', business_name: 'Testfield Farm' } })]);
  });

  it('season can be named, or all', async () => {
    const app = await boot(twoSeasons());
    const ids = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/memberships?${qs}`, headers: adminAuth() })).json().memberships.map((m: { id: string }) => m.id).sort();
    expect(await ids('market_id=wlrfm&season=2026')).toEqual(['p1_wlrfm', 'p2_wlrfm']);
    expect(await ids('market_id=wlrfm&season=all')).toEqual(['p1_wlrfm', 'p1_wlrfm_2027', 'p2_wlrfm']);
  });

  it('a producer\'s list shows every season; a manager sees only their markets', async () => {
    const app = await boot(twoSeasons());
    const all = (await app.inject({ method: 'GET', url: '/api/memberships?producer_id=p1', headers: adminAuth() })).json().memberships;
    expect(all.map((m: { season: string }) => m.season).sort()).toEqual(['2026', '2027']);
    expect(all.find((m: { season: string }) => m.season === '2026')).toMatchObject({ fee_plan: 'daily', fee_plan_raw: 'weekly' });
    const other = (await app.inject({ method: 'GET', url: '/api/memberships?producer_id=p1', headers: authFor('mgr1', 'market_manager') })).json().memberships;
    expect(other).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/memberships?market_id=wlrfm', headers: authFor('mgr1', 'market_manager') })).statusCode).toBe(403);
  });
});

describe('POST /api/memberships', () => {
  const post = (app: Awaited<ReturnType<typeof boot>>, payload: Record<string, unknown>, headers = adminAuth()) =>
    app.inject({ method: 'POST', url: '/api/memberships', headers, payload: payload as never });

  it('defaults the season to the market\'s current one and allows a 2027 row beside a 2026 row', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await post(app, { producer_id: 'p1', market_id: 'wlrfm' });
    expect(res.statusCode).toBe(201);
    expect(res.json().membership).toMatchObject({
      id: 'p1_wlrfm_2027',
      season: '2027',
      status: 'approved',
      fee_plan: 'daily',
      spaces: 1,
      electric: false,
      pay_in_full: false,
      booth_kind: 'stall',
      usual_booth_id: null,
      trial_period: false,
      approved_by: 'admin1',
      source: 'admin',
    });
    expect(res.json().membership.approved_at).toBeTruthy();
    expect(db.dump('producer_memberships').p1_wlrfm).toMatchObject({ status: 'active' });
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'membership.create')).toHaveLength(1);
  });

  it('409s a same-season duplicate, including a Phase 2 row that reads as 2026', async () => {
    const app = await boot(seed());
    expect((await post(app, { producer_id: 'p1', market_id: 'wlrfm' })).statusCode).toBe(201);
    const dupe = await post(app, { producer_id: 'p1', market_id: 'wlrfm' });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().membership_id).toBe('p1_wlrfm_2027');
    const legacy = await post(app, { producer_id: 'p1', market_id: 'wlrfm', season: '2026' });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().membership_id).toBe('p1_wlrfm');
  });

  it('takes the Phase 4 fields, normalises the fee plan and checks the booth', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await post(app, { producer_id: 'p1', market_id: 'wlrfm', season: '2027-fall', status: 'active', fee_plan: 'season', spaces: 2, electric: true, pay_in_full: true, booth_kind: 'food_truck', usual_booth_id: 'wlrfm_v1' });
    expect(res.statusCode).toBe(201);
    expect(res.json().membership).toMatchObject({ id: 'p1_wlrfm_2027-fall', season: '2027-fall', status: 'active', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true, booth_kind: 'food_truck', usual_booth_id: 'wlrfm_v1' });
    expect((await post(app, { producer_id: 'p1', market_id: 'wlrfm', season: '2028', usual_booth_id: 'nope' })).statusCode).toBe(400);
    expect((await post(app, { producer_id: 'p1', market_id: 'wlrfm', season: 'someday' })).statusCode).toBe(400);
    expect((await post(app, { producer_id: 'p1', market_id: 'wlrfm', season: '2028', spaces: 3 })).statusCode).toBe(400);
  });

  it('404s an unknown producer or market and is admin only', async () => {
    const app = await boot(seed());
    expect((await post(app, { producer_id: 'nope', market_id: 'wlrfm' })).statusCode).toBe(404);
    expect((await post(app, { producer_id: 'p1', market_id: 'nope' })).statusCode).toBe(404);
    expect((await post(app, { producer_id: 'p1', market_id: 'wlrfm' }, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
  });
});

describe('PATCH /api/memberships/:id', () => {
  const patch = (app: Awaited<ReturnType<typeof boot>>, id: string, payload: Record<string, unknown>, headers = adminAuth()) =>
    app.inject({ method: 'PATCH', url: `/api/memberships/${id}`, headers, payload: payload as never });

  const withApproved = () =>
    seed({
      users: { admin1: { name: 'Admin', role: 'admin', active: true }, mgr_w: managerOfWlrfm, mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true } },
      producer_memberships: {
        p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active', fee_plan: 'weekly', history: [] },
        p1_wlrfm_2027: { producer_id: 'p1', market_id: 'wlrfm', season: '2027', status: 'approved', fee_plan: 'daily', spaces: 1, history: [{ from: null, to: 'approved' }] },
      },
    });

  it('updates the Phase 4 fields and audits membership.update', async () => {
    const db = withApproved();
    const app = await boot(db);
    const res = await patch(app, 'p1_wlrfm_2027', { fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true, booth_kind: 'food_truck', trial_period: true, usual_booth_id: 'wlrfm_v3' });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toMatchObject({ season: '2027', status: 'approved', fee_plan: 'seasonal', spaces: 2, electric: true, pay_in_full: true, booth_kind: 'food_truck', trial_period: true, usual_booth_id: 'wlrfm_v3' });
    expect(db.dump('producer_memberships').p1_wlrfm_2027).toMatchObject({ fee_plan: 'seasonal', usual_booth_id: 'wlrfm_v3' });
    const audit = Object.values(db.dump('audit_log')).filter((a) => a.action === 'membership.update');
    expect(audit).toHaveLength(1);
    // clearing the booth
    expect((await patch(app, 'p1_wlrfm_2027', { usual_booth_id: null })).json().membership.usual_booth_id).toBeNull();
  });

  it('transitions approved -> active with history, and refuses an illegal move', async () => {
    const db = withApproved();
    const app = await boot(db);
    const res = await patch(app, 'p1_wlrfm_2027', { status: 'active', note: 'Agreement on file' });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership.status).toBe('active');
    expect(db.dump('producer_memberships').p1_wlrfm_2027!.history).toHaveLength(2);
    expect((db.dump('producer_memberships').p1_wlrfm_2027!.history as Record<string, unknown>[])[1]).toMatchObject({ from: 'approved', to: 'active', by: 'admin1', note: 'Agreement on file' });
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'membership.transition')).toHaveLength(1);
    const illegal = await patch(app, 'p1_wlrfm_2027', { status: 'approved' });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json()).toMatchObject({ from: 'active', to: 'approved' });
  });

  it('rejects a booth that is not active at the market and bad values', async () => {
    const app = await boot(withApproved());
    expect((await patch(app, 'p1_wlrfm_2027', { usual_booth_id: 'nope' })).statusCode).toBe(400);
    expect((await patch(app, 'p1_wlrfm_2027', { spaces: 5 })).statusCode).toBe(400);
    expect((await patch(app, 'p1_wlrfm_2027', { booth_kind: 'castle' })).statusCode).toBe(400);
  });

  it('patching a Phase 2 row does not give it a season', async () => {
    const db = withApproved();
    const app = await boot(db);
    const res = await patch(app, 'p1_wlrfm', { fee_plan: 'both' });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toMatchObject({ season: '2026', fee_plan: 'seasonal' });
    expect(db.dump('producer_memberships').p1_wlrfm!.season).toBeUndefined();
  });

  it('a manager of another market is refused; a manager of this market may update', async () => {
    const app = await boot(withApproved());
    expect((await patch(app, 'p1_wlrfm_2027', { spaces: 2 }, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await patch(app, 'p1_wlrfm_2027', { spaces: 2 }, authFor('mgr_w', 'market_manager'))).statusCode).toBe(200);
    expect((await patch(app, 'nope', { spaces: 2 })).statusCode).toBe(404);
  });
});

describe('POST /api/memberships/:id/items', () => {
  const setup = () =>
    seed({
      users: { admin1: { name: 'Admin', role: 'admin', active: true }, mgr_w: managerOfWlrfm, mgr1: { name: 'Other', role: 'market_manager', assigned_market_ids: ['other'], active: true } },
      producers: { p1: { business_name: 'Testfield Farm', active: true, products: ['tomatoes'] } },
      producer_memberships: {
        p1_wlrfm_2027: {
          producer_id: 'p1',
          market_id: 'wlrfm',
          season: '2027',
          status: 'active',
          approved_items: ['tomatoes'],
          item_requests: [
            { id: 'r1', items: ['Honey', 'tomatoes'], note: 'new hives', requested_at: new Date('2027-05-01'), source: 'producer', status: 'pending', decided_by: null, decided_at: null },
            { id: 'r2', items: ['candles'], note: '', requested_at: new Date('2027-05-02'), source: 'producer', status: 'pending', decided_by: null, decided_at: null },
          ],
        },
      },
    });
  const post = (app: Awaited<ReturnType<typeof boot>>, payload: Record<string, unknown>, headers = adminAuth()) =>
    app.inject({ method: 'POST', url: '/api/memberships/p1_wlrfm_2027/items', headers, payload: payload as never });

  it('approving a request adds its new items to the approved list and to the producer\'s products', async () => {
    const db = setup();
    const app = await boot(db);
    const res = await post(app, { action: 'approve', request_id: 'r1' });
    expect(res.statusCode).toBe(200);
    const m = res.json().membership;
    expect(m.approved_items).toEqual(['tomatoes', 'Honey']);
    expect(m.item_requests.find((r: { id: string }) => r.id === 'r1')).toMatchObject({ status: 'approved', decided_by: 'admin1' });
    expect(m.item_requests.find((r: { id: string }) => r.id === 'r2')).toMatchObject({ status: 'pending' });
    const products = db.dump('producers').p1!.products as Record<string, unknown>[];
    expect(products).toEqual([
      { type: 'produce', items: ['tomatoes'], practices: [], description: '', details: {} }, // the Phase 2 string, converted
      { type: 'other', items: ['Honey', 'tomatoes'], practices: [], description: '', details: {} },
    ]);
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'application.items.approve')).toHaveLength(1);
  });

  it('declining changes nothing but the request; a decided request is final', async () => {
    const db = setup();
    const app = await boot(db);
    const res = await post(app, { action: 'decline', request_id: 'r2' });
    expect(res.json().membership.approved_items).toEqual(['tomatoes']);
    expect(res.json().membership.item_requests.find((r: { id: string }) => r.id === 'r2')).toMatchObject({ status: 'declined', decided_by: 'admin1' });
    expect(db.dump('producers').p1!.products).toEqual(['tomatoes']);
    expect((await post(app, { action: 'approve', request_id: 'r2' })).statusCode).toBe(409);
    expect((await post(app, { action: 'approve', request_id: 'nope' })).statusCode).toBe(404);
  });

  it('an admin can add items directly', async () => {
    const db = setup();
    const app = await boot(db);
    const res = await post(app, { action: 'add', items: ['eggs', 'Tomatoes'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership.approved_items).toEqual(['tomatoes', 'eggs']);
    expect((await post(app, { action: 'add', items: [] })).statusCode).toBe(400);
    expect((await post(app, { action: 'shrug' })).statusCode).toBe(400);
  });

  it('adding items directly is admin only: a market manager gets 403 and nothing changes (fix X9)', async () => {
    const db = setup();
    const app = await boot(db);
    const asManager = authFor('mgr_w', 'market_manager');
    const res = await post(app, { action: 'add', items: ['eggs'] }, asManager);
    expect(res.statusCode).toBe(403);
    expect((db.dump('producer_memberships').p1_wlrfm_2027 as Record<string, unknown>).approved_items).toEqual(['tomatoes']);
    expect(db.dump('producers').p1!.products).toEqual(['tomatoes']);
    expect(Object.values(db.dump('audit_log')).filter((a) => a.action === 'application.items.approve')).toHaveLength(0);
    // A malformed add from a manager is a 400 like anyone else's; the role check does not hide validation.
    expect((await post(app, { action: 'add', items: [] }, asManager)).statusCode).toBe(400);

    // The manager's own job, reviewing what a vendor asked for, still works.
    const approved = await post(app, { action: 'approve', request_id: 'r1' }, asManager);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().membership.approved_items).toEqual(['tomatoes', 'Honey']);
    expect((await post(app, { action: 'decline', request_id: 'r2' }, asManager)).statusCode).toBe(200);
  });

  it('is scoped to the membership\'s market', async () => {
    const app = await boot(setup());
    expect((await post(app, { action: 'approve', request_id: 'r1' }, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await post(app, { action: 'add', items: ['eggs'] }, authFor('mgr1', 'market_manager'))).statusCode).toBe(403);
    expect((await post(app, { action: 'approve', request_id: 'r1' }, authFor('mgr_w', 'market_manager'))).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/memberships/nope/items', headers: adminAuth(), payload: { action: 'add', items: ['x'] } })).statusCode).toBe(404);
  });
});
