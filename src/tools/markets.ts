import type { ToolContext } from './index.js';

export async function marketQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;

  if (input.farm_id) {
    const relsSnap = await db.collection('farm_market_rels')
      .where('farm_id', '==', input.farm_id)
      .get();
    const activeRels = relsSnap.docs
      .filter((d) => d.data().active)
      .sort((a, b) => (a.data().priority ?? 99) - (b.data().priority ?? 99));

    const markets = await Promise.all(
      activeRels.map(async (d) => {
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
      .get();

    const farmIds = relsSnap.docs.filter((d) => d.data().active).map((d) => d.data().farm_id);
    const inventory: any[] = [];

    for (const farmId of farmIds) {
      const invSnap = await db.collection('inventory')
        .where('farm_id', '==', farmId)
        .get();

      for (const doc of invSnap.docs) {
        const inv = doc.data();
        if (!['available', 'partial'].includes(inv.status)) continue;
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
