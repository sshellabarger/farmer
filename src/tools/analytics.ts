import { sql } from 'kysely';
import type { ToolContext } from './index.js';

export async function analyticsSummary(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  const period = (input.period as string) || 'week';

  const intervals: Record<string, string> = {
    today: '1 day',
    week: '7 days',
    month: '30 days',
  };
  const interval = intervals[period] || '7 days';

  // Find user's farm
  let farmId: string | undefined;
  if (userId) {
    const farm = await db.selectFrom('farms').select('id').where('user_id', '=', userId).executeTakeFirst();
    farmId = farm?.id;
  }

  if (!farmId && input.farm_id) {
    farmId = input.farm_id as string;
  }

  // Revenue + order count
  let revenueQuery = db
    .selectFrom('orders')
    .select([
      sql<number>`coalesce(sum(total), 0)`.as('revenue'),
      sql<number>`count(*)`.as('order_count'),
    ])
    .where('status', 'in', ['confirmed', 'delivered', 'in_transit'])
    .where('order_date', '>=', sql`CURRENT_DATE - interval '${sql.raw(interval)}'` as any);

  if (farmId) {
    revenueQuery = revenueQuery.where('farm_id', '=', farmId);
  }

  const revenue = await revenueQuery.executeTakeFirst();

  // Top products
  let topQuery = db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select([
      'order_items.product_name',
      sql<number>`sum(order_items.line_total)`.as('revenue'),
      sql<number>`sum(order_items.quantity)`.as('qty'),
      'order_items.unit',
    ])
    .where('orders.status', 'in', ['confirmed', 'delivered', 'in_transit'])
    .where('orders.order_date', '>=', sql`CURRENT_DATE - interval '${sql.raw(interval)}'` as any)
    .groupBy(['order_items.product_name', 'order_items.unit'])
    .orderBy(sql`sum(order_items.line_total)`, 'desc')
    .limit(5);

  if (farmId) {
    topQuery = topQuery.where('orders.farm_id', '=', farmId);
  }

  const topProducts = await topQuery.execute();

  // Active inventory count
  let invCount = db
    .selectFrom('inventory')
    .select(sql<number>`count(*)`.as('count'))
    .where('status', 'in', ['available', 'partial']);

  if (farmId) {
    invCount = invCount.where('farm_id', '=', farmId);
  }

  const inv = await invCount.executeTakeFirst();

  return {
    period,
    revenue: Number(revenue?.revenue || 0),
    order_count: Number(revenue?.order_count || 0),
    active_listings: Number(inv?.count || 0),
    top_products: topProducts.map((p) => ({
      name: p.product_name,
      revenue: Number(p.revenue),
      qty: Number(p.qty),
      unit: p.unit,
    })),
  };
}
