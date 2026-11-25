// Square-backed inventory (handoff 04, step 3), against mocked Square responses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { squareBaseUrl, idempotencyKey } from '../src/services/square.js';
import { inventoryAdd, inventoryQuery } from '../src/tools/inventory.js';
import type { Env } from '../src/config/env.js';

const env = {
  NODE_ENV: 'test', SQUARE_ACCESS_TOKEN: 'sandbox-token', SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_LOCATION_ID: 'LOC1', SQUARE_CATEGORY_ID: 'CAT1',
} as Env;

// Minimal Firestore fake: farms (one linked farm) + harvest_lots.
function fakeDb(farm: Record<string, unknown> = { user_id: 'u1', name: 'Test Farm', square_vendor_id: 'V1' }) {
  const lots = new Map<string, Record<string, unknown>>();
  const farmDoc = { id: 'f1', exists: true, data: () => farm };
  const db = {
    lots,
    collection(name: string) {
      if (name === 'farms') {
        return {
          where: () => ({ limit: () => ({ get: async () => ({ empty: false, docs: [farmDoc] }) }) }),
          doc: () => ({ get: async () => farmDoc }),
          get: async () => ({ docs: [farmDoc] }),
        };
      }
      return {
        doc: (id: string) => ({
          create: async (data: Record<string, unknown>) => {
            if (lots.has(id)) throw Object.assign(new Error('exists'), { code: 6 });
            lots.set(id, data);
          },
        }),
        where: () => ({ get: async () => ({ docs: [...lots.values()].map((d) => ({ data: () => d })) }) }),
      };
    },
  };
  return db as unknown as FirebaseFirestore.Firestore & { lots: typeof lots };
}

const existingItem = (price = 400) => ({
  type: 'ITEM', id: 'ITEM1',
  item_data: {
    name: 'Test Farm - Tomatoes',
    variations: [{
      id: 'VAR1', version: 7,
      item_variation_data: {
        price_money: { amount: price, currency: 'USD' }, measurement_unit_id: 'UNIT_LB',
        item_variation_vendor_infos: [{ item_variation_vendor_info_data: { vendor_id: 'V1' } }],
      },
    }],
  },
});
const lbUnit = { id: 'UNIT_LB', measurement_unit_data: { measurement_unit: { weight_unit: 'IMPERIAL_POUND' } } };

describe('square inventory', () => {
  let calls: Array<{ url: string; body: any }>;
  let catalogItems: unknown[];

  beforeEach(() => {
    calls = [];
    catalogItems = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string; headers: Record<string, string> }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const path = new URL(url).pathname;
      let json: unknown = {};
      if (path === '/v2/catalog/search-catalog-items') json = { items: catalogItems };
      else if (path === '/v2/catalog/search') json = { objects: [lbUnit] };
      else if (path === '/v2/catalog/object' && body.object.type === 'ITEM') {
        const v = body.object.item_data.variations[0];
        json = { catalog_object: { ...body.object, id: 'ITEM_NEW', item_data: { ...body.object.item_data, variations: [{ ...v, id: 'VAR_NEW' }] } } };
      } else if (path === '/v2/catalog/object/VAR1') json = { object: existingItem().item_data.variations[0] };
      else if (path === '/v2/inventory/changes/batch-create') {
        const a = body.changes[0].adjustment;
        json = { counts: [{ catalog_object_id: a.catalog_object_id, location_id: 'LOC1', state: 'IN_STOCK', quantity: a.quantity }] };
      } else if (path === '/v2/inventory/counts/batch-retrieve') {
        json = { counts: [{ catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'IN_STOCK', quantity: '12.5' }] };
      }
      return { ok: true, status: 200, json: async () => json };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const paths = () => calls.map((c) => new URL(c.url).pathname);

  it('never reaches the live Square host outside a production deploy', () => {
    expect(squareBaseUrl({ SQUARE_ENVIRONMENT: 'sandbox', NODE_ENV: 'production' })).toContain('squareupsandbox');
    expect(squareBaseUrl({ SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'production' })).toBe('https://connect.squareup.com');
    expect(() => squareBaseUrl({ SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'development' })).toThrow();
    expect(() => squareBaseUrl({ SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'test' })).toThrow();
  });

  it('creates a new item linked to the farm vendor, then receives stock at the depot', async () => {
    const db = fakeDb();
    const res: any = await inventoryAdd({ product: 'Tomatoes', quantity: 20, unit: 'lb', price: 4 }, { db, env, userId: 'u1', phone: 'x', messageId: 'm1' });
    expect(res.success).toBe(true);
    expect(res.in_stock_now).toBe(20);

    const create = calls.find((c) => c.body?.object?.type === 'ITEM')!.body.object;
    expect(create.item_data.name).toBe('Test Farm - Tomatoes');
    expect(create).toMatchObject({ present_at_all_locations: false, present_at_location_ids: ['LOC1'] });
    expect(create.item_data.variations[0]).toMatchObject({ present_at_all_locations: false, present_at_location_ids: ['LOC1'] });
    const v = create.item_data.variations[0].item_variation_data;
    expect(v.price_money).toEqual({ amount: 400, currency: 'USD' });
    expect(v.measurement_unit_id).toBe('UNIT_LB');
    expect(v.track_inventory).toBe(true);
    // The vendor link is its own object: Square drops one nested in the item create.
    expect(v.item_variation_vendor_infos).toBeUndefined();
    const link = calls.find((c) => c.body?.object?.type === 'ITEM_VARIATION_VENDOR_INFO')!.body.object;
    expect(link.item_variation_vendor_info_data).toMatchObject({ item_variation_id: 'VAR_NEW', vendor_id: 'V1' });

    const adj = calls.find((c) => c.url.endsWith('/v2/inventory/changes/batch-create'))!.body.changes[0].adjustment;
    expect(adj).toMatchObject({ from_state: 'NONE', to_state: 'IN_STOCK', from_location_id: 'LOC1', to_location_id: 'LOC1', catalog_object_id: 'VAR_NEW', quantity: '20' });
    expect(db.lots.size).toBe(1);
    expect(calls.every((c) => c.url.startsWith('https://connect.squareupsandbox.com'))).toBe(true);
  });

  it('reuses an existing item and its price without creating anything', async () => {
    catalogItems = [existingItem()];
    const res: any = await inventoryAdd({ product: 'tomatoes', quantity: 5, unit: 'lb' }, { db: fakeDb(), env, userId: 'u1', phone: 'x' });
    expect(res).toMatchObject({ success: true, price: 4, square_variation_id: 'VAR1' });
    expect(paths()).not.toContain('/v2/catalog/object');
  });

  it('updates the price when the farmer gives a new one', async () => {
    catalogItems = [existingItem()];
    await inventoryAdd({ product: 'Tomatoes', quantity: 5, unit: 'lb', price: 4.5 }, { db: fakeDb(), env, userId: 'u1', phone: 'x' });
    const upsert = calls.find((c) => c.url.endsWith('/v2/catalog/object'))!.body.object;
    expect(upsert.id).toBe('VAR1');
    expect(upsert.version).toBe(7);
    expect(upsert.item_variation_data.price_money.amount).toBe(450);
  });

  it('asks for a price before creating a new item, and writes nothing', async () => {
    const res: any = await inventoryAdd({ product: 'Okra', quantity: 5, unit: 'lb' }, { db: fakeDb(), env, userId: 'u1', phone: 'x' });
    expect(res.needs_price).toBe(true);
    expect(paths()).toEqual(['/v2/catalog/search-catalog-items']);
  });

  it('refuses a farm that is not linked to a Square vendor, without calling Square', async () => {
    const res: any = await inventoryAdd({ product: 'Okra', quantity: 5, unit: 'lb', price: 3 }, { db: fakeDb({ user_id: 'u1', name: 'Test Farm' }), env, userId: 'u1', phone: 'x' });
    expect(res.error).toBe('farm_not_linked');
    expect(calls).toHaveLength(0);
  });

  it('sends identical idempotency keys when the same inbound message is retried', async () => {
    const db = fakeDb();
    const ctx = { db, env, userId: 'u1', phone: 'x', messageId: 'm1' };
    await inventoryAdd({ product: 'Tomatoes', quantity: 20, unit: 'lb', price: 4 }, ctx);
    const first = calls.filter((c) => c.body?.idempotency_key).map((c) => c.body.idempotency_key);
    calls = [];
    await inventoryAdd({ product: 'Tomatoes', quantity: 20, unit: 'lb', price: 4 }, ctx);
    expect(calls.filter((c) => c.body?.idempotency_key).map((c) => c.body.idempotency_key)).toEqual(first);
    expect(db.lots.size).toBe(1);
    expect(idempotencyKey('a', 'b')).toHaveLength(40);
  });

  it('treats a reused idempotency key on stock receipt as already done and adds nothing', async () => {
    catalogItems = [existingItem()];
    const real = globalThis.fetch as any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/v2/inventory/changes/batch-create')) {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: false, status: 400, json: async () => ({ errors: [{ code: 'IDEMPOTENCY_KEY_REUSED' }] }) };
      }
      return real(url, init);
    }));
    const res: any = await inventoryAdd({ product: 'Tomatoes', quantity: 5, unit: 'lb' }, { db: fakeDb(), env, userId: 'u1', phone: 'x', messageId: 'm9' });
    expect(res).toMatchObject({ success: true, in_stock_now: 12.5 });
  });

  it('ignores same-named items that belong to another vendor', async () => {
    const other = existingItem();
    other.item_data.variations[0].item_variation_data.item_variation_vendor_infos = [{ item_variation_vendor_info_data: { vendor_id: 'OTHER' } }];
    catalogItems = [other];
    const res: any = await inventoryQuery({}, { db: fakeDb(), env, userId: 'u1', phone: 'x' });
    expect(res.count).toBe(0);
  });

  it('reports depot stock with unit, price and harvest date', async () => {
    catalogItems = [existingItem()];
    const db = fakeDb();
    db.lots.set('l1', { farm_id: 'f1', square_variation_id: 'VAR1', harvest_date: new Date('2026-11-20T12:00:00Z') });
    const res: any = await inventoryQuery({}, { db, env, userId: 'u1', phone: 'x' });
    expect(res.inventory).toEqual([{
      id: 'VAR1', product_name: 'Tomatoes', farm_name: 'Test Farm', remaining: 12.5, unit: 'lb', price: 4, status: 'available', harvest_date: '2026-11-20',
    }]);
    const counts = calls.find((c) => c.url.endsWith('/v2/inventory/counts/batch-retrieve'))!.body;
    expect(counts.location_ids).toEqual(['LOC1']);
  });
});
