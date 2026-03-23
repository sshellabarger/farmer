import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

function dateFilter(interval: string) {
  return sql`CURRENT_DATE - interval '${sql.raw(interval)}'`;
}

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /api/analytics/revenue?farm_id=&period=week|month|quarter
  app.get<{ Querystring: Record<string, string> }>('/revenue', async (request) => {
    const { farm_id, period = 'week' } = request.query;

    const intervals: Record<string, string> = {
      week: '7 days',
      month: '30 days',
      quarter: '90 days',
    };
    const interval = intervals[period] || '7 days';

    let query = app.db
      .selectFrom('orders')
      .select([
        sql<string>`date_trunc('day', orders.order_date)`.as('day'),
        sql<number>`sum(orders.total)`.as('revenue'),
        sql<number>`count(*)`.as('order_count'),
      ])
      .where('orders.status', 'in', ['confirmed', 'delivered', 'in_transit'])
      .where('orders.order_date', '>=', dateFilter(interval) as any)
      .groupBy(sql`date_trunc('day', orders.order_date)`)
      .orderBy(sql`date_trunc('day', orders.order_date)`, 'asc');

    if (farm_id) {
      query = query.where('orders.farm_id', '=', farm_id);
    }

    const daily = await query.execute();

    // Totals
    let totalsQuery = app.db
      .selectFrom('orders')
      .select([
        sql<number>`coalesce(sum(total), 0)`.as('total_revenue'),
        sql<number>`count(*)`.as('total_orders'),
        sql<number>`coalesce(avg(total), 0)`.as('avg_order_value'),
      ])
      .where('status', 'in', ['confirmed', 'delivered', 'in_transit'])
      .where('order_date', '>=', dateFilter(interval) as any);

    if (farm_id) {
      totalsQuery = totalsQuery.where('farm_id', '=', farm_id);
    }

    const totals = await totalsQuery.executeTakeFirst();

    // Previous period for comparison
    let prevQuery = app.db
      .selectFrom('orders')
      .select([sql<number>`coalesce(sum(total), 0)`.as('total_revenue')])
      .where('status', 'in', ['confirmed', 'delivered', 'in_transit'])
      .where('order_date', '>=', sql`CURRENT_DATE - interval '${sql.raw(interval)}' * 2` as any)
      .where('order_date', '<', dateFilter(interval) as any);

    if (farm_id) {
      prevQuery = prevQuery.where('farm_id', '=', farm_id);
    }

    const prev = await prevQuery.executeTakeFirst();

    const currentRev = Number(totals?.total_revenue || 0);
    const prevRev = Number(prev?.total_revenue || 0);
    const changePercent = prevRev > 0 ? ((currentRev - prevRev) / prevRev) * 100 : 0;

    return {
      period,
      ...totals,
      previous_revenue: prevRev,
      change_percent: Math.round(changePercent * 10) / 10,
      daily,
    };
  });

  // GET /api/analytics/top-products?farm_id=&period=week|month
  app.get<{ Querystring: Record<string, string> }>('/top-products', async (request) => {
    const { farm_id, period = 'month' } = request.query;
    const interval = period === 'week' ? '7 days' : '30 days';

    let query = app.db
      .selectFrom('order_items')
      .innerJoin('orders', 'orders.id', 'order_items.order_id')
      .select([
        'order_items.product_name',
        sql<number>`sum(order_items.line_total)`.as('revenue'),
        sql<number>`sum(order_items.quantity)`.as('total_quantity'),
        'order_items.unit',
      ])
      .where('orders.status', 'in', ['confirmed', 'delivered', 'in_transit'])
      .where('orders.order_date', '>=', dateFilter(interval) as any)
      .groupBy(['order_items.product_name', 'order_items.unit'])
      .orderBy(sql`sum(order_items.line_total)`, 'desc')
      .limit(10);

    if (farm_id) {
      query = query.where('orders.farm_id', '=', farm_id);
    }

    const products = await query.execute();
    return { period, products };
  });

  // GET /api/analytics/market-breakdown?farm_id=&period=month
  app.get<{ Querystring: Record<string, string> }>('/market-breakdown', async (request) => {
    const { farm_id, period = 'month' } = request.query;
    const interval = period === 'week' ? '7 days' : period === 'quarter' ? '90 days' : '30 days';

    let query = app.db
      .selectFrom('orders')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'markets.id as market_id',
        'markets.name as market_name',
        sql<number>`sum(orders.total)`.as('revenue'),
        sql<number>`count(*)`.as('order_count'),
      ])
      .where('orders.status', 'in', ['confirmed', 'delivered', 'in_transit'])
      .where('orders.order_date', '>=', dateFilter(interval) as any)
      .groupBy(['markets.id', 'markets.name'])
      .orderBy(sql`sum(orders.total)`, 'desc');

    if (farm_id) {
      query = query.where('orders.farm_id', '=', farm_id);
    }

    const markets = await query.execute();

    const totalRevenue = markets.reduce((sum, m) => sum + Number(m.revenue), 0);
    const withPercent = markets.map((m) => ({
      ...m,
      percent: totalRevenue > 0 ? Math.round((Number(m.revenue) / totalRevenue) * 100) : 0,
    }));

    return { period, total_revenue: totalRevenue, markets: withPercent };
  });
}
