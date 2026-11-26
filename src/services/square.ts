import crypto from 'node:crypto';
import type { Env } from '../config/env.js';

/**
 * Thin Square REST client (handoff 04). Square is the source of truth for the
 * catalog, stock counts and vendors; the app DB stores Square ids only.
 *
 * Model (option A, SJCA is the seller), matching how the seller's catalog is
 * already laid out: one ITEM per farm product named "<Farm> - <Product>", a
 * single variation carrying price + measurement unit + track_inventory, and
 * the farm linked as the variation's Vendor.
 */

export const SQUARE_VERSION = '2026-11-18';

type SquareEnv = Pick<Env, 'SQUARE_ACCESS_TOKEN' | 'SQUARE_ENVIRONMENT' | 'SQUARE_LOCATION_ID' | 'SQUARE_CATEGORY_ID' | 'NODE_ENV'>;

export class SquareError extends Error {
  constructor(message: string, public status: number, public errors: unknown) {
    super(message);
  }
}

/**
 * True when Square rejected a write because its idempotency key was already
 * used with a different body. For our keys (derived from the inbound message)
 * that means the write already happened on an earlier attempt: bodies differ
 * only by timestamp or object version (sandbox-verified 2026-11-25).
 */
export function alreadyApplied(err: unknown): boolean {
  return err instanceof SquareError && Array.isArray(err.errors) && err.errors.some((e) => e?.code === 'IDEMPOTENCY_KEY_REUSED');
}

export function squareEnabled(env: Pick<Env, 'SQUARE_ACCESS_TOKEN'>): boolean {
  return !!env.SQUARE_ACCESS_TOKEN;
}

/** The live seller account is reachable only from a production deploy. */
export function squareBaseUrl(env: Pick<Env, 'SQUARE_ENVIRONMENT' | 'NODE_ENV'>): string {
  if (env.SQUARE_ENVIRONMENT !== 'production') return 'https://connect.squareupsandbox.com';
  if (env.NODE_ENV !== 'production') {
    throw new Error('SQUARE_ENVIRONMENT=production is only allowed when NODE_ENV=production. Use a sandbox token for development.');
  }
  return 'https://connect.squareup.com';
}

/** Stable idempotency key (Square allows up to 128 chars; some endpoints 45). */
export function idempotencyKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

export async function squareRequest<T>(env: SquareEnv, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  if (!squareEnabled(env)) throw new Error('Square is not configured (SQUARE_ACCESS_TOKEN is blank)');
  const res = await fetch(`${squareBaseUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { errors?: Array<{ code?: string; detail?: string }> };
  if (!res.ok || json.errors?.length) {
    const first = json.errors?.[0];
    throw new SquareError(`Square ${method} ${path} failed: ${first?.code ?? res.status} ${first?.detail ?? ''}`.trim(), res.status, json.errors);
  }
  return json as T;
}

// ---- Catalog shapes (only the fields we use) ----

export interface SquareVariation {
  id: string;
  version?: number;
  item_variation_data: {
    item_id?: string;
    name?: string;
    price_money?: { amount: number; currency: string };
    measurement_unit_id?: string;
    track_inventory?: boolean;
    item_variation_vendor_infos?: Array<{ item_variation_vendor_info_data?: { vendor_id?: string } }>;
  };
}
export interface SquareItem {
  id: string;
  version?: number;
  item_data: { name: string; categories?: Array<{ id: string }>; variations?: SquareVariation[]; is_archived?: boolean };
}

export interface FarmItem {
  item_id: string;
  variation_id: string;
  variation_version?: number;
  product_name: string;
  price: number | null;
  measurement_unit_id: string | null;
  category_ids: string[];
}

export function itemName(farmName: string, productName: string): string {
  return `${farmName} - ${productName}`;
}

const toCents = (dollars: number) => Math.round(dollars * 100);

function toFarmItem(item: SquareItem, farmName: string, vendorId: string): FarmItem | null {
  const prefix = `${farmName} - `.toLowerCase();
  if (item.item_data.is_archived) return null;
  if (!item.item_data.name.toLowerCase().startsWith(prefix)) return null;
  const variation = item.item_data.variations?.find((v) =>
    v.item_variation_data.item_variation_vendor_infos?.some((i) => i.item_variation_vendor_info_data?.vendor_id === vendorId),
  );
  if (!variation) return null;
  const money = variation.item_variation_data.price_money;
  return {
    item_id: item.id,
    variation_id: variation.id,
    variation_version: variation.version,
    product_name: item.item_data.name.slice(prefix.length),
    price: money ? money.amount / 100 : null,
    measurement_unit_id: variation.item_variation_data.measurement_unit_id ?? null,
    category_ids: (item.item_data.categories ?? []).map((c) => c.id),
  };
}

/**
 * A farm's items: name starts "<Farm> - " AND the variation's vendor is the
 * farm. SearchCatalogItems has no vendor filter, so the vendor check is ours.
 */
export async function listFarmItems(env: SquareEnv, farm: { name: string; vendorId: string }, search?: string): Promise<FarmItem[]> {
  const out: FarmItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await squareRequest<{ items?: SquareItem[]; cursor?: string }>(env, 'POST', '/v2/catalog/search-catalog-items', {
      text_filter: search ? `${farm.name} ${search}` : farm.name,
      archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items ?? []) {
      const fi = toFarmItem(item, farm.name, farm.vendorId);
      if (fi) out.push(fi);
    }
    cursor = page.cursor || undefined;
  } while (cursor);
  return out;
}

export async function findFarmItem(env: SquareEnv, farm: { name: string; vendorId: string }, productName: string): Promise<FarmItem | null> {
  const items = await listFarmItems(env, farm, productName);
  return items.find((i) => i.product_name.toLowerCase() === productName.toLowerCase()) ?? null;
}

// ---- Measurement units ----

interface SquareUnit {
  id: string;
  measurement_unit_data: { measurement_unit: { custom_unit?: { name: string; abbreviation: string }; weight_unit?: string; generic_unit?: string } };
}

const WEIGHT_UNITS: Record<string, string> = {
  lb: 'IMPERIAL_POUND', lbs: 'IMPERIAL_POUND', pound: 'IMPERIAL_POUND', pounds: 'IMPERIAL_POUND',
  oz: 'IMPERIAL_WEIGHT_OUNCE', ounce: 'IMPERIAL_WEIGHT_OUNCE', ounces: 'IMPERIAL_WEIGHT_OUNCE',
};

export function unitLabel(u: SquareUnit): string {
  const m = u.measurement_unit_data.measurement_unit;
  if (m.custom_unit) return m.custom_unit.name;
  if (m.weight_unit === 'IMPERIAL_POUND') return 'lb';
  if (m.weight_unit === 'IMPERIAL_WEIGHT_OUNCE') return 'oz';
  return (m.weight_unit ?? m.generic_unit ?? 'unit').toLowerCase();
}

export async function listUnits(env: SquareEnv): Promise<SquareUnit[]> {
  const out: SquareUnit[] = [];
  let cursor: string | undefined;
  do {
    const page = await squareRequest<{ objects?: SquareUnit[]; cursor?: string }>(env, 'POST', '/v2/catalog/search', {
      object_types: ['MEASUREMENT_UNIT'],
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(page.objects ?? []));
    cursor = page.cursor || undefined;
  } while (cursor);
  return out;
}

/** Find the seller's measurement unit for "lb", "bunch", "dozen"…; create a custom unit if none exists. */
export async function resolveUnitId(env: SquareEnv, unit: string): Promise<string> {
  const wanted = unit.trim().toLowerCase();
  const weight = WEIGHT_UNITS[wanted];
  const singular = wanted.replace(/(ch|sh|x|s)es$/, '$1').replace(/s$/, '');
  const units = await listUnits(env);
  const hit = units.find((u) => {
    const m = u.measurement_unit_data.measurement_unit;
    if (weight) return m.weight_unit === weight;
    const names = [m.custom_unit?.name, m.custom_unit?.abbreviation].filter(Boolean).map((n) => n!.toLowerCase());
    return names.includes(wanted) || names.includes(singular);
  });
  if (hit) return hit.id;

  const created = await squareRequest<{ catalog_object: { id: string } }>(env, 'POST', '/v2/catalog/object', {
    idempotency_key: idempotencyKey('unit', weight ?? singular),
    object: {
      type: 'MEASUREMENT_UNIT',
      id: '#unit',
      measurement_unit_data: {
        measurement_unit: weight ? { weight_unit: weight } : { custom_unit: { name: singular, abbreviation: singular.slice(0, 5) } },
        precision: weight ? 2 : 0,
      },
    },
  });
  return created.catalog_object.id;
}

// ---- Writes ----

/**
 * Create "<Farm> - <Product>" with one tracked variation, then link the farm's
 * Vendor to it. Verified in the sandbox (2026-11-25): a vendor info nested in
 * the item create is silently dropped, so the link is its own
 * ITEM_VARIATION_VENDOR_INFO upsert. Both calls are idempotent on `key`, so a
 * retry after a failed link repeats the create harmlessly and finishes the link.
 */
export async function createFarmItem(
  env: SquareEnv,
  args: { farmName: string; vendorId: string; productName: string; price: number; unitId: string; key: string },
): Promise<FarmItem> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the depot) is not set');
  // Wholesale items exist only at the depot/wholesale location, so they never
  // appear on another location's register.
  const presence = { present_at_all_locations: false, present_at_location_ids: [env.SQUARE_LOCATION_ID] };
  const res = await squareRequest<{ catalog_object: SquareItem }>(env, 'POST', '/v2/catalog/object', {
    idempotency_key: idempotencyKey('item', args.key),
    object: {
      type: 'ITEM',
      id: '#item',
      ...presence,
      item_data: {
        name: itemName(args.farmName, args.productName),
        ...(env.SQUARE_CATEGORY_ID ? { categories: [{ id: env.SQUARE_CATEGORY_ID }], reporting_category: { id: env.SQUARE_CATEGORY_ID } } : {}),
        variations: [
          {
            type: 'ITEM_VARIATION',
            id: '#variation',
            ...presence,
            item_variation_data: {
              item_id: '#item',
              name: 'Regular',
              pricing_type: 'FIXED_PRICING',
              price_money: { amount: toCents(args.price), currency: 'USD' },
              measurement_unit_id: args.unitId,
              track_inventory: true,
            },
          },
        ],
      },
    },
  });
  const created = res.catalog_object;
  const variation = created.item_data.variations?.[0];
  if (!variation) throw new Error('Square created the item without a variation');

  await squareRequest(env, 'POST', '/v2/catalog/object', {
    idempotency_key: idempotencyKey('vendorinfo', args.key),
    object: {
      type: 'ITEM_VARIATION_VENDOR_INFO',
      id: '#vendorinfo',
      item_variation_vendor_info_data: { item_variation_id: variation.id, vendor_id: args.vendorId, ordinal: 1 },
    },
  });

  return {
    item_id: created.id,
    variation_id: variation.id,
    variation_version: variation.version,
    product_name: args.productName,
    price: args.price,
    measurement_unit_id: args.unitId,
    category_ids: (created.item_data.categories ?? []).map((c) => c.id),
  };
}

/** Change the variation's price (needs the current version for optimistic locking). */
export async function setVariationPrice(env: SquareEnv, item: FarmItem, price: number, key: string): Promise<void> {
  const current = await squareRequest<{ object: SquareVariation }>(env, 'GET', `/v2/catalog/object/${item.variation_id}`);
  await squareRequest(env, 'POST', '/v2/catalog/object', {
    idempotency_key: idempotencyKey('price', key),
    object: {
      ...current.object,
      item_variation_data: { ...current.object.item_variation_data, price_money: { amount: toCents(price), currency: 'USD' } },
    },
  }).catch((err) => {
    if (!alreadyApplied(err)) throw err;
  });
}

/** Receive newly harvested stock at the depot: ADJUSTMENT NONE → IN_STOCK. Returns the new IN_STOCK count. */
export async function receiveStock(env: SquareEnv, variationId: string, quantity: number, key: string, now: Date = new Date()): Promise<number | null> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the depot) is not set');
  let res: { counts?: SquareCount[] };
  try {
    res = await squareRequest<{ counts?: SquareCount[] }>(env, 'POST', '/v2/inventory/changes/batch-create', {
    idempotency_key: idempotencyKey('receive', key),
    changes: [
      {
        type: 'ADJUSTMENT',
        adjustment: {
          from_state: 'NONE',
          to_state: 'IN_STOCK',
          // `adjustment.location_id` was retired at API version 2026-07-15 (sandbox-verified).
          from_location_id: env.SQUARE_LOCATION_ID,
          to_location_id: env.SQUARE_LOCATION_ID,
          catalog_object_id: variationId,
          quantity: String(quantity),
          occurred_at: now.toISOString(),
        },
      },
    ],
  });
  } catch (err) {
    if (!alreadyApplied(err)) throw err;
    // A retry of a message whose stock was already received: report the current count, add nothing.
    return (await getStockCounts(env, [variationId])).get(variationId) ?? null;
  }
  const count = res.counts?.find((c) => c.catalog_object_id === variationId && c.state === 'IN_STOCK');
  return count ? Number(count.quantity) : null;
}

interface SquareCount { catalog_object_id: string; location_id: string; state: string; quantity: string }

/** IN_STOCK count per variation at the depot only (never summed across locations). */
export async function getStockCounts(env: SquareEnv, variationIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the depot) is not set');
  for (let i = 0; i < variationIds.length; i += 100) {
    let cursor: string | undefined;
    do {
      const page = await squareRequest<{ counts?: SquareCount[]; cursor?: string }>(env, 'POST', '/v2/inventory/counts/batch-retrieve', {
        catalog_object_ids: variationIds.slice(i, i + 100),
        location_ids: [env.SQUARE_LOCATION_ID],
        states: ['IN_STOCK'],
        ...(cursor ? { cursor } : {}),
      });
      for (const c of page.counts ?? []) out.set(c.catalog_object_id, Number(c.quantity));
      cursor = page.cursor || undefined;
    } while (cursor);
  }
  return out;
}

// ---- Orders (handoff 04, build step 4) ----
//
// Sandbox-verified 2026-11-25:
//  - An OPEN order does not change stock, and IN_STOCK → RESERVED_FOR_SALE is
//    not an allowed adjustment. So "available" = IN_STOCK − quantities on OPEN
//    orders (`committedQuantities`).
//  - A fulfillment or order cannot be COMPLETED before the order is paid.
//  - Cancelling an order requires cancelling its fulfillment in the same update.

export type FulfillmentState = 'PROPOSED' | 'RESERVED' | 'PREPARED' | 'COMPLETED' | 'CANCELED' | 'FAILED';

export interface SquareServiceCharge {
  uid?: string;
  name?: string;
  percentage?: string;
  amount_money?: { amount: number; currency: string };
  applied_money?: { amount: number };
  total_money?: { amount: number };
}

export interface SquareOrder {
  id: string;
  version: number;
  state: 'OPEN' | 'COMPLETED' | 'CANCELED' | 'DRAFT';
  reference_id?: string;
  customer_id?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  metadata?: Record<string, string>;
  total_money?: { amount: number; currency: string };
  net_amount_due_money?: { amount: number };
  line_items?: Array<{
    uid: string; name?: string; quantity: string; catalog_object_id?: string;
    base_price_money?: { amount: number }; gross_sales_money?: { amount: number }; total_money?: { amount: number };
  }>;
  service_charges?: SquareServiceCharge[];
  taxes?: Array<{ uid?: string; catalog_object_id?: string; scope?: string }>;
  refunds?: Array<{ id: string; status?: string; created_at?: string; amount_money?: { amount: number }; reason?: string }>;
  fulfillments?: Array<{
    uid: string; type: string; state: FulfillmentState;
    pickup_details?: { pickup_at?: string; note?: string };
    delivery_details?: { deliver_at?: string; note?: string };
  }>;
}

export interface OrderAddress { street: string; city: string; state: string; zip: string }

/**
 * Create a wholesale order at the wholesale location: a PICKUP at the depot or
 * a DELIVERY to the buyer.
 *
 * Tax (wholesale buyers are exempt): the order carries no catalog taxes and
 * auto-apply is off, so Square adds none. Each line also blocks the seller's
 * catalog taxes (`blockTaxIds`) as a backstop. Buyer-paid fees go on as service
 * charges; `taxes` holds only the LINE_ITEM-scoped taxes those fees reference
 * (empty unless fees are set to be taxed).
 */
export async function createWholesaleOrder(
  env: SquareEnv,
  args: {
    customerId: string; buyerName: string; orderNumber: string; metadata: Record<string, string>;
    lines: Array<{ variationId: string; quantity: number }>; at: Date; note?: string; key: string;
    fulfillment: 'pickup' | 'delivery'; address?: OrderAddress;
    serviceCharges?: Array<Record<string, unknown>>; taxes?: Array<Record<string, unknown>>; blockTaxIds?: string[];
  },
): Promise<SquareOrder> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the wholesale location) is not set');
  if (args.fulfillment === 'delivery' && !args.address) throw new Error('A delivery order needs the buyer address');
  const note = args.note ? { note: args.note.slice(0, 500) } : {};
  const recipient = { customer_id: args.customerId, display_name: args.buyerName };
  const fulfillment = args.fulfillment === 'delivery'
    ? {
        type: 'DELIVERY',
        state: 'PROPOSED',
        delivery_details: {
          recipient: {
            ...recipient,
            address: {
              address_line_1: args.address!.street,
              locality: args.address!.city,
              administrative_district_level_1: args.address!.state,
              postal_code: args.address!.zip,
              country: 'US',
            },
          },
          schedule_type: 'SCHEDULED',
          deliver_at: args.at.toISOString(),
          ...note,
        },
      }
    : {
        type: 'PICKUP',
        state: 'PROPOSED',
        pickup_details: { recipient, schedule_type: 'SCHEDULED', pickup_at: args.at.toISOString(), ...note },
      };
  const blocked = (args.blockTaxIds ?? []).map((id, i) => ({ uid: `block-${i}`, tax_catalog_object_id: id }));
  const res = await squareRequest<{ order: SquareOrder }>(env, 'POST', '/v2/orders', {
    idempotency_key: idempotencyKey('order', args.key),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      customer_id: args.customerId,
      reference_id: args.orderNumber,
      metadata: args.metadata,
      pricing_options: { auto_apply_taxes: false, auto_apply_discounts: false },
      line_items: args.lines.map((l) => ({
        catalog_object_id: l.variationId,
        quantity: String(l.quantity),
        ...(blocked.length ? { pricing_blocklists: { blocked_taxes: blocked } } : {}),
      })),
      ...(args.taxes?.length ? { taxes: args.taxes } : {}),
      ...(args.serviceCharges?.length ? { service_charges: args.serviceCharges } : {}),
      fulfillments: [fulfillment],
    },
  });
  return res.order;
}

export async function getOrder(env: SquareEnv, orderId: string): Promise<SquareOrder> {
  return (await squareRequest<{ order: SquareOrder }>(env, 'GET', `/v2/orders/${encodeURIComponent(orderId)}`)).order;
}

/** True once the order's balance is fully paid (a $0 order counts as unpaid: nothing to settle). */
export function orderPaid(order: SquareOrder): boolean {
  return (order.total_money?.amount ?? 0) > 0 && order.net_amount_due_money?.amount === 0;
}

/**
 * Move the pickup or delivery along, set metadata, change line quantities
 * (check-in), add service charges, or cancel the whole order. Uses the order
 * version for optimistic locking. `metadata` replaces the whole map.
 * A line set to quantity 0 is removed.
 */
export async function updateOrder(
  env: SquareEnv,
  order: SquareOrder,
  change: {
    state?: FulfillmentState; note?: string; metadata?: Record<string, string>;
    lines?: Array<{ uid: string; quantity: number }>;
    addServiceCharges?: Array<Record<string, unknown>>; addTaxes?: Array<Record<string, unknown>>;
  },
): Promise<SquareOrder> {
  const f = order.fulfillments?.[0];
  if (!f) throw new Error('Order has no fulfillment');
  const details = f.type === 'DELIVERY' ? 'delivery_details' : 'pickup_details';
  const kept = (change.lines ?? []).filter((l) => l.quantity > 0);
  const removed = (change.lines ?? []).filter((l) => !(l.quantity > 0));
  const res = await squareRequest<{ order: SquareOrder }>(env, 'PUT', `/v2/orders/${encodeURIComponent(order.id)}`, {
    idempotency_key: idempotencyKey('order-update', order.id, String(order.version), JSON.stringify(change)),
    ...(removed.length ? { fields_to_clear: removed.map((l) => `line_items[${l.uid}]`) } : {}),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      version: order.version,
      ...(change.state === 'CANCELED' ? { state: 'CANCELED' } : {}),
      ...(change.metadata ? { metadata: change.metadata } : {}),
      ...(kept.length ? { line_items: kept.map((l) => ({ uid: l.uid, quantity: String(l.quantity) })) } : {}),
      ...(change.addTaxes?.length ? { taxes: change.addTaxes } : {}),
      ...(change.addServiceCharges?.length ? { service_charges: change.addServiceCharges } : {}),
      ...(change.state || change.note
        ? {
            fulfillments: [
              {
                uid: f.uid,
                ...(change.state ? { state: change.state } : {}),
                ...(change.note ? { [details]: { note: change.note.slice(0, 500) } } : {}),
              },
            ],
          }
        : {}),
    },
  });
  return res.order;
}

/**
 * Wholesale-location orders whose `closed_at` or `updated_at` falls in
 * [start, end), oldest first. Square allows a time filter on one field, with
 * the sort on that same field; `closed_at` applies to COMPLETED orders only.
 */
export async function searchOrdersByTime(
  env: SquareEnv,
  field: 'closed_at' | 'updated_at',
  start: Date,
  end: Date,
  states: Array<SquareOrder['state']> = ['COMPLETED'],
): Promise<SquareOrder[]> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the wholesale location) is not set');
  const out: SquareOrder[] = [];
  let cursor: string | undefined;
  do {
    const res = await squareRequest<{ orders?: SquareOrder[]; cursor?: string }>(env, 'POST', '/v2/orders/search', {
      location_ids: [env.SQUARE_LOCATION_ID],
      limit: 500,
      query: {
        filter: {
          state_filter: { states },
          date_time_filter: { [field]: { start_at: start.toISOString(), end_at: end.toISOString() } },
        },
        sort: { sort_field: field === 'closed_at' ? 'CLOSED_AT' : 'UPDATED_AT', sort_order: 'ASC' },
      },
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(res.orders ?? []));
    cursor = res.cursor || undefined;
  } while (cursor);
  return out;
}

/** Orders at the depot, newest first. `maxPages` bounds the scan (500 per page). */
export async function searchOrders(
  env: SquareEnv,
  filter: { states?: Array<SquareOrder['state']>; customerId?: string },
  maxPages = 4,
): Promise<SquareOrder[]> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the depot) is not set');
  const out: SquareOrder[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await squareRequest<{ orders?: SquareOrder[]; cursor?: string }>(env, 'POST', '/v2/orders/search', {
      location_ids: [env.SQUARE_LOCATION_ID],
      limit: 500,
      query: {
        filter: {
          state_filter: { states: filter.states ?? ['OPEN', 'COMPLETED', 'CANCELED'] },
          ...(filter.customerId ? { customer_filter: { customer_ids: [filter.customerId] } } : {}),
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(res.orders ?? []));
    cursor = res.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Quantity per variation already promised on OPEN orders (Square holds no reservation itself). */
export async function committedQuantities(env: SquareEnv): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const order of await searchOrders(env, { states: ['OPEN'] })) {
    // Square deducts stock when an order is paid, so a paid order is no longer a claim on IN_STOCK.
    if (orderPaid(order)) continue;
    for (const li of order.line_items ?? []) {
      if (li.catalog_object_id) out.set(li.catalog_object_id, (out.get(li.catalog_object_id) ?? 0) + Number(li.quantity));
    }
  }
  return out;
}

// ---- Invoices (handoff 04, build step 5) ----
//
// Sandbox-verified 2026-11-25:
//  - Create (DRAFT) then publish (UNPAID) gives a `public_url` to share.
//    `SHARE_MANUALLY` means Square itself sends nothing: FarmLink texts the
//    link through its own guarded send path.
//  - An order with a published invoice cannot be cancelled directly
//    ("can only be canceled by the owning application"); cancelling the
//    invoice cancels the order and its pickup.
//  - Paying an order moves its quantities IN_STOCK → SOLD a few seconds later.

export interface SquareInvoice {
  id: string;
  version: number;
  status: 'DRAFT' | 'UNPAID' | 'SCHEDULED' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'CANCELED' | 'FAILED' | 'PAYMENT_PENDING';
  order_id: string;
  invoice_number?: string;
  public_url?: string;
  payment_requests?: Array<{ due_date?: string }>;
}

/** Create and publish the invoice for an order. Safe to repeat: both calls are keyed on the order id. */
export async function createAndPublishInvoice(
  env: SquareEnv,
  args: { orderId: string; customerId: string; dueDate: string; title: string },
): Promise<SquareInvoice> {
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID (the depot) is not set');
  const created = await squareRequest<{ invoice: SquareInvoice }>(env, 'POST', '/v2/invoices', {
    idempotency_key: idempotencyKey('invoice', args.orderId),
    invoice: {
      location_id: env.SQUARE_LOCATION_ID,
      order_id: args.orderId,
      primary_recipient: { customer_id: args.customerId },
      delivery_method: 'SHARE_MANUALLY',
      title: args.title,
      payment_requests: [{ request_type: 'BALANCE', due_date: args.dueDate, automatic_payment_source: 'NONE' }],
      accepted_payment_methods: { card: true, bank_account: true },
    },
  });
  // The keyed create returns the original (DRAFT, version 0) response on a repeat, so read the live invoice.
  const current = await getInvoice(env, created.invoice.id);
  if (current.status !== 'DRAFT') return current;
  const published = await squareRequest<{ invoice: SquareInvoice }>(env, 'POST', `/v2/invoices/${encodeURIComponent(current.id)}/publish`, {
    version: current.version,
    idempotency_key: idempotencyKey('invoice-publish', args.orderId),
  });
  return published.invoice;
}

export async function getInvoice(env: SquareEnv, invoiceId: string): Promise<SquareInvoice> {
  return (await squareRequest<{ invoice: SquareInvoice }>(env, 'GET', `/v2/invoices/${encodeURIComponent(invoiceId)}`)).invoice;
}

/** Cancels the invoice, which also cancels its order and pickup. */
export async function cancelInvoice(env: SquareEnv, invoice: SquareInvoice): Promise<SquareInvoice> {
  return (await squareRequest<{ invoice: SquareInvoice }>(env, 'POST', `/v2/invoices/${encodeURIComponent(invoice.id)}/cancel`, { version: invoice.version })).invoice;
}
