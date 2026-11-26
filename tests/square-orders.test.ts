// Square-backed orders (handoff 04, step 4), against mocked Square responses.
// Behaviour mirrored here was verified in the Square sandbox on 2026-11-25.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { orderCreate, orderUpdate, orderQuery } from '../src/tools/orders.js';
import { orderStatus } from '../src/tools/orders-square.js';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { squareRoutes, verifySquareSignature } from '../src/routes/square.js';
import type { Env } from '../src/config/env.js';

const sendSms = vi.fn(async () => 'simulated');
vi.mock('../src/services/sms.js', () => ({ sendSms: (...a: unknown[]) => sendSms(...(a as [])) }));

const env = { NODE_ENV: 'test', SQUARE_ACCESS_TOKEN: 't', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_LOCATION_ID: 'LOC1', SQUARE_CATEGORY_ID: '', INVOICE_NET_DAYS: 15,
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'whsec', SQUARE_WEBHOOK_URL: 'https://example.test/api/square/webhook',
} as Env;

const docs: Record<string, Record<string, Record<string, unknown>>> = {
  farms: {
    f1: { user_id: 'farmer1', name: 'Test Farm', phone: '+15015550101', square_vendor_id: 'V1' },
    f2: { user_id: 'farmer2', name: 'Other Farm', phone: '+15015550102', square_vendor_id: 'V2' },
  },
  markets: { b1: {
    user_id: 'buyer1', name: 'Test Kitchen', phone: '+15015550103', square_customer_id: 'C1',
    physical_address: { street: '1 Test St', city: 'Little Rock', state: 'AR', zip: '72201' },
    tax_exempt: { status: 'exempt_resale', certificate_type: 'ST-391', signed_date: '2026-11-01', verified_at: '2026-11-02T00:00:00Z' },
  } },
  users: { admin1: { role: 'admin' } },
};
// Minimal Firestore fake: fixed farms/markets plus a writable store for the app's own collections.
const store = new Map<string, Record<string, unknown>>();
const docRef = (name: string, id: string) => ({
  _key: `${name}/${id}`,
  get: async () => {
    const d = docs[name]?.[id] ?? store.get(`${name}/${id}`);
    return { id, exists: !!d, data: () => d };
  },
  create: async (data: Record<string, unknown>) => {
    if (store.has(`${name}/${id}`)) throw Object.assign(new Error('exists'), { code: 6 });
    store.set(`${name}/${id}`, data);
  },
  delete: async () => { store.delete(`${name}/${id}`); },
  set: async (data: Record<string, unknown>) => { store.set(`${name}/${id}`, data); },
  update: async (data: Record<string, unknown>) => { updates.push({ key: `${name}/${id}`, data }); },
});
const updates: Array<{ key: string; data: Record<string, unknown> }> = [];
const db = {
  collection: (name: string) => ({
    where: (_f: string, _o: string, uid: string) => ({ limit: () => ({ get: async () => {
      const hit = Object.entries(docs[name] ?? {}).filter(([, d]) => d.user_id === uid).map(([id, d]) => ({ id, data: () => d }));
      return { empty: hit.length === 0, docs: hit };
    } }) }),
    doc: (id: string) => docRef(name, id),
    get: async () => {
      const rows = [...store.entries()].filter(([k]) => k.startsWith(`${name}/`)).map(([k, d]) => ({ id: k.slice(name.length + 1), data: () => d }));
      return { docs: rows };
    },
  }),
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
    get: (ref: ReturnType<typeof docRef>) => ref.get(),
    set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => { store.set(ref._key, { ...(store.get(ref._key) ?? {}), ...data }); },
  }),
} as unknown as FirebaseFirestore.Firestore;

const ctx = (userId: string, messageId?: string) => ({ db, env, userId, phone: 'x', messageId });

const item = { id: 'ITEM1', item_data: { name: 'Test Farm - Tomatoes', variations: [{ id: 'VAR1', item_variation_data: {
  price_money: { amount: 400, currency: 'USD' }, item_variation_vendor_infos: [{ item_variation_vendor_info_data: { vendor_id: 'V1' } }] } }] } };

function squareOrder(over: Record<string, unknown> = {}, fulfillment = 'PROPOSED') {
  return {
    id: 'ORDER1', version: 3, state: 'OPEN', reference_id: 'ORD-TEST', customer_id: 'C1', created_at: '2026-11-25T12:00:00Z',
    metadata: { farm_id: 'f1', buyer_id: 'b1' } as Record<string, string> | undefined, total_money: { amount: 2000 }, net_amount_due_money: { amount: 2000 },
    line_items: [{ uid: 'l1', name: 'Test Farm - Tomatoes', quantity: '5', catalog_object_id: 'VAR1', total_money: { amount: 2000 } }],
    fulfillments: [{ uid: 'ful1', type: 'PICKUP', state: fulfillment, pickup_details: { pickup_at: '2026-11-27T15:00:00Z' } }],
    ...over,
  };
}

describe('square orders', () => {
  let calls: Array<{ method: string; path: string; body: any }>;
  let openOrders: unknown[];
  let stored: ReturnType<typeof squareOrder>;
  let o2State = 'OPEN';
  let invoice: { id: string; version: number; status: string; order_id: string; public_url?: string; payment_requests?: unknown[] } | undefined;

  beforeEach(() => {
    calls = []; openOrders = []; o2State = 'OPEN'; stored = squareOrder(); invoice = undefined; sendSms.mockClear(); store.clear(); updates.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const path = new URL(url).pathname;
      calls.push({ method: init.method, path, body });
      let json: unknown = {};
      if (path === '/v2/catalog/search-catalog-items') json = { items: [item] };
      else if (path === '/v2/inventory/counts/batch-retrieve') json = { counts: [{ catalog_object_id: 'VAR1', state: 'IN_STOCK', quantity: '20' }] };
      else if (path === '/v2/orders/search') json = { orders: openOrders };
      else if (path === '/v2/orders' && init.method === 'POST') json = { order: squareOrder({ reference_id: body.order.reference_id }) };
      else if (path === '/v2/orders/ORDER1' && init.method === 'GET') json = { order: stored };
      else if (path === '/v2/orders/O2' && init.method === 'GET') json = { order: squareOrder({ id: 'O2', state: o2State }) };
      else if (path === '/v2/orders/ORDER1' && init.method === 'PUT') {
        // Behave like Square: apply the change and bump the version.
        const cleared = (body.fields_to_clear ?? []).map((f: string) => f.slice('line_items['.length, -1));
        const lines = stored.line_items
          .filter((li: any) => !cleared.includes(li.uid))
          .map((li: any) => {
            const ch = body.order.line_items?.find((l: any) => l.uid === li.uid);
            return ch ? { ...li, quantity: ch.quantity, total_money: { amount: 400 * Number(ch.quantity) } } : li;
          });
        stored = {
          ...stored, version: stored.version + 1, state: body.order.state ?? stored.state, metadata: body.order.metadata ?? stored.metadata,
          line_items: lines,
          service_charges: [...((stored as any).service_charges ?? []), ...(body.order.service_charges ?? [])],
          fulfillments: [{ ...stored.fulfillments[0], state: body.order.fulfillments?.[0]?.state ?? stored.fulfillments[0].state }],
        } as any;
        json = { order: stored };
      } else if (path === '/v2/invoices' && init.method === 'POST') {
        invoice = { id: 'INV1', version: 0, status: 'DRAFT', order_id: body.invoice.order_id, payment_requests: body.invoice.payment_requests };
        json = { invoice };
      } else if (path === '/v2/invoices/INV1' && init.method === 'GET') json = { invoice };
      else if (path === '/v2/invoices/INV1/publish') {
        invoice = { ...invoice!, version: 1, status: 'UNPAID', public_url: 'https://invoice.test/INV1' };
        json = { invoice };
      } else if (path === '/v2/invoices/INV1/cancel') {
        invoice = { ...invoice!, status: 'CANCELED' };
        stored = { ...stored, state: 'CANCELED', fulfillments: [{ ...stored.fulfillments[0], state: 'CANCELED' }] };
        json = { invoice };
      }
      return { ok: true, status: 200, json: async () => json };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const order = { farm_id: 'f1', market_id: 'b1', items: [{ inventory_id: 'VAR1', quantity: 5 }] };
  const created = () => calls.find((c) => c.path === '/v2/orders' && c.method === 'POST');

  it('maps Square states to FarmLink statuses', () => {
    expect(orderStatus(squareOrder() as any)).toBe('pending');
    expect(orderStatus(squareOrder({}, 'RESERVED') as any)).toBe('confirmed');
    expect(orderStatus(squareOrder({}, 'PREPARED') as any)).toBe('in_transit');
    expect(orderStatus(squareOrder({ state: 'COMPLETED' }) as any)).toBe('delivered');
    expect(orderStatus(squareOrder({ state: 'CANCELED' }) as any)).toBe('cancelled');
  });

  it('creates a pickup order at the depot for the buyer and texts the farm', async () => {
    const res: any = await orderCreate(order, ctx('buyer1', 'm1'));
    expect(res).toMatchObject({ success: true, order_id: 'ORDER1', total: 20, status: 'pending' });
    const o = created()!.body.order;
    expect(o).toMatchObject({ location_id: 'LOC1', customer_id: 'C1', metadata: { farm_id: 'f1', buyer_id: 'b1' } });
    expect(o.line_items).toEqual([{ catalog_object_id: 'VAR1', quantity: '5' }]);
    expect(o.fulfillments[0]).toMatchObject({ type: 'PICKUP', state: 'PROPOSED' });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect((sendSms.mock.calls[0] as any)[0].to).toBe('+15015550101');
  });

  it('refuses a wholesale order until the buyer has a verified tax certificate', async () => {
    const saved = docs.markets.b1.tax_exempt;
    try {
      docs.markets.b1.tax_exempt = undefined as any;
      expect(await orderCreate(order, ctx('buyer1'))).toMatchObject({ error: 'tax_certificate_missing' });
      docs.markets.b1.tax_exempt = { ...(saved as object), verified_at: null };
      expect(await orderCreate(order, ctx('buyer1'))).toMatchObject({ error: 'tax_certificate_not_verified' });
      expect(created()).toBeUndefined();
    } finally {
      docs.markets.b1.tax_exempt = saved;
    }
  });

  it('sends an exempt order with no tax, adds buyer fees, saves the terms and the order date', async () => {
    store.set('fee_rules/svc', { code: 'service', name: 'Service fee', percent: 7, flat_cents: null, payer: 'buyer', applies_to: 'all', per: 'order', effective_from: '2026-01-01', active: true });
    store.set('fee_rules/com', { code: 'commission', name: 'Commission', percent: 4, flat_cents: null, payer: 'farmer', applies_to: 'all', per: 'order', effective_from: '2026-01-01', active: true });
    store.set('fee_rules/tbd', { code: 'tbd', name: '[Fee]', percent: null, flat_cents: null, payer: 'buyer', applies_to: 'all', per: 'order', effective_from: '2026-01-01', active: true });
    const e = { ...env, SQUARE_EXEMPT_BLOCK_TAX_IDS: 'TAX_A, TAX_B', SQUARE_FEE_TAX_IDS: '' } as Env;
    const res: any = await orderCreate(order, { db, env: e, userId: 'buyer1', phone: 'x', messageId: 'm2' });
    expect(res).toMatchObject({ success: true, fulfillment: 'pickup' });
    const o = created()!.body.order;
    expect(o.pricing_options).toEqual({ auto_apply_taxes: false, auto_apply_discounts: false });
    expect(o.taxes).toBeUndefined();
    expect(o.line_items[0].pricing_blocklists.blocked_taxes).toEqual([
      { uid: 'block-0', tax_catalog_object_id: 'TAX_A' }, { uid: 'block-1', tax_catalog_object_id: 'TAX_B' },
    ]);
    // Only the buyer-paid fee goes on the Square order; the placeholder is skipped.
    expect(o.service_charges).toEqual([{ calculation_phase: 'SUBTOTAL_PHASE', taxable: false, uid: 'fee-service-pct', name: 'Service fee', percentage: '7' }]);
    const terms = store.get('wholesale_orders/ORDER1') as any;
    expect(terms).toMatchObject({ farm_id: 'f1', buyer_id: 'b1', fulfillment: 'pickup', tax: { status: 'exempt_resale', certificate_type: 'ST-391' } });
    expect(terms.fees.map((f: any) => f.code)).toEqual(['commission', 'service']);
    expect(terms.fees_skipped).toEqual([{ id: 'tbd', reason: 'amount not set yet' }]);
    expect(updates).toEqual([{ key: 'markets/b1', data: { 'tax_exempt.last_order_at': expect.any(Date) } }]);
  });

  it('creates a delivery order to the buyer address', async () => {
    const res: any = await orderCreate({ ...order, fulfillment: 'delivery' }, ctx('buyer1'));
    expect(res).toMatchObject({ success: true, fulfillment: 'delivery', delivery_address: '1 Test St, Little Rock' });
    const f = created()!.body.order.fulfillments[0];
    expect(f).toMatchObject({ type: 'DELIVERY', state: 'PROPOSED', delivery_details: { schedule_type: 'SCHEDULED', recipient: { customer_id: 'C1', address: { address_line_1: '1 Test St', postal_code: '72201' } } } });
    expect(store.get('wholesale_orders/ORDER1')).toMatchObject({ fulfillment: 'delivery', delivery_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  describe('delivery fee once per buyer per delivery day', () => {
    const dayFee = { id: 'del', code: 'delivery', name: 'Delivery', percent: null, flat_cents: 1000, payer: 'buyer', applies_to: 'delivery', per: 'buyer_delivery_day' };
    beforeEach(() => {
      stored = squareOrder({ fulfillments: [{ uid: 'ful1', type: 'DELIVERY', state: 'RESERVED', delivery_details: { deliver_at: '2026-11-27T15:00:00Z' } }] }) as any;
      store.set('wholesale_orders/ORDER1', { buyer_id: 'b1', fulfillment: 'delivery', delivery_day: '2026-11-27', fees: [dayFee] });
    });
    const feePuts = () => calls.filter((c) => c.method === 'PUT' && c.body.order.service_charges);

    it('goes on the first order checked in that day, before its invoice', async () => {
      await orderUpdate({ order_id: 'ORDER1', status: 'in_transit' }, ctx('farmer1'));
      expect(feePuts()).toHaveLength(1);
      expect(feePuts()[0].body.order.service_charges).toEqual([{ calculation_phase: 'SUBTOTAL_PHASE', taxable: false, uid: 'fee-delivery-flat', name: 'Delivery', amount_money: { amount: 1000, currency: 'USD' } }]);
      expect(store.get('delivery_day_fees/C1_2026-11-27')).toMatchObject({ order_id: 'ORDER1' });
      expect(calls.findIndex((c) => c === feePuts()[0])).toBeLessThan(calls.findIndex((c) => c.path === '/v2/invoices'));
    });

    it('is skipped when another live order that day already carries it', async () => {
      store.set('delivery_day_fees/C1_2026-11-27', { order_id: 'O2' });
      await orderUpdate({ order_id: 'ORDER1', status: 'in_transit' }, ctx('farmer1'));
      expect(feePuts()).toHaveLength(0);
      expect(calls.some((c) => c.path === '/v2/invoices')).toBe(true);
    });

    it('moves to this order when the one carrying it was cancelled', async () => {
      store.set('delivery_day_fees/C1_2026-11-27', { order_id: 'O2' });
      o2State = 'CANCELED';
      await orderUpdate({ order_id: 'ORDER1', status: 'in_transit' }, ctx('farmer1'));
      expect(feePuts()).toHaveLength(1);
      expect(store.get('delivery_day_fees/C1_2026-11-27')).toMatchObject({ order_id: 'ORDER1' });
    });
  });

  it('counts stock already promised on open orders', async () => {
    openOrders = [squareOrder({ line_items: [{ uid: 'x', quantity: '17', catalog_object_id: 'VAR1' }] })];
    const res: any = await orderCreate(order, ctx('buyer1'));
    expect(res).toMatchObject({ error: 'insufficient_stock', available: 3 });
    expect(created()).toBeUndefined();
  });

  it('refuses an order placed for someone else, and items from another farm', async () => {
    expect(await orderCreate(order, ctx('farmer2'))).toMatchObject({ error: 'not_allowed' });
    expect(await orderCreate({ ...order, farm_id: 'f2' }, ctx('buyer1'))).toMatchObject({ error: 'item_not_found' });
    expect(created()).toBeUndefined();
  });

  it('lets only the farm move an order forward, and tells the buyer', async () => {
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'confirmed' }, ctx('buyer1'))).toMatchObject({ error: 'not_allowed' });
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'confirmed' }, ctx('farmer2'))).toMatchObject({ error: 'not_allowed' });
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'confirmed' }, ctx('farmer1'));
    expect(res.order.status).toBe('confirmed');
    const put = calls.find((c) => c.method === 'PUT')!.body.order;
    expect(put).toMatchObject({ version: 3, fulfillments: [{ uid: 'ful1', state: 'RESERVED' }] });
    expect(put.state).toBeUndefined();

    // Confirmation no longer invoices: the bill waits for check-in.
    expect(calls.some((c) => c.path === '/v2/invoices')).toBe(false);
    expect(res.order.payment).toBe('not_invoiced');
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect((sendSms.mock.calls[0] as any)[0].to).toBe('+15015550103');
  });

  it('invoices at check-in, after fixing short items, net 15 days from pickup', async () => {
    stored = squareOrder({}, 'RESERVED');
    store.set('order_notifications/ORDER1', { status: 'confirmed', paid: false });
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'in_transit', received_items: [{ inventory_id: 'VAR1', quantity: 3 }] }, ctx('farmer1'));
    expect(res.success).toBe(true);
    // The short line was fixed before the invoice existed.
    const firstPut = calls.find((c) => c.method === 'PUT')!.body.order;
    expect(firstPut.line_items).toEqual([{ uid: 'l1', quantity: '3' }]);
    const putIdx = calls.findIndex((c) => c.method === 'PUT');
    const invIdx = calls.findIndex((c) => c.path === '/v2/invoices');
    expect(putIdx).toBeLessThan(invIdx);
    const inv = calls[invIdx].body.invoice;
    expect(inv).toMatchObject({ order_id: 'ORDER1', delivery_method: 'SHARE_MANUALLY', primary_recipient: { customer_id: 'C1' } });
    expect(inv.payment_requests[0]).toMatchObject({ request_type: 'BALANCE', due_date: '2026-12-12' });
    expect(res.order).toMatchObject({ status: 'in_transit', payment: 'invoiced' });
    expect(stored.metadata).toMatchObject({ invoice_id: 'INV1' });
    const sms = (sendSms.mock.calls[0] as any)[0];
    expect(sms.to).toBe('+15015550103');
    expect(sms.body).toContain('https://invoice.test/INV1');

    // Moving on does not invoice twice.
    await orderUpdate({ order_id: 'ORDER1', status: 'delivered' }, ctx('farmer1'));
    expect(calls.filter((c) => c.path === '/v2/invoices')).toHaveLength(1);
  });

  it('refuses check-in quantities above what was ordered, or once invoiced', async () => {
    stored = squareOrder({}, 'RESERVED');
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'in_transit', received_items: [{ inventory_id: 'VAR1', quantity: 6 }] }, ctx('farmer1')))
      .toMatchObject({ error: 'invalid_quantity' });
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'in_transit', received_items: [{ inventory_id: 'VAR1', quantity: 0 }] }, ctx('farmer1')))
      .toMatchObject({ error: 'nothing_received' });
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'confirmed', received_items: [{ inventory_id: 'VAR1', quantity: 2 }] }, ctx('farmer1')))
      .toMatchObject({ error: 'invalid_input' });
    stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1' } }, 'RESERVED');
    invoice = { id: 'INV1', version: 1, status: 'UNPAID', order_id: 'ORDER1' };
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'in_transit', received_items: [{ inventory_id: 'VAR1', quantity: 2 }] }, ctx('farmer1')))
      .toMatchObject({ error: 'already_invoiced' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('lets SJCA staff check an order in', async () => {
    stored = squareOrder({}, 'RESERVED');
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'in_transit' }, ctx('admin1'));
    expect(res).toMatchObject({ success: true, order: { status: 'in_transit', payment: 'invoiced' } });
  });

  it('cancels the order and its pickup together; a buyer may cancel only while pending', async () => {
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'cancelled' }, ctx('buyer1'));
    expect(res.order.status).toBe('cancelled');
    expect(calls.find((c) => c.method === 'PUT')!.body.order).toMatchObject({ state: 'CANCELED', fulfillments: [{ state: 'CANCELED' }] });
    stored = squareOrder({}, 'RESERVED');
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'cancelled' }, ctx('buyer1'))).toMatchObject({ error: 'not_allowed' });
  });

  it('records pickup on an unpaid order without completing it in Square', async () => {
    stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1' } }, 'PREPARED');
    invoice = { id: 'INV1', version: 1, status: 'UNPAID', order_id: 'ORDER1' };
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'delivered' }, ctx('farmer1'));
    expect(res.order).toMatchObject({ status: 'delivered', payment: 'invoiced' });
    expect(stored.metadata!.picked_up_at).toBeTruthy();
    expect(stored.fulfillments[0].state).toBe('PREPARED');
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'cancelled' }, ctx('farmer1'))).toMatchObject({ error: 'order_closed' });
  });

  it('completes the Square pickup once a picked-up order is paid', async () => {
    stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1', picked_up_at: '2026-11-27T16:00:00Z' }, net_amount_due_money: { amount: 0 } }, 'PREPARED');
    openOrders = [stored];
    const res: any = await orderQuery({}, ctx('farmer1'));
    expect(res.orders[0]).toMatchObject({ status: 'delivered', payment: 'paid' });
    expect(calls.find((c) => c.method === 'PUT')!.body.order.fulfillments[0].state).toBe('COMPLETED');
  });

  it('cancels an invoiced order through its invoice, and refuses once paid', async () => {
    stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1' } }, 'RESERVED');
    invoice = { id: 'INV1', version: 1, status: 'UNPAID', order_id: 'ORDER1' };
    const res: any = await orderUpdate({ order_id: 'ORDER1', status: 'cancelled' }, ctx('farmer1'));
    expect(res.order.status).toBe('cancelled');
    expect(calls.some((c) => c.path === '/v2/invoices/INV1/cancel')).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1' }, net_amount_due_money: { amount: 0 } }, 'RESERVED');
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'cancelled' }, ctx('farmer1'))).toMatchObject({ error: 'paid_needs_refund' });
  });

  it('does not count paid orders against available stock', async () => {
    openOrders = [squareOrder({ net_amount_due_money: { amount: 0 }, line_items: [{ uid: 'x', quantity: '17', catalog_object_id: 'VAR1' }] })];
    expect(await orderCreate(order, ctx('buyer1'))).toMatchObject({ success: true });
  });

  it('leaves orders that were not placed through FarmLink alone', async () => {
    stored = squareOrder({ metadata: undefined });
    expect(await orderUpdate({ order_id: 'ORDER1', status: 'confirmed' }, ctx('farmer1'))).toMatchObject({ error: 'not_a_farmlink_order' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows a user only their own FarmLink orders', async () => {
    openOrders = [squareOrder(), squareOrder({ id: 'POS1', metadata: undefined }), squareOrder({ id: 'O2', metadata: { farm_id: 'f2', buyer_id: 'b1' } })];
    const farm: any = await orderQuery({ farm_id: 'f2' }, ctx('farmer1'));
    expect(farm.orders.map((o: any) => o.id)).toEqual(['ORDER1']);
    const buyer: any = await orderQuery({}, ctx('buyer1'));
    expect(buyer.orders.map((o: any) => o.id)).toEqual(['ORDER1', 'O2']);
    expect(calls.filter((c) => c.path === '/v2/orders/search').at(-1)!.body.query.filter.customer_filter).toEqual({ customer_ids: ['C1'] });
  });
  describe('webhook', () => {
    const URL_ = 'https://example.test/api/square/webhook';
    const sign = (body: string, key = 'whsec') => crypto.createHmac('sha256', key).update(URL_ + body).digest('base64');
    async function app(e: Env = env) {
      const f = Fastify();
      f.decorate('db', db);
      f.decorate('env', e);
      await f.register(squareRoutes, { prefix: '/api/square' });
      return f;
    }
    const event = (id: string, object: Record<string, unknown>) => JSON.stringify({ event_id: id, type: 'invoice.payment_made', data: { object } });
    const post = async (f: Awaited<ReturnType<typeof app>>, body: string, signature?: string) =>
      f.inject({ method: 'POST', url: '/api/square/webhook', payload: body, headers: { 'content-type': 'application/json', ...(signature ? { 'x-square-hmacsha256-signature': signature } : {}) } });
    const texts = () => sendSms.mock.calls.map((c) => (c as any)[0]);

    it('rejects unsigned, wrongly signed and unconfigured calls without touching Square', async () => {
      const body = event('e1', { invoice: { order_id: 'ORDER1' } });
      expect(verifySquareSignature('whsec', URL_, body, sign(body))).toBe(true);
      const f = await app();
      expect((await post(f, body)).statusCode).toBe(403);
      expect((await post(f, body, sign(body, 'other-key'))).statusCode).toBe(403);
      expect((await post(f, body + ' ', sign(body))).statusCode).toBe(403);
      const unconfigured = await app({ ...env, SQUARE_WEBHOOK_SIGNATURE_KEY: '' } as Env);
      expect((await post(unconfigured, body, crypto.createHmac('sha256', '').update(URL_ + body).digest('base64'))).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('on a paid invoice, completes a picked-up order and texts both sides once', async () => {
      stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1', picked_up_at: '2026-11-27T16:00:00Z' }, net_amount_due_money: { amount: 0 } }, 'PREPARED');
      invoice = { id: 'INV1', version: 2, status: 'PAID', order_id: 'ORDER1' };
      store.set('order_notifications/ORDER1', { status: 'delivered', paid: false, invoice_sent: true });
      const f = await app();
      const body = event('e2', { invoice: { order_id: 'ORDER1' } });
      const res = await post(f, body, sign(body));
      expect(res.json()).toMatchObject({ ok: true, sent: 2 });
      expect(stored.fulfillments[0].state).toBe('COMPLETED');
      expect(texts().map((t) => t.to).sort()).toEqual(['+15015550101', '+15015550103']);
      expect(texts().every((t) => /paid|Payment received/.test(t.body))).toBe(true);

      // Square redelivers the same event: nothing more is sent.
      expect((await post(f, body, sign(body))).json()).toMatchObject({ duplicate: true });
      // A different event about the same, unchanged order: also silent.
      const again = event('e3', { order_updated: { order_id: 'ORDER1' } });
      expect((await post(f, again, sign(again))).json()).toMatchObject({ sent: 0 });
      expect(sendSms).toHaveBeenCalledTimes(2);
    });

    it('does not repeat a text FarmLink already sent for its own change', async () => {
      await orderUpdate({ order_id: 'ORDER1', status: 'confirmed' }, ctx('farmer1'));
      expect(sendSms).toHaveBeenCalledTimes(1);
      const f = await app();
      const body = event('e4', { order_fulfillment_updated: { order_id: 'ORDER1' } });
      expect((await post(f, body, sign(body))).json()).toMatchObject({ sent: 0 });
      expect(sendSms).toHaveBeenCalledTimes(1);
    });

    it('texts the buyer when staff move the pickup along in Square', async () => {
      stored = squareOrder({ metadata: { farm_id: 'f1', buyer_id: 'b1', invoice_id: 'INV1' } }, 'PREPARED');
      store.set('order_notifications/ORDER1', { status: 'confirmed', paid: false, invoice_sent: true });
      const f = await app();
      const body = event('e5', { order_fulfillment_updated: { order_id: 'ORDER1' } });
      expect((await post(f, body, sign(body))).json()).toMatchObject({ sent: 1 });
      expect(texts()[0]).toMatchObject({ to: '+15015550103' });
      expect(texts()[0].body).toContain('ready for pickup');
    });

    it('ignores register sales and other orders that are not FarmLink orders', async () => {
      stored = squareOrder({ metadata: undefined });
      const f = await app();
      const body = event('e6', { order_updated: { order_id: 'ORDER1' } });
      expect((await post(f, body, sign(body))).json()).toMatchObject({ ignored: true });
      expect(sendSms).not.toHaveBeenCalled();
    });
  });
});
