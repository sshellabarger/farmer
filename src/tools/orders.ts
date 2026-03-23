import { sql } from 'kysely';
import type { ToolContext } from './index.js';
import { calculateNextDeliveryDate } from '../services/order-notifications.js';

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
  const deliveryType = input.delivery_type as 'pickup' | 'delivery' | undefined;

  // Calculate totals and validate inventory
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
    const inv = await db
      .selectFrom('inventory')
      .innerJoin('products', 'products.id', 'inventory.product_id')
      .select([
        'inventory.id',
        'products.name',
        'products.unit',
        'inventory.price',
        'inventory.remaining',
        'inventory.status',
      ])
      .where('inventory.id', '=', item.inventory_id)
      .executeTakeFirst();

    if (!inv) throw new Error(`Inventory ${item.inventory_id} not found`);
    if (inv.status === 'sold') throw new Error(`${inv.name} is sold out`);
    if (Number(inv.remaining) < item.quantity) {
      throw new Error(`Only ${inv.remaining} ${inv.unit} of ${inv.name} available`);
    }

    const lineTotal = Number(inv.price) * item.quantity;
    total += lineTotal;

    orderItems.push({
      inventory_id: inv.id,
      product_name: inv.name,
      quantity: item.quantity,
      unit: inv.unit,
      unit_price: Number(inv.price),
      line_total: lineTotal,
    });
  }

  // Calculate delivery date from farm's schedule
  let scheduledDeliveryAt: Date | null = null;
  let deliveryTimeWindow: string | null = null;

  if (deliveryType) {
    const farm = await db
      .selectFrom('farms')
      .select(['delivery_schedule', 'location'])
      .where('id', '=', farmId)
      .executeTakeFirst();

    const market = await db
      .selectFrom('markets')
      .select(['location'])
      .where('id', '=', marketId)
      .executeTakeFirst();

    if (farm?.delivery_schedule && Array.isArray(farm.delivery_schedule) && farm.delivery_schedule.length > 0) {
      const slot = calculateNextDeliveryDate(farm.delivery_schedule as any, deliveryType, market?.location);
      if (slot) {
        scheduledDeliveryAt = slot.date;
        deliveryTimeWindow = slot.timeWindow;
      }
    }
  }

  // Create order
  const [order] = await db
    .insertInto('orders')
    .values({
      farm_id: farmId,
      market_id: marketId,
      total,
      delivery_type: deliveryType ?? null,
      scheduled_delivery_at: scheduledDeliveryAt,
      notes: notes ?? null,
    })
    .returningAll()
    .execute();

  // Create order items
  for (const oi of orderItems) {
    await db
      .insertInto('order_items')
      .values({ order_id: order.id, ...oi })
      .execute();

    // Decrement inventory
    await db
      .updateTable('inventory')
      .set({
        remaining: sql`remaining - ${oi.quantity}`,
        status: sql`CASE WHEN remaining - ${oi.quantity} <= 0 THEN 'sold'::inventory_status WHEN remaining - ${oi.quantity} < quantity THEN 'partial'::inventory_status ELSE status END`,
      })
      .where('id', '=', oi.inventory_id)
      .execute();
  }

  return {
    success: true,
    order_id: order.id,
    order_number: order.order_number,
    total,
    items_count: orderItems.length,
    status: 'pending',
    delivery_type: deliveryType || null,
    scheduled_delivery_at: scheduledDeliveryAt?.toISOString() || null,
    delivery_time_window: deliveryTimeWindow || null,
  };
}

export async function orderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const orderId = input.order_id as string;

  const updates: Record<string, unknown> = {};
  if (input.status) updates.status = input.status;
  if (input.notes) updates.notes = input.notes;

  const [updated] = await db
    .updateTable('orders')
    .set(updates)
    .where('id', '=', orderId)
    .returningAll()
    .execute();

  if (!updated) throw new Error('Order not found');

  return { success: true, order: updated };
}

export async function orderQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  let query = db
    .selectFrom('orders')
    .innerJoin('farms', 'farms.id', 'orders.farm_id')
    .innerJoin('markets', 'markets.id', 'orders.market_id')
    .select([
      'orders.id',
      'orders.order_number',
      'orders.status',
      'orders.total',
      'orders.order_date',
      'farms.name as farm_name',
      'markets.name as market_name',
      'orders.notes',
    ]);

  if (input.farm_id) {
    query = query.where('orders.farm_id', '=', input.farm_id as string);
  }
  if (input.market_id) {
    query = query.where('orders.market_id', '=', input.market_id as string);
  }
  if (input.status) {
    query = query.where('orders.status', '=', input.status as any);
  }
  if (input.date) {
    query = query.where('orders.order_date', '=', input.date as any);
  }

  // Default scope to user's farm or market
  if (!input.farm_id && !input.market_id && userId) {
    const farm = await db.selectFrom('farms').select('id').where('user_id', '=', userId).executeTakeFirst();
    const market = await db.selectFrom('markets').select('id').where('user_id', '=', userId).executeTakeFirst();
    if (farm) query = query.where('orders.farm_id', '=', farm.id);
    else if (market) query = query.where('orders.market_id', '=', market.id);
  }

  const results = await query.orderBy('orders.created_at', 'desc').limit(20).execute();

  return { count: results.length, orders: results };
}
