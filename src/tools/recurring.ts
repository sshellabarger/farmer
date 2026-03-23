import type { ToolContext } from './index.js';

export async function recurringOrderCreate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const farmId = input.farm_id as string | undefined;
  const marketId = input.market_id as string | undefined;
  const frequency = input.frequency as string;
  const days = input.days as string;
  const items = input.items as Array<{ product_name: string; quantity: number; unit: string }>;

  // Resolve farm/market from user if not provided
  let resolvedFarmId = farmId;
  let resolvedMarketId = marketId;

  if (!resolvedFarmId) {
    const farm = await db.selectFrom('farms').select('id').where('user_id', '=', userId).executeTakeFirst();
    if (farm) resolvedFarmId = farm.id;
  }
  if (!resolvedMarketId) {
    const market = await db.selectFrom('markets').select('id').where('user_id', '=', userId).executeTakeFirst();
    if (market) resolvedMarketId = market.id;
  }

  if (!resolvedFarmId || !resolvedMarketId) {
    throw new Error('Both farm_id and market_id are required');
  }

  // Calculate next delivery
  const nextDelivery = new Date();
  nextDelivery.setDate(nextDelivery.getDate() + 1);

  const [ro] = await db
    .insertInto('recurring_orders')
    .values({
      farm_id: resolvedFarmId,
      market_id: resolvedMarketId,
      frequency: frequency as any,
      schedule_days: days,
      next_delivery: nextDelivery,
      active: true,
    })
    .returningAll()
    .execute();

  // Resolve product IDs and create items
  for (const item of items) {
    const product = await db
      .selectFrom('products')
      .select('id')
      .where('farm_id', '=', resolvedFarmId)
      .where('name', 'ilike', `%${item.product_name}%`)
      .executeTakeFirst();

    if (product) {
      await db
        .insertInto('recurring_order_items')
        .values({
          recurring_order_id: ro.id,
          product_id: product.id,
          quantity: item.quantity,
          unit: item.unit,
        })
        .execute();
    }
  }

  return {
    success: true,
    recurring_order_id: ro.id,
    frequency,
    schedule_days: days,
    next_delivery: nextDelivery.toISOString().split('T')[0],
    items_count: items.length,
  };
}

export async function recurringOrderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const id = input.recurring_id as string;

  const updates: Record<string, unknown> = {};
  if (input.frequency) updates.frequency = input.frequency;
  if (input.schedule_days) updates.schedule_days = input.schedule_days;
  if (input.active !== undefined) updates.active = input.active;

  if (Object.keys(updates).length > 0) {
    await db.updateTable('recurring_orders').set(updates).where('id', '=', id).execute();
  }

  return { success: true, updated_fields: Object.keys(updates) };
}
