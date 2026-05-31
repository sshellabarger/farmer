import type { ToolContext } from './index.js';

export async function analyticsSummary(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  const period = (input.period as string) || 'week';

  const periodDays: Record<string, number> = { today: 1, week: 7, month: 30 };
  const days = periodDays[period] || 7;
  const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let farmId: string | undefined;
  if (userId) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    if (!farmSnap.empty) farmId = farmSnap.docs[0].id;
  }
  if (!farmId && input.farm_id) farmId = input.farm_id as string;

  let query: FirebaseFirestore.Query = db.collection('orders')
    .where('status', 'in', ['confirmed', 'delivered', 'in_transit']);
  if (farmId) query = query.where('farm_id', '==', farmId);

  const snapshot = await query.get();

  let revenue = 0;
  let orderCount = 0;
  const productMap = new Map<string, { revenue: number; qty: number; unit: string }>();

  for (const doc of snapshot.docs) {
    const order = doc.data();
    const orderDate = order.order_date?.toDate?.() || new Date(order.order_date);
    if (orderDate < periodStart) continue;

    revenue += Number(order.total || 0);
    orderCount++;

    const itemsSnap = await db.collection('orders').doc(doc.id).collection('order_items').get();
    for (const itemDoc of itemsSnap.docs) {
      const item = itemDoc.data();
      const key = `${item.product_name}|${item.unit}`;
      const entry = productMap.get(key) || { revenue: 0, qty: 0, unit: item.unit };
      entry.revenue += Number(item.line_total || 0);
      entry.qty += Number(item.quantity || 0);
      productMap.set(key, entry);
    }
  }

  const topProducts = Array.from(productMap.entries())
    .map(([key, data]) => ({ name: key.split('|')[0], ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  let activeListings = 0;
  let invQuery: FirebaseFirestore.Query = db.collection('inventory')
    .where('status', 'in', ['available', 'partial']);
  if (farmId) invQuery = invQuery.where('farm_id', '==', farmId);
  const invSnap = await invQuery.get();
  activeListings = invSnap.size;

  return {
    period,
    revenue,
    order_count: orderCount,
    active_listings: activeListings,
    top_products: topProducts,
  };
}
