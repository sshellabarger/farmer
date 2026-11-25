import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';
import { calculateNextDropoff, sendNewOrderNotification } from '../services/order-notifications.js';
import { DEPOT } from '../config/depot.js';
import { byDateDesc } from '../utils/sort.js';

interface OrderItem {
  inventory_id: string;
  quantity: number;
}

export async function orderCreate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const farmId = input.farm_id as string;
  const marketId = input.market_id as string;
  const items = input.items as OrderItem[];
  const notes = input.notes as string | undefined;

  let total = 0;
  const orderItems: Array<{
    inventory_id: string;
    product_name: string;
    quantity: number;
    unit: string;
    unit_price: number;
    line_total: number;
  }> = [];

  for (const item of items) {
    const invDoc = await db.collection('inventory').doc(item.inventory_id).get();
    if (!invDoc.exists) throw new Error(`Inventory ${item.inventory_id} not found`);
    const inv = invDoc.data()!;

    if (inv.status === 'sold') throw new Error(`Item is sold out`);
    if (inv.remaining < item.quantity) throw new Error(`Only ${inv.remaining} available`);

    const prodDoc = await db.collection('products').doc(inv.product_id).get();
    const product = prodDoc.data() || {};

    const lineTotal = Number(inv.price) * item.quantity;
    total += lineTotal;

    orderItems.push({
      inventory_id: invDoc.id,
      product_name: product.name || 'Unknown',
      quantity: item.quantity,
      unit: product.unit || '',
      unit_price: Number(inv.price),
      line_total: lineTotal,
    });
  }

  // Calculate next drop-off date at the depot based on farm's schedule
  let scheduledDropoff: Date | null = null;
  let dropoffTimeWindow: string | null = null;

  const farmDoc = await db.collection('farms').doc(farmId).get();
  const farm = farmDoc.data();
  if (farm?.delivery_schedule?.length > 0) {
    const slot = calculateNextDropoff(farm!.delivery_schedule);
    if (slot) {
      scheduledDropoff = slot.date;
      dropoffTimeWindow = slot.timeWindow;
    }
  }

  const orderId = uuid();
  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
  await db.collection('orders').doc(orderId).set({
    farm_id: farmId,
    market_id: marketId,
    order_number: orderNumber,
    status: 'pending',
    total,
    order_date: new Date(),
    delivery_type: 'depot',
    scheduled_delivery_at: scheduledDropoff,
    notes: notes ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  for (const oi of orderItems) {
    await db.collection('orders').doc(orderId).collection('order_items').doc(uuid()).set(oi);

    const invRef = db.collection('inventory').doc(oi.inventory_id);
    const invDoc = await invRef.get();
    const inv = invDoc.data()!;
    const newRemaining = inv.remaining - oi.quantity;
    const newStatus = newRemaining <= 0 ? 'sold' : newRemaining < inv.quantity ? 'partial' : 'available';
    await invRef.update({ remaining: Math.max(0, newRemaining), status: newStatus });
  }

  // Notify the farmer of the new pending order (best-effort; must never block creation).
  try {
    await sendNewOrderNotification({ db, env: ctx.env, orderId });
  } catch {
    // Order is already created; a notification failure must not fail the tool call.
  }

  return {
    success: true,
    order_id: orderId,
    order_number: orderNumber,
    total,
    items_count: orderItems.length,
    status: 'pending',
    depot_address: DEPOT.short,
    scheduled_dropoff: scheduledDropoff?.toISOString() || null,
    dropoff_time_window: dropoffTimeWindow || null,
  };
}

export async function orderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  const orderId = input.order_id as string;

  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) throw new Error('Order not found');
  const order = orderDoc.data()!;

  if (userId && input.status) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    const marketSnap = await db.collection('markets').where('user_id', '==', userId).limit(1).get();
    const isFarmParty = !farmSnap.empty && order.farm_id === farmSnap.docs[0].id;
    const isMarketParty = !marketSnap.empty && order.market_id === marketSnap.docs[0].id;

    if (order.status === 'pending') {
      if (isMarketParty && !isFarmParty && input.status !== 'cancelled') {
        throw new Error('Markets can only cancel pending orders.');
      }
    } else if (!isFarmParty) {
      throw new Error('Only the farm can update order status after confirmation.');
    }
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (input.status) updates.status = input.status;
  if (input.notes) updates.notes = input.notes;

  await orderDoc.ref.update(updates);
  const updated = await orderDoc.ref.get();
  return { success: true, order: { id: updated.id, ...updated.data() } };
}

export async function orderQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  let farmId = input.farm_id as string | undefined;
  let marketId = input.market_id as string | undefined;

  if (!farmId && !marketId && userId) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    if (!farmSnap.empty) farmId = farmSnap.docs[0].id;
    else {
      const marketSnap = await db.collection('markets').where('user_id', '==', userId).limit(1).get();
      if (!marketSnap.empty) marketId = marketSnap.docs[0].id;
    }
  }

  // Single equality filter at DB layer; filter + sort the rest in memory.
  let query: FirebaseFirestore.Query = db.collection('orders');
  if (farmId) query = query.where('farm_id', '==', farmId);
  else if (marketId) query = query.where('market_id', '==', marketId);

  const snapshot = await query.get();
  const filtered = snapshot.docs.filter((d) => {
    const o = d.data();
    if (marketId && o.market_id !== marketId) return false;
    if (input.status && o.status !== input.status) return false;
    return true;
  });
  const orderDocs = byDateDesc(filtered.map((d) => ({ doc: d, created_at: d.data().created_at })), 'created_at').slice(0, 20).map((x) => x.doc);

  const results = await Promise.all(
    orderDocs.map(async (doc) => {
      const order = doc.data();
      const farmDoc = await db.collection('farms').doc(order.farm_id).get();
      const marketDoc = await db.collection('markets').doc(order.market_id).get();
      return {
        id: doc.id,
        order_number: order.order_number,
        status: order.status,
        total: order.total,
        order_date: order.order_date,
        farm_name: farmDoc.data()?.name || 'Unknown',
        market_name: marketDoc.data()?.name || 'Unknown',
        notes: order.notes,
      };
    }),
  );

  return { count: results.length, orders: results };
}
