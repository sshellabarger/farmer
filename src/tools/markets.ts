import type { ToolContext } from './index.js';

export async function marketQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;

  if (input.farm_id) {
    const relsSnap = await db.collection('farm_market_rels')
      .where('farm_id', '==', input.farm_id)
      .where('active', '==', true)
      .orderBy('priority')
      .get();

    const markets = await Promise.all(
      relsSnap.docs.map(async (d) => {
        const rel = d.data();
        const mDoc = await db.collection('markets').doc(rel.market_id).get();
        const m = mDoc.data() || {};
        return {
          id: mDoc.id,
          name: m.name,
          type: m.type,
          location: m.location,
          priority: rel.priority,
          notification_delay_min: rel.notification_delay_min,
          active: rel.active,
        };
      }),
    );

    return { count: markets.length, markets };
  }

  if (input.market_id) {
    const relsSnap = await db.collection('farm_market_rels')
      .where('market_id', '==', input.market_id)
      .where('active', '==', true)
      .get();

    const farmIds = relsSnap.docs.map((d) => d.data().farm_id);
    const inventory: any[] = [];

    for (const farmId of farmIds) {
      const invSnap = await db.collection('inventory')
        .where('farm_id', '==', farmId)
        .where('status', 'in', ['available', 'partial'])
        .get();

      for (const doc of invSnap.docs) {
        const inv = doc.data();
        if (inv.remaining <= 0) continue;
        const prodDoc = await db.collection('products').doc(inv.product_id).get();
        const product = prodDoc.data() || {};
        const farmDoc = await db.collection('farms').doc(farmId).get();

        inventory.push({
          id: doc.id,
          product_name: product.name || 'Unknown',
          category: product.category || '',
          farm_name: farmDoc.data()?.name || 'Unknown',
          remaining: inv.remaining,
          unit: product.unit || '',
          price: inv.price,
          harvest_date: inv.harvest_date,
        });
      }
    }

    return { count: inventory.length, available_inventory: inventory };
  }

  return { error: 'Provide either farm_id or market_id' };
}
