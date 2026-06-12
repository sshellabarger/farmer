import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireFarmOwner } from '../middleware/rbac.js';
import { byDateDesc, byNumberAsc } from '../utils/sort.js';
import { classifyFreshness } from '../utils/freshness.js';
import { MARKET_TYPES } from '../types/schema.js';
import { v4 as uuid } from 'uuid';

export async function farmRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const farmOwner = requireFarmOwner(app);
  const farmerOrAdmin = requireRole('farmer', 'admin');

  // GET /api/farms — list all farms (public)
  app.get('/', async () => {
    const snapshot = await app.db.collection('farms').orderBy('name').get();
    const farms = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { farms };
  });

  // GET /api/farms/:id (public)
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const doc = await app.db.collection('farms').doc(request.params.id).get();
    if (!doc.exists) return reply.notFound('Farm not found');
    return { id: doc.id, ...doc.data() };
  });

  // PUT /api/farms/:id
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request, reply) => {
    const { name, location, specialty, timezone } = request.body as any;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (specialty) updates.specialty = specialty;
    if (timezone) updates.timezone = timezone;

    const ref = app.db.collection('farms').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Farm not found');

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // GET /api/farms/:id/inventory
  app.get<{ Params: { id: string } }>('/:id/inventory', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const invSnapshot = await app.db
      .collection('inventory')
      .where('farm_id', '==', request.params.id)
      .get();

    const inventory = await Promise.all(
      invSnapshot.docs.map(async (doc) => {
        const inv = doc.data();
        const productDoc = await app.db.collection('products').doc(inv.product_id).get();
        const product = productDoc.data();
        const freshness = classifyFreshness(inv.harvest_date, product?.category, product?.name);
        return {
          id: doc.id,
          product_name: product?.name || 'Unknown',
          category: product?.category || '',
          quantity: inv.quantity,
          remaining: inv.remaining,
          unit: product?.unit || '',
          price: inv.price,
          status: inv.status,
          harvest_date: inv.harvest_date,
          listed_at: inv.listed_at,
          image_url: inv.image_url,
          ...(freshness || {}),
        };
      }),
    );

    return { inventory: byDateDesc(inventory, 'listed_at') };
  });

  // GET /api/farms/:id/orders
  app.get<{ Params: { id: string } }>('/:id/orders', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const orderSnapshot = await app.db
      .collection('orders')
      .where('farm_id', '==', request.params.id)
      .get();

    const orders = await Promise.all(
      orderSnapshot.docs.map(async (doc) => {
        const order = doc.data();
        const marketDoc = await app.db.collection('markets').doc(order.market_id).get();
        return {
          id: doc.id,
          order_number: order.order_number,
          status: order.status,
          total: order.total,
          order_date: order.order_date,
          market_name: marketDoc.data()?.name || 'Unknown',
        };
      }),
    );

    return { orders: byDateDesc(orders, 'order_date').slice(0, 50) };
  });

  // GET /api/farms/:id/analytics
  app.get<{ Params: { id: string } }>('/:id/analytics', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    const ordersSnap = await app.db
      .collection('orders')
      .where('farm_id', '==', farmId)
      .get();

    let revenue = 0;
    let totalOrders = 0;
    for (const doc of ordersSnap.docs) {
      const order = doc.data();
      totalOrders++;
      if (['confirmed', 'delivered'].includes(order.status)) {
        revenue += Number(order.total || 0);
      }
    }

    const invSnap = await app.db
      .collection('inventory')
      .where('farm_id', '==', farmId)
      .get();
    const activeListings = invSnap.docs.filter((d) => ['available', 'partial'].includes(d.data().status)).length;

    return {
      revenue,
      total_orders: totalOrders,
      active_listings: activeListings,
    };
  });

  // GET /api/farms/:id/messages
  app.get<{ Params: { id: string } }>('/:id/messages', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    const ordersSnap = await app.db
      .collection('orders')
      .where('farm_id', '==', farmId)
      .get();
    const orderDocs = byDateDesc(ordersSnap.docs.map((d) => ({ doc: d, order_date: d.data().order_date })), 'order_date').slice(0, 50).map((x) => x.doc);

    const messages: any[] = [];

    for (const doc of orderDocs) {
      const order = doc.data();
      const marketDoc = await app.db.collection('markets').doc(order.market_id).get();
      const marketName = marketDoc.data()?.name || 'Unknown';
      const amount = `$${Number(order.total).toFixed(2)}`;

      let title = '';
      let description = '';
      switch (order.status) {
        case 'pending':
          title = `New order from ${marketName}`;
          description = `${order.order_number} for ${amount} — awaiting confirmation`;
          break;
        case 'confirmed':
          title = `Order confirmed — ${order.order_number}`;
          description = `${marketName} order for ${amount} confirmed`;
          break;
        case 'cancelled':
          title = `Order cancelled — ${order.order_number}`;
          description = `${marketName} order for ${amount} was cancelled`;
          break;
        case 'in_transit':
          title = `Order in transit — ${order.order_number}`;
          description = `${marketName} order for ${amount} is on the way`;
          break;
        case 'delivered':
          title = `Order delivered — ${order.order_number}`;
          description = `${marketName} order for ${amount} delivered`;
          break;
        default:
          title = `Order update — ${order.order_number}`;
          description = `${marketName} order for ${amount} — ${order.status}`;
      }

      messages.push({
        id: doc.id,
        type: 'order',
        title,
        description,
        from: marketName,
        status: order.status,
        amount: order.total,
        order_number: order.order_number,
        timestamp: order.updated_at || order.created_at,
      });
    }

    const notifsSnap = await app.db
      .collection('notifications')
      .where('farm_id', '==', farmId)
      .get();
    const notifDocs = byDateDesc(notifsSnap.docs.map((d) => ({ doc: d, created_at: d.data().created_at })), 'created_at').slice(0, 50).map((x) => x.doc);

    for (const doc of notifDocs) {
      const notif = doc.data();
      const marketDoc = await app.db.collection('markets').doc(notif.market_id).get();
      const marketName = marketDoc.data()?.name || 'Unknown';

      let productName = '';
      if (notif.inventory_id) {
        const invDoc = await app.db.collection('inventory').doc(notif.inventory_id).get();
        if (invDoc.exists) {
          const inv = invDoc.data()!;
          const prodDoc = await app.db.collection('products').doc(inv.product_id).get();
          productName = prodDoc.data()?.name || '';
        }
      }

      const desc =
        notif.type === 'new_inventory'
          ? `New listing notification for ${productName || 'item'}`
          : notif.type === 'price_change'
          ? `Price change notification for ${productName || 'item'}`
          : notif.type === 'order_update'
          ? 'Order update notification'
          : 'Reminder';

      messages.push({
        id: doc.id,
        type: 'notification',
        title: `Notification sent to ${marketName}`,
        description: desc,
        from: marketName,
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

  // GET /api/farms/:id/markets
  app.get<{ Params: { id: string } }>('/:id/markets', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    const relsSnap = await app.db
      .collection('farm_market_rels')
      .where('farm_id', '==', farmId)
      .get();
    const relDocs = byNumberAsc(relsSnap.docs.map((d) => ({ doc: d, priority: d.data().priority })), 'priority', 99).map((x) => x.doc);

    // Fetch all orders for this farm once, then group by market in memory.
    const allOrdersSnap = await app.db.collection('orders').where('farm_id', '==', farmId).get();

    const markets = await Promise.all(
      relDocs.map(async (relDoc) => {
        const rel = relDoc.data();
        const marketDoc = await app.db.collection('markets').doc(rel.market_id).get();
        const market = marketDoc.data() || {};

        let pendingCount = 0, pendingTotal = 0;
        let historyCount = 0, historyTotal = 0;
        for (const oDoc of allOrdersSnap.docs) {
          const o = oDoc.data();
          if (o.market_id !== rel.market_id) continue;
          if (o.status === 'pending') {
            pendingCount++;
            pendingTotal += Number(o.total || 0);
          } else if (['confirmed', 'delivered', 'in_transit'].includes(o.status)) {
            historyCount++;
            historyTotal += Number(o.total || 0);
          }
        }

        return {
          id: marketDoc.id,
          name: market.name,
          type: market.type,
          location: market.location,
          rel_id: relDoc.id,
          priority: rel.priority,
          notification_delay_min: rel.notification_delay_min,
          active: rel.active,
          pending_orders: pendingCount,
          pending_total: pendingTotal,
          history_orders: historyCount,
          history_total: historyTotal,
        };
      }),
    );

    return { markets };
  });

  // POST /api/farms/:id/markets
  app.post<{ Params: { id: string } }>('/:id/markets', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request, reply) => {
    const farmId = request.params.id;
    const schema = z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      location: z.string().optional(),
      type: z.enum(MARKET_TYPES).optional().default('grocery'),
      priority: z.number().int().positive().optional().default(99),
      notification_delay_min: z.number().int().min(0).optional().default(0),
    });

    const data = schema.parse(request.body);

    let marketId: string | undefined;
    if (data.phone) {
      const existing = await app.db
        .collection('markets')
        .where('phone', '==', data.phone)
        .limit(1)
        .get();
      if (!existing.empty) marketId = existing.docs[0].id;
    }

    if (!marketId) {
      const userId = uuid();
      await app.db.collection('users').doc(userId).set({
        name: data.name,
        phone: data.phone || `market-${Date.now()}`,
        role: 'market',
        created_at: new Date(),
        updated_at: new Date(),
      });

      marketId = uuid();
      await app.db.collection('markets').doc(marketId).set({
        user_id: userId,
        name: data.name,
        phone: data.phone ?? null,
        location: data.location || 'Unknown',
        type: data.type,
        delivery_pref: 'either',
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    const relsForFarm = await app.db
      .collection('farm_market_rels')
      .where('farm_id', '==', farmId)
      .get();
    const existingRel = relsForFarm.docs.find((d) => d.data().market_id === marketId);

    if (existingRel) {
      return reply.status(409).send({
        error: 'This market is already linked to your farm',
        rel_id: existingRel.id,
      });
    }

    const relId = uuid();
    await app.db.collection('farm_market_rels').doc(relId).set({
      farm_id: farmId,
      market_id: marketId,
      priority: data.priority,
      notification_delay_min: data.notification_delay_min,
      active: true,
      status: 'active',
      created_at: new Date(),
    });

    reply.status(201).send({ market_id: marketId, rel_id: relId, name: data.name });
  });

  // PUT /api/farms/:id/markets/:relId
  app.put<{ Params: { id: string; relId: string } }>('/:id/markets/:relId', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request, reply) => {
    const { relId } = request.params;
    const { priority, notification_delay_min, active } = request.body as Record<string, unknown>;

    const ref = app.db.collection('farm_market_rels').doc(relId);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Relationship not found');

    const updates: Record<string, unknown> = {};
    if (priority !== undefined) updates.priority = priority;
    if (notification_delay_min !== undefined) updates.notification_delay_min = notification_delay_min;
    if (active !== undefined) updates.active = active;

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });
}
