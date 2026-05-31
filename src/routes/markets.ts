import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireMarketOwner } from '../middleware/rbac.js';

export async function marketRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const marketOwner = requireMarketOwner(app);
  const marketOrAdmin = requireRole('market', 'admin');

  // GET /api/markets (public)
  app.get('/', async () => {
    const snapshot = await app.db.collection('markets').orderBy('name').get();
    const markets = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { markets };
  });

  // GET /api/markets/:id (public)
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const doc = await app.db.collection('markets').doc(request.params.id).get();
    if (!doc.exists) return reply.notFound('Market not found');
    return { id: doc.id, ...doc.data() };
  });

  // PUT /api/markets/:id
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request, reply) => {
    const { name, location, type, delivery_pref } = request.body as any;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (type) updates.type = type;
    if (delivery_pref) updates.delivery_pref = delivery_pref;

    const ref = app.db.collection('markets').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Market not found');

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // GET /api/markets/:id/available
  app.get<{ Params: { id: string } }>('/:id/available', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const marketId = request.params.id;

    // Get farms connected to this market
    const relsSnap = await app.db
      .collection('farm_market_rels')
      .where('market_id', '==', marketId)
      .where('active', '==', true)
      .get();

    const farmIds = relsSnap.docs.map((d) => d.data().farm_id);
    if (farmIds.length === 0) return { inventory: [] };

    // Get available inventory from connected farms
    const inventory: any[] = [];
    for (const farmId of farmIds) {
      const invSnap = await app.db
        .collection('inventory')
        .where('farm_id', '==', farmId)
        .where('status', 'in', ['available', 'partial'])
        .get();

      for (const doc of invSnap.docs) {
        const inv = doc.data();
        if (inv.remaining <= 0) continue;
        const productDoc = await app.db.collection('products').doc(inv.product_id).get();
        const product = productDoc.data() || {};
        const farmDoc = await app.db.collection('farms').doc(farmId).get();
        const farm = farmDoc.data() || {};

        inventory.push({
          id: doc.id,
          product_name: product.name || 'Unknown',
          category: product.category || '',
          farm_name: farm.name || 'Unknown',
          farm_id: farmId,
          remaining: inv.remaining,
          unit: product.unit || '',
          price: inv.price,
          status: inv.status,
          harvest_date: inv.harvest_date,
          image_url: inv.image_url,
        });
      }
    }

    return { inventory };
  });

  // GET /api/markets/:id/messages
  app.get<{ Params: { id: string } }>('/:id/messages', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const marketId = request.params.id;

    const ordersSnap = await app.db
      .collection('orders')
      .where('market_id', '==', marketId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();

    const messages: any[] = [];

    for (const doc of ordersSnap.docs) {
      const order = doc.data();
      const farmDoc = await app.db.collection('farms').doc(order.farm_id).get();
      const farmName = farmDoc.data()?.name || 'Unknown';
      const amount = `$${Number(order.total).toFixed(2)}`;

      let title = '';
      let description = '';
      switch (order.status) {
        case 'pending':
          title = `Order placed with ${farmName}`;
          description = `${order.order_number} for ${amount} — awaiting confirmation`;
          break;
        case 'confirmed':
          title = `${farmName} confirmed ${order.order_number}`;
          description = `Order for ${amount} confirmed by farm`;
          break;
        case 'cancelled':
          title = `Order cancelled — ${order.order_number}`;
          description = `${farmName} order for ${amount} was cancelled`;
          break;
        case 'in_transit':
          title = `${farmName} shipped ${order.order_number}`;
          description = `Order for ${amount} is on the way`;
          break;
        case 'delivered':
          title = `Order delivered — ${order.order_number}`;
          description = `${farmName} order for ${amount} delivered`;
          break;
        default:
          title = `Order update — ${order.order_number}`;
          description = `${farmName} order for ${amount} — ${order.status}`;
      }

      messages.push({
        id: doc.id,
        type: 'order',
        title,
        description,
        from: farmName,
        status: order.status,
        amount: order.total,
        order_number: order.order_number,
        timestamp: order.updated_at || order.created_at,
      });
    }

    const notifsSnap = await app.db
      .collection('notifications')
      .where('market_id', '==', marketId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();

    for (const doc of notifsSnap.docs) {
      const notif = doc.data();
      let farmName = 'Unknown';
      let productName = '';

      if (notif.inventory_id) {
        const invDoc = await app.db.collection('inventory').doc(notif.inventory_id).get();
        if (invDoc.exists) {
          const inv = invDoc.data()!;
          const farmDoc = await app.db.collection('farms').doc(inv.farm_id).get();
          farmName = farmDoc.data()?.name || 'Unknown';
          const prodDoc = await app.db.collection('products').doc(inv.product_id).get();
          productName = prodDoc.data()?.name || '';
        }
      }

      messages.push({
        id: doc.id,
        type: 'notification',
        title: `New inventory from ${farmName}`,
        description: `New listing: ${productName || 'item'} from ${farmName}`,
        from: farmName,
        status: notif.status,
        notification_type: notif.type,
        product_name: productName,
        timestamp: notif.sent_at || notif.created_at,
      });
    }

    messages.sort((a, b) => {
      const aTime = a.timestamp?.toDate?.() || new Date(a.timestamp);
      const bTime = b.timestamp?.toDate?.() || new Date(b.timestamp);
      return bTime.getTime() - aTime.getTime();
    });

    return { messages: messages.slice(0, 50) };
  });

  // GET /api/markets/:id/farms
  app.get<{ Params: { id: string } }>('/:id/farms', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const marketId = request.params.id;

    const relsSnap = await app.db
      .collection('farm_market_rels')
      .where('market_id', '==', marketId)
      .orderBy('priority')
      .get();

    const farms = await Promise.all(
      relsSnap.docs.map(async (relDoc) => {
        const rel = relDoc.data();
        const farmDoc = await app.db.collection('farms').doc(rel.farm_id).get();
        const farm = farmDoc.data() || {};

        const invSnap = await app.db
          .collection('inventory')
          .where('farm_id', '==', rel.farm_id)
          .where('status', 'in', ['available', 'partial'])
          .get();
        const availableItems = invSnap.docs.filter((d) => d.data().remaining > 0).length;

        const ordersSnap = await app.db
          .collection('orders')
          .where('farm_id', '==', rel.farm_id)
          .where('market_id', '==', marketId)
          .get();

        let pendingCount = 0, pendingTotal = 0;
        let historyCount = 0, historyTotal = 0;
        const recentOrders: any[] = [];

        for (const oDoc of ordersSnap.docs) {
          const o = oDoc.data();
          if (o.status === 'pending') { pendingCount++; pendingTotal += Number(o.total || 0); }
          else if (['confirmed', 'delivered', 'in_transit'].includes(o.status)) { historyCount++; historyTotal += Number(o.total || 0); }
          recentOrders.push({ id: oDoc.id, ...o });
        }

        recentOrders.sort((a, b) => {
          const aTime = a.created_at?.toDate?.() || new Date(a.created_at);
          const bTime = b.created_at?.toDate?.() || new Date(b.created_at);
          return bTime.getTime() - aTime.getTime();
        });

        return {
          id: farmDoc.id,
          name: farm.name,
          location: farm.location,
          specialty: farm.specialty,
          rel_id: relDoc.id,
          priority: rel.priority,
          notification_delay_min: rel.notification_delay_min,
          active: rel.active,
          available_items: availableItems,
          pending_orders: pendingCount,
          pending_total: pendingTotal,
          history_orders: historyCount,
          history_total: historyTotal,
          recent_orders: recentOrders.slice(0, 5).map((o) => ({
            id: o.id,
            order_number: o.order_number,
            status: o.status,
            total: o.total,
            order_date: o.order_date,
            created_at: o.created_at,
          })),
        };
      }),
    );

    return { farms };
  });

  // GET /api/markets/:id/orders
  app.get<{ Params: { id: string } }>('/:id/orders', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const snapshot = await app.db
      .collection('orders')
      .where('market_id', '==', request.params.id)
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();

    const orders = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const order = doc.data();
        const farmDoc = await app.db.collection('farms').doc(order.farm_id).get();
        return {
          id: doc.id,
          order_number: order.order_number,
          status: order.status,
          total: order.total,
          order_date: order.order_date,
          farm_name: farmDoc.data()?.name || 'Unknown',
        };
      }),
    );

    return { orders };
  });
}
