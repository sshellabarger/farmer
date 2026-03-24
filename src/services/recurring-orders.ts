import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { sendSms } from './telnyx.js';

/**
 * Process all recurring orders due today.
 * Called daily by the BullMQ scheduler (once per farm timezone).
 *
 * For each due recurring order:
 *   1. Check inventory availability for all items
 *   2. If available → create a real order + order items, decrement inventory, notify both parties
 *   3. If unavailable → alert farmer, notify market of shortage
 *   4. Calculate and set the next delivery date
 */
export async function processRecurringOrders(db: Kysely<DB>, env: Env): Promise<{ processed: number; created: number; skipped: number }> {
  const today = new Date().toISOString().split('T')[0];

  // 1. Find all due recurring orders
  const dueOrders = await db
    .selectFrom('recurring_orders')
    .innerJoin('farms', 'farms.id', 'recurring_orders.farm_id')
    .innerJoin('markets', 'markets.id', 'recurring_orders.market_id')
    .innerJoin('users as farmer_user', 'farmer_user.id', 'farms.user_id')
    .innerJoin('users as market_user', 'market_user.id', 'markets.user_id')
    .select([
      'recurring_orders.id',
      'recurring_orders.farm_id',
      'recurring_orders.market_id',
      'recurring_orders.frequency',
      'recurring_orders.schedule_days',
      'recurring_orders.next_delivery',
      'farms.name as farm_name',
      'markets.name as market_name',
      'farmer_user.phone as farmer_phone',
      'market_user.phone as market_phone',
    ])
    .where('recurring_orders.active', '=', true)
    .where('recurring_orders.next_delivery', '<=', today as any)
    .execute();

  let created = 0;
  let skipped = 0;

  for (const ro of dueOrders) {
    // 2. Load recurring order items
    const roItems = await db
      .selectFrom('recurring_order_items')
      .innerJoin('products', 'products.id', 'recurring_order_items.product_id')
      .select([
        'recurring_order_items.product_id',
        'recurring_order_items.quantity',
        'recurring_order_items.unit',
        'products.name as product_name',
      ])
      .where('recurring_order_items.recurring_order_id', '=', ro.id)
      .execute();

    // 3. Check inventory for each item
    let allAvailable = true;
    const orderItems: Array<{
      inventory_id: string;
      product_name: string;
      quantity: number;
      unit: string;
      unit_price: number;
      line_total: number;
    }> = [];
    const unavailable: string[] = [];

    for (const item of roItems) {
      // Find best available inventory for this product from this farm
      const inv = await db
        .selectFrom('inventory')
        .selectAll()
        .where('farm_id', '=', ro.farm_id)
        .where('product_id', '=', item.product_id)
        .where('status', 'in', ['available', 'partial'])
        .where('remaining', '>=', item.quantity)
        .orderBy('harvest_date', 'desc')
        .executeTakeFirst();

      if (!inv) {
        allAvailable = false;
        unavailable.push(`${item.quantity} ${item.unit} ${item.product_name}`);
        continue;
      }

      const lineTotal = Number(inv.price) * item.quantity;
      orderItems.push({
        inventory_id: inv.id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: Number(inv.price),
        line_total: lineTotal,
      });
    }

    if (!allAvailable || orderItems.length === 0) {
      // Alert farmer about unavailable items
      const itemList = unavailable.join(', ');
      await sendSms({
        env,
        to: ro.farmer_phone,
        body: `⚠️ Standing order for ${ro.market_name} is due today but inventory is short:\n${itemList}\n\nReply with updated availability or I'll notify the market.`,
      });

      // Notify market
      await sendSms({
        env,
        to: ro.market_phone,
        body: `⚠️ Your standing order from ${ro.farm_name} may be short today. ${ro.farm_name} has been notified. We'll update you soon.`,
      });

      skipped++;
    }

    if (orderItems.length > 0) {
      // 4. Create the real order
      const total = orderItems.reduce((sum, oi) => sum + oi.line_total, 0);

      const [order] = await db
        .insertInto('orders')
        .values({
          farm_id: ro.farm_id,
          market_id: ro.market_id,
          total,
          notes: `Auto-created from standing order ${ro.id}`,
        })
        .returningAll()
        .execute();

      // Create order items + decrement inventory
      for (const oi of orderItems) {
        await db
          .insertInto('order_items')
          .values({ order_id: order.id, ...oi })
          .execute();

        await db
          .updateTable('inventory')
          .set({
            remaining: sql`remaining - ${oi.quantity}`,
            status: sql`CASE WHEN remaining - ${oi.quantity} <= 0 THEN 'sold'::inventory_status WHEN remaining - ${oi.quantity} < quantity THEN 'partial'::inventory_status ELSE status END`,
          })
          .where('id', '=', oi.inventory_id)
          .execute();
      }

      // 5. Notify both parties
      const itemSummary = orderItems.map((oi) => `${oi.quantity} ${oi.unit} ${oi.product_name}`).join(', ');

      await sendSms({
        env,
        to: ro.farmer_phone,
        body: `✅ Standing order fulfilled: ${ro.market_name}\n${itemSummary}\nTotal: $${total.toFixed(2)}\nOrder #${order.order_number}`,
      });

      await sendSms({
        env,
        to: ro.market_phone,
        body: `✅ Your standing order from ${ro.farm_name} is confirmed!\n${itemSummary}\nTotal: $${total.toFixed(2)}\nOrder #${order.order_number}`,
      });

      created++;
    }

    // 6. Calculate and set next delivery date
    const nextDate = calculateNextDelivery(
      ro.frequency as string,
      ro.schedule_days as string,
      new Date(today)
    );

    await db
      .updateTable('recurring_orders')
      .set({ next_delivery: nextDate })
      .where('id', '=', ro.id)
      .execute();
  }

  return { processed: dueOrders.length, created, skipped };
}

/**
 * Calculate the next delivery date based on frequency and schedule.
 */
function calculateNextDelivery(frequency: string, scheduleDays: string, fromDate: Date): Date {
  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const targetDays = scheduleDays
    .toLowerCase()
    .split(/[,&\s]+/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => DAY_NAMES.indexOf(d.slice(0, 3)))
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);

  const next = new Date(fromDate);
  next.setDate(next.getDate() + 1); // start from tomorrow

  switch (frequency) {
    case 'daily':
      return next;

    case 'twice_weekly':
    case 'weekly': {
      // Find the next occurrence of a target day
      if (targetDays.length === 0) {
        // Default: same day next week
        next.setDate(next.getDate() + 6);
        return next;
      }
      for (let i = 0; i < 14; i++) {
        if (targetDays.includes(next.getDay())) return next;
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    case 'biweekly': {
      if (targetDays.length === 0) {
        next.setDate(next.getDate() + 13);
        return next;
      }
      // Skip to at least 7 days from now, then find target day
      next.setDate(next.getDate() + 7);
      for (let i = 0; i < 14; i++) {
        if (targetDays.includes(next.getDay())) return next;
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    case 'monthly': {
      next.setMonth(next.getMonth() + 1);
      next.setDate(fromDate.getDate());
      return next;
    }

    default:
      next.setDate(next.getDate() + 6);
      return next;
  }
}
