import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendOrderStatusNotification, calculateNextDropoff } from '../services/order-notifications.js';
import { DEPOT } from '../config/depot.js';
import { authenticate, requireOrderParty, requireOrderCreateParty } from '../middleware/rbac.js';
import { byDateDesc } from '../utils/sort.js';
import { v4 as uuid } from 'uuid';

export async function orderRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const orderParty = requireOrderParty(app);
  const orderCreateParty = requireOrderCreateParty(app);

  // GET /api/orders?farm_id=&market_id=&status=
  app.get<{ Querystring: Record<string, string> }>('/', {
    preHandler: [auth],
  }, async (request) => {
    const user = request.authUser!;
    const { farm_id, market_id, status } = request.query;

    // Use a single equality filter at the DB layer (to avoid composite indexes),
    // then apply remaining filters + sort in memory.
    let query: FirebaseFirestore.Query = app.db.collection('orders');
    let scopedFarmId: string | undefined;
    let scopedMarketId: string | undefined;

    if (user.role !== 'admin' && user.farmId && !user.marketId) {
      scopedFarmId = user.farmId;
    } else if (user.role !== 'admin' && user.marketId && !user.farmId) {
      scopedMarketId = user.marketId;
    } else if (farm_id) {
      scopedFarmId = farm_id;
    } else if (market_id) {
      scopedMarketId = market_id;
    }

    if (scopedFarmId) query = query.where('farm_id', '==', scopedFarmId);
    else if (scopedMarketId) query = query.where('market_id', '==', scopedMarketId);

    const snapshot = await query.get();
    const filtered = snapshot.docs.filter((d) => {
      const o = d.data();
      if (farm_id && o.farm_id !== farm_id) return false;
      if (market_id && o.market_id !== market_id) return false;
      if (status && o.status !== status) return false;
      return true;
    });
    const orderDocs = byDateDesc(filtered.map((d) => ({ doc: d, created_at: d.data().created_at })), 'created_at').slice(0, 50).map((x) => x.doc);

    const orders = await Promise.all(
      orderDocs.map(async (doc) => {
        const order = doc.data();
        const farmDoc = await app.db.collection('farms').doc(order.farm_id).get();
        const marketDoc = await app.db.collection('markets').doc(order.market_id).get();
        return {
          id: doc.id,
          order_number: order.order_number,
          status: order.status,
          total: order.total,
          order_date: order.order_date,
          farm_name: farmDoc.data()?.name || 'Unknown',
          market_name: marketDoc.data()?.name || 'Unknown',
          notes: order.notes,
          created_at: order.created_at,
        };
      }),
    );

    return { orders };
  });

  // POST /api/orders
  app.post('/', {
    preHandler: [auth, orderCreateParty],
  }, async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      market_id: z.string(),
      items: z.array(
        z.object({
          inventory_id: z.string(),
          quantity: z.number().positive(),
        })
      ),
      notes: z.string().optional(),
    });

    const data = schema.parse(request.body);

    let total = 0;
    const itemDetails: Array<{
      inventory_id: string;
      product_name: string;
      quantity: number;
      unit: string;
      unit_price: number;
      line_total: number;
    }> = [];

    for (const item of data.items) {
      const invDoc = await app.db.collection('inventory').doc(item.inventory_id).get();
      if (!invDoc.exists) return reply.badRequest(`Inventory ${item.inventory_id} not found`);
      const inv = invDoc.data()!;

      const productDoc = await app.db.collection('products').doc(inv.product_id).get();
      const product = productDoc.data() || {};

      if (inv.remaining < item.quantity) {
        return reply.badRequest(`Only ${inv.remaining} ${product.unit} of ${product.name} available`);
      }

      const lineTotal = Number(inv.price) * item.quantity;
      total += lineTotal;
      itemDetails.push({
        inventory_id: invDoc.id,
        product_name: product.name || 'Unknown',
        quantity: item.quantity,
        unit: product.unit || '',
        unit_price: Number(inv.price),
        line_total: lineTotal,
      });
    }

    // Calculate next drop-off date at the depot
    let scheduledDropoff: Date | null = null;
    const farmDoc = await app.db.collection('farms').doc(data.farm_id).get();
    const farm = farmDoc.data();
    if (farm?.delivery_schedule?.length > 0) {
      const slot = calculateNextDropoff(farm!.delivery_schedule);
      if (slot) scheduledDropoff = slot.date;
    }

    const orderId = uuid();
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const order = {
      farm_id: data.farm_id,
      market_id: data.market_id,
      order_number: orderNumber,
      status: 'pending',
      total,
      order_date: new Date(),
      delivery_type: 'depot',
      scheduled_delivery_at: scheduledDropoff,
      notes: data.notes ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await app.db.collection('orders').doc(orderId).set(order);

    // Create order items as subcollection
    for (const oi of itemDetails) {
      await app.db.collection('orders').doc(orderId).collection('order_items').doc(uuid()).set(oi);

      // Decrement inventory
      const invRef = app.db.collection('inventory').doc(oi.inventory_id);
      const invDoc = await invRef.get();
      const inv = invDoc.data()!;
      const newRemaining = inv.remaining - oi.quantity;
      const newStatus = newRemaining <= 0 ? 'sold' : newRemaining < inv.quantity ? 'partial' : 'available';
      await invRef.update({ remaining: Math.max(0, newRemaining), status: newStatus });
    }

    // Create delivery record (depot-based)
    await app.db.collection('deliveries').doc(uuid()).set({
      order_id: orderId,
      type: 'depot',
      scheduled_at: scheduledDropoff ?? new Date(),
      status: 'scheduled',
      depot_address: DEPOT.short,
      notes: data.notes ?? null,
      created_at: new Date(),
    });

    reply.status(201).send({ id: orderId, ...order });
  });

  // GET /api/orders/:id
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const doc = await app.db.collection('orders').doc(request.params.id).get();
    if (!doc.exists) return reply.notFound('Order not found');
    const order = doc.data()!;

    const farmDoc = await app.db.collection('farms').doc(order.farm_id).get();
    const marketDoc = await app.db.collection('markets').doc(order.market_id).get();
    const farm = farmDoc.data() || {};
    const market = marketDoc.data() || {};

    const itemsSnap = await app.db
      .collection('orders').doc(request.params.id).collection('order_items').get();
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return {
      id: doc.id,
      ...order,
      farm_name: farm.name,
      farm_location: farm.location,
      market_name: market.name,
      market_location: market.location,
      delivery_pref: market.delivery_pref,
      items,
    };
  });

  // PUT /api/orders/:id
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const ref = app.db.collection('orders').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Order not found');
    const order = doc.data()!;

    const user = request.authUser!;
    const isAdmin = user.role === 'admin';
    const isFarmParty = !!user.farmId && order.farm_id === user.farmId;
    const isMarketParty = !!user.marketId && order.market_id === user.marketId;

    if (!isAdmin && order.status !== 'pending' && isMarketParty && !isFarmParty) {
      return reply.status(403).send({ error: 'Markets can only modify pending orders.' });
    }

    const { notes } = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (notes !== undefined) updates.notes = notes;

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // PATCH /api/orders/:id/status
  app.patch<{ Params: { id: string } }>('/:id/status', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const schema = z.object({
      status: z.enum(['pending', 'confirmed', 'in_transit', 'delivered', 'cancelled']),
    });
    const { status: newStatus } = schema.parse(request.body);

    const ref = app.db.collection('orders').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Order not found');
    const order = doc.data()!;

    const user = request.authUser!;
    const isAdmin = user.role === 'admin';
    const isFarmParty = !!user.farmId && order.farm_id === user.farmId;
    const isMarketParty = !!user.marketId && order.market_id === user.marketId;

    if (!isAdmin) {
      if (order.status === 'pending') {
        if (isMarketParty && !isFarmParty && newStatus !== 'cancelled') {
          return reply.status(403).send({ error: 'Markets can only cancel pending orders.' });
        }
      } else if (!isFarmParty) {
        return reply.status(403).send({ error: 'Only the farm can update order status after confirmation.' });
      }
    }

    const validTransitions: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['in_transit', 'cancelled'],
      in_transit: ['delivered', 'failed'],
      delivered: [],
      cancelled: [],
    };
    if (!(validTransitions[order.status] || []).includes(newStatus)) {
      return reply.badRequest(`Cannot transition from ${order.status} to ${newStatus}`);
    }

    await ref.update({ status: newStatus, updated_at: new Date() });

    // Restore inventory on cancellation
    if (newStatus === 'cancelled') {
      const itemsSnap = await app.db
        .collection('orders').doc(request.params.id).collection('order_items').get();

      for (const itemDoc of itemsSnap.docs) {
        const item = itemDoc.data();
        const invRef = app.db.collection('inventory').doc(item.inventory_id);
        const invDoc = await invRef.get();
        if (invDoc.exists) {
          const inv = invDoc.data()!;
          const restored = Math.min(inv.quantity, inv.remaining + item.quantity);
          const restoredStatus = restored >= inv.quantity ? 'available' : 'partial';
          await invRef.update({ remaining: restored, status: restoredStatus });
        }
      }
    }

    // Update delivery status
    const delivSnap = await app.db
      .collection('deliveries')
      .where('order_id', '==', request.params.id)
      .limit(1)
      .get();

    if (!delivSnap.empty) {
      const delivRef = delivSnap.docs[0].ref;
      if (newStatus === 'cancelled') await delivRef.update({ status: 'failed' });
      else if (newStatus === 'in_transit') await delivRef.update({ status: 'in_transit' });
      else if (newStatus === 'delivered') await delivRef.update({ status: 'completed', completed_at: new Date() });
    }

    try {
      await sendOrderStatusNotification({
        db: app.db,
        env: app.env,
        orderId: request.params.id,
        oldStatus: order.status,
        newStatus,
      });
    } catch (err) {
      app.log.error({ err, orderId: request.params.id }, 'Failed to send order notification');
    }

    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });
}
