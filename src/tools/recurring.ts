import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';

export async function recurringOrderCreate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const frequency = input.frequency as string;
  const days = input.days as string;
  const items = input.items as Array<{ product_name: string; quantity: number; unit: string }>;

  let farmId = input.farm_id as string | undefined;
  let marketId = input.market_id as string | undefined;

  if (!farmId) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    if (!farmSnap.empty) farmId = farmSnap.docs[0].id;
  }
  if (!marketId) {
    const marketSnap = await db.collection('markets').where('user_id', '==', userId).limit(1).get();
    if (!marketSnap.empty) marketId = marketSnap.docs[0].id;
  }

  if (!farmId || !marketId) throw new Error('Both farm_id and market_id are required');

  const nextDelivery = new Date();
  nextDelivery.setDate(nextDelivery.getDate() + 1);

  const roId = uuid();
  await db.collection('recurring_orders').doc(roId).set({
    farm_id: farmId,
    market_id: marketId,
    frequency,
    schedule_days: days,
    next_delivery: nextDelivery,
    active: true,
    created_at: new Date(),
  });

  for (const item of items) {
    const prodSnap = await db.collection('products')
      .where('farm_id', '==', farmId)
      .get();

    const match = prodSnap.docs.find((d) =>
      d.data().name.toLowerCase().includes(item.product_name.toLowerCase())
    );

    if (match) {
      await db.collection('recurring_orders').doc(roId).collection('recurring_order_items').doc(uuid()).set({
        product_id: match.id,
        quantity: item.quantity,
        unit: item.unit,
      });
    }
  }

  return {
    success: true,
    recurring_order_id: roId,
    frequency,
    schedule_days: days,
    next_delivery: nextDelivery.toISOString().split('T')[0],
    items_count: items.length,
  };
}

export async function recurringOrderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const id = input.recurring_id as string;

  const ref = db.collection('recurring_orders').doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Recurring order not found');

  const updates: Record<string, unknown> = {};
  if (input.frequency) updates.frequency = input.frequency;
  if (input.schedule_days) updates.schedule_days = input.schedule_days;
  if (input.active !== undefined) updates.active = input.active;

  if (Object.keys(updates).length > 0) await ref.update(updates);

  return { success: true, updated_fields: Object.keys(updates) };
}
