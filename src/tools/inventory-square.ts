import { v4 as uuid } from 'uuid';
import type { ToolContext } from './index.js';
import { validateHarvestDate } from '../utils/freshness.js';
import {
  committedQuantities, createFarmItem, findFarmItem, getStockCounts, idempotencyKey, listFarmItems, listUnits,
  receiveStock, resolveUnitId, setVariationPrice, unitLabel,
} from '../services/square.js';

/**
 * Square-backed inventory tools (handoff 04, build step 3).
 * Square holds the item, price and count. The app DB keeps only what Square
 * can't: one `harvest_lots` row per listing (harvest date), keyed by Square ids.
 */

interface LinkedFarm { id: string; name: string; vendorId: string }

function linked(id: string, data: FirebaseFirestore.DocumentData): LinkedFarm | null {
  return data.square_vendor_id ? { id, name: data.name, vendorId: data.square_vendor_id } : null;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

export async function squareInventoryAdd(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
  if (farmSnap.empty) throw new Error('No farm found for this user');
  const farm = linked(farmSnap.docs[0].id, farmSnap.docs[0].data());
  if (!farm) {
    return { error: 'farm_not_linked', message: 'This farm is not set up as a vendor in Square yet. An admin needs to link it before stock can be listed.' };
  }

  const productName = String(input.product).trim();
  const quantity = Number(input.quantity);
  const unit = String(input.unit).trim();
  const price = input.price === undefined || input.price === null ? undefined : Number(input.price);
  if (!productName || !(quantity > 0)) return { error: 'invalid_input', message: 'A product name and a quantity above zero are required.' };
  if (price !== undefined && !(price > 0)) return { error: 'invalid_input', message: 'Price must be above zero.' };

  let harvestDate = new Date();
  if (input.harvest_date) {
    const r = validateHarvestDate(input.harvest_date as string);
    if (!r.ok) return { error: 'invalid_harvest_date', message: r.message };
    harvestDate = r.date;
  }

  // One key per inbound message + product, so a carrier retry repeats nothing.
  const key = ctx.messageId ? `${ctx.messageId}|${farm.id}|${productName.toLowerCase()}` : uuid();

  let item = await findFarmItem(env, farm, productName);
  if (!item) {
    if (price === undefined) return { needs_price: true, product_name: productName, message: `What price per ${unit}?` };
    const unitId = await resolveUnitId(env, unit);
    item = await createFarmItem(env, { farmName: farm.name, vendorId: farm.vendorId, productName, price, unitId, key });
  } else if (price !== undefined && price !== item.price) {
    await setVariationPrice(env, item, price, key);
    item = { ...item, price };
  } else if (item.price === null) {
    return { needs_price: true, product_name: productName, message: `What price per ${unit}?` };
  }

  const inStock = await receiveStock(env, item.variation_id, quantity, key);

  const lotId = ctx.messageId ? idempotencyKey('lot', key) : uuid();
  await db.collection('harvest_lots').doc(lotId).create({
    farm_id: farm.id,
    square_item_id: item.item_id,
    square_variation_id: item.variation_id,
    product_name: item.product_name,
    quantity,
    harvest_date: harvestDate,
    listed_at: new Date(),
    message_id: ctx.messageId ?? null,
  }).catch((err: { code?: number | string }) => {
    // 6 = ALREADY_EXISTS: this message was already handled.
    if (err.code !== 6 && err.code !== 'already-exists') throw err;
  });

  return {
    success: true,
    inventory_id: lotId,
    square_variation_id: item.variation_id,
    product_name: item.product_name,
    quantity,
    unit,
    price: item.price,
    in_stock_now: inStock,
    harvest_date: harvestDate.toISOString().slice(0, 10),
    farm_name: farm.name,
    product_image_on_file: false,
  };
}

export async function squareInventoryQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;

  let farms: LinkedFarm[] = [];
  if (input.farm_id) {
    const doc = await db.collection('farms').doc(String(input.farm_id)).get();
    const f = doc.exists ? linked(doc.id, doc.data()!) : null;
    if (f) farms = [f];
  } else {
    const own = userId ? await db.collection('farms').where('user_id', '==', userId).limit(1).get() : null;
    if (own && !own.empty) {
      const f = linked(own.docs[0].id, own.docs[0].data());
      if (f) farms = [f];
    } else {
      const all = await db.collection('farms').get();
      farms = all.docs.map((d) => linked(d.id, d.data())).filter((f): f is LinkedFarm => !!f);
    }
  }
  if (farms.length === 0) return { count: 0, inventory: [] };

  const search = input.search ? String(input.search) : undefined;
  const perFarm = await Promise.all(farms.map(async (farm) => ({ farm, items: await listFarmItems(env, farm, search) })));
  const variationIds = perFarm.flatMap((p) => p.items.map((i) => i.variation_id));
  if (variationIds.length === 0) return { count: 0, inventory: [] };

  // Square does not reserve stock for open orders, so subtract what they have promised.
  const [counts, units, committed] = await Promise.all([getStockCounts(env, variationIds), listUnits(env), committedQuantities(env)]);
  const unitById = new Map(units.map((u) => [u.id, unitLabel(u)]));

  const inventory = [];
  for (const { farm, items } of perFarm) {
    // Latest harvest date per variation, from the app DB (Square has no lots).
    const lots = await db.collection('harvest_lots').where('farm_id', '==', farm.id).get();
    const latest = new Map<string, Date>();
    for (const d of lots.docs) {
      const h = toDate(d.data().harvest_date);
      const vid = d.data().square_variation_id as string;
      if (h && (!latest.has(vid) || h > latest.get(vid)!)) latest.set(vid, h);
    }
    for (const item of items) {
      const remaining = (counts.get(item.variation_id) ?? 0) - (committed.get(item.variation_id) ?? 0);
      if (remaining <= 0) continue;
      if (search && !item.product_name.toLowerCase().includes(search.toLowerCase())) continue;
      inventory.push({
        id: item.variation_id,
        product_name: item.product_name,
        farm_name: farm.name,
        remaining,
        unit: item.measurement_unit_id ? unitById.get(item.measurement_unit_id) ?? '' : '',
        price: item.price,
        status: 'available',
        harvest_date: latest.get(item.variation_id)?.toISOString().slice(0, 10) ?? null,
      });
    }
  }
  return { count: inventory.length, inventory };
}
