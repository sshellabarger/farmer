import type { FastifyInstance } from 'fastify';

function getPeriodStart(period: string): Date {
  const now = new Date();
  switch (period) {
    case 'week': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'quarter': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /api/analytics/revenue?farm_id=&period=week|month|quarter
  app.get<{ Querystring: Record<string, string> }>('/revenue', async (request) => {
    const { farm_id, period = 'week' } = request.query;
    const periodStart = getPeriodStart(period);
    const periodMs = new Date().getTime() - periodStart.getTime();
    const prevStart = new Date(periodStart.getTime() - periodMs);

    let query: FirebaseFirestore.Query = app.db.collection('orders');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    const ACTIVE_STATUSES = ['confirmed', 'delivered', 'in_transit'];

    const snapshot = await query.get();

    let totalRevenue = 0;
    let totalOrders = 0;
    let prevRevenue = 0;
    const dailyMap = new Map<string, { revenue: number; order_count: number }>();

    for (const doc of snapshot.docs) {
      const order = doc.data();
      if (!ACTIVE_STATUSES.includes(order.status)) continue;
      const orderDate = order.order_date?.toDate?.() || new Date(order.order_date);

      if (orderDate >= periodStart) {
        totalRevenue += Number(order.total || 0);
        totalOrders++;
        const dayKey = orderDate.toISOString().slice(0, 10);
        const entry = dailyMap.get(dayKey) || { revenue: 0, order_count: 0 };
        entry.revenue += Number(order.total || 0);
        entry.order_count++;
        dailyMap.set(dayKey, entry);
      } else if (orderDate >= prevStart && orderDate < periodStart) {
        prevRevenue += Number(order.total || 0);
      }
    }

    const changePercent = prevRevenue > 0
      ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 1000) / 10
      : 0;

    const daily = Array.from(dailyMap.entries())
      .map(([day, data]) => ({ day, ...data }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      period,
      total_revenue: totalRevenue,
      total_orders: totalOrders,
      avg_order_value: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
      previous_revenue: prevRevenue,
      change_percent: changePercent,
      daily,
    };
  });

  // GET /api/analytics/top-products?farm_id=&period=month
  app.get<{ Querystring: Record<string, string> }>('/top-products', async (request) => {
    const { farm_id, period = 'month' } = request.query;
    const periodStart = getPeriodStart(period);

    let query: FirebaseFirestore.Query = app.db.collection('orders');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    const ACTIVE_STATUSES = ['confirmed', 'delivered', 'in_transit'];

    const ordersSnap = await query.get();
    const productMap = new Map<string, { revenue: number; total_quantity: number; unit: string }>();

    for (const orderDoc of ordersSnap.docs) {
      const order = orderDoc.data();
      if (!ACTIVE_STATUSES.includes(order.status)) continue;
      const orderDate = order.order_date?.toDate?.() || new Date(order.order_date);
      if (orderDate < periodStart) continue;

      const itemsSnap = await app.db
        .collection('orders').doc(orderDoc.id).collection('order_items').get();

      for (const itemDoc of itemsSnap.docs) {
        const item = itemDoc.data();
        const key = `${item.product_name}|${item.unit}`;
        const entry = productMap.get(key) || { revenue: 0, total_quantity: 0, unit: item.unit };
        entry.revenue += Number(item.line_total || 0);
        entry.total_quantity += Number(item.quantity || 0);
        productMap.set(key, entry);
      }
    }

    const products = Array.from(productMap.entries())
      .map(([key, data]) => ({ product_name: key.split('|')[0], ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    return { period, products };
  });

  // GET /api/analytics/market-breakdown?farm_id=&period=month
  app.get<{ Querystring: Record<string, string> }>('/market-breakdown', async (request) => {
    const { farm_id, period = 'month' } = request.query;
    const periodStart = getPeriodStart(period);

    let query: FirebaseFirestore.Query = app.db.collection('orders');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    const ACTIVE_STATUSES = ['confirmed', 'delivered', 'in_transit'];

    const snapshot = await query.get();
    const marketMap = new Map<string, { revenue: number; order_count: number }>();

    for (const doc of snapshot.docs) {
      const order = doc.data();
      if (!ACTIVE_STATUSES.includes(order.status)) continue;
      const orderDate = order.order_date?.toDate?.() || new Date(order.order_date);
      if (orderDate < periodStart) continue;

      const entry = marketMap.get(order.market_id) || { revenue: 0, order_count: 0 };
      entry.revenue += Number(order.total || 0);
      entry.order_count++;
      marketMap.set(order.market_id, entry);
    }

    const marketsData = await Promise.all(
      Array.from(marketMap.entries()).map(async ([marketId, data]) => {
        const marketDoc = await app.db.collection('markets').doc(marketId).get();
        return {
          market_id: marketId,
          market_name: marketDoc.data()?.name || 'Unknown',
          ...data,
        };
      }),
    );

    marketsData.sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = marketsData.reduce((sum, m) => sum + m.revenue, 0);
    const withPercent = marketsData.map((m) => ({
      ...m,
      percent: totalRevenue > 0 ? Math.round((m.revenue / totalRevenue) * 100) : 0,
    }));

    return { period, total_revenue: totalRevenue, markets: withPercent };
  });
}
