import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendOrderStatusNotification, calculateNextDeliveryDate } from '../services/order-notifications.js';
import { authenticate, requireOrderParty, requireOrderCreateParty } from '../middleware/rbac.js';

export async function orderRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const orderParty = requireOrderParty(app);
  const orderCreateParty = requireOrderCreateParty(app);

  // GET /api/orders?farm_id=&market_id=&status=&date=
  // Authenticated users only see orders they are a party to (unless admin)
  app.get<{ Querystring: Record<string, string> }>('/', {
    preHandler: [auth],
  }, async (request) => {
    const user = request.authUser!;

    let query = app.db
      .selectFrom('orders')
      .innerJoin('farms', 'farms.id', 'orders.farm_id')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'farms.name as farm_name',
        'markets.name as market_name',
        'orders.notes',
        'orders.created_at',
      ]);

    const { farm_id, market_id, status, date } = request.query;
    if (farm_id) query = query.where('orders.farm_id', '=', farm_id);
    if (market_id) query = query.where('orders.market_id', '=', market_id);
    if (status) query = query.where('orders.status', '=', status as any);
    if (date) query = query.where('orders.order_date', '=', date as any);

    // Non-admin users can only see their own orders
    if (user.role !== 'admin') {
      if (user.farmId && user.marketId) {
        // "both" role: see orders for their farm or market
        query = query.where((eb) =>
          eb.or([
            eb('orders.farm_id', '=', user.farmId!),
            eb('orders.market_id', '=', user.marketId!),
          ])
        );
      } else if (user.farmId) {
        query = query.where('orders.farm_id', '=', user.farmId);
      } else if (user.marketId) {
        query = query.where('orders.market_id', '=', user.marketId);
      }
    }

    const results = await query.orderBy('orders.created_at', 'desc').limit(50).execute();
    return { orders: results };
  });

  // POST /api/orders — user must be a party (farm or market) on the order
  app.post('/', {
    preHandler: [auth, orderCreateParty],
  }, async (request, reply) => {
    const schema = z.object({
      farm_id: z.string().uuid(),
      market_id: z.string().uuid(),
      items: z.array(
        z.object({
          inventory_id: z.string().uuid(),
          quantity: z.number().positive(),
        })
      ),
      delivery_type: z.enum(['pickup', 'delivery']).optional(),
      delivery_notes: z.string().optional(),
      notes: z.string().optional(),
    });

    const data = schema.parse(request.body);

    // Calculate total from inventory items
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
      const inv = await app.db
        .selectFrom('inventory')
        .innerJoin('products', 'products.id', 'inventory.product_id')
        .select(['inventory.id', 'products.name', 'products.unit', 'inventory.price', 'inventory.remaining'])
        .where('inventory.id', '=', item.inventory_id)
        .executeTakeFirst();

      if (!inv) return reply.badRequest(`Inventory ${item.inventory_id} not found`);
      if (Number(inv.remaining) < item.quantity) {
        return reply.badRequest(`Only ${inv.remaining} ${inv.unit} of ${inv.name} available`);
      }

      const lineTotal = Number(inv.price) * item.quantity;
      total += lineTotal;
      itemDetails.push({
        inventory_id: inv.id,
        product_name: inv.name,
        quantity: item.quantity,
        unit: inv.unit,
        unit_price: Number(inv.price),
        line_total: lineTotal,
      });
    }

    // Calculate delivery date from farm's delivery schedule if delivery type specified
    let scheduledDeliveryAt: Date | null = null;
    let deliveryTimeWindow: string | null = null;

    if (data.delivery_type) {
      const farm = await app.db
        .selectFrom('farms')
        .select(['delivery_schedule', 'location'])
        .where('id', '=', data.farm_id)
        .executeTakeFirst();

      const market = await app.db
        .selectFrom('markets')
        .select(['location'])
        .where('id', '=', data.market_id)
        .executeTakeFirst();

      if (farm?.delivery_schedule && Array.isArray(farm.delivery_schedule) && farm.delivery_schedule.length > 0) {
        const slot = calculateNextDeliveryDate(
          farm.delivery_schedule as any,
          data.delivery_type,
          market?.location,
        );
        if (slot) {
          scheduledDeliveryAt = slot.date;
          deliveryTimeWindow = slot.timeWindow;
        }
      }
    }

    const [order] = await app.db
      .insertInto('orders')
      .values({
        farm_id: data.farm_id,
        market_id: data.market_id,
        total,
        delivery_type: data.delivery_type ?? null,
        scheduled_delivery_at: scheduledDeliveryAt,
        delivery_notes: data.delivery_notes ?? null,
        notes: data.notes ?? null,
      })
      .returningAll()
      .execute();

    for (const oi of itemDetails) {
      await app.db.insertInto('order_items').values({ order_id: order.id, ...oi }).execute();

      // Decrement inventory remaining and update status
      const inv = await app.db
        .selectFrom('inventory')
        .select(['remaining', 'quantity'])
        .where('id', '=', oi.inventory_id)
        .executeTakeFirst();

      const newRemaining = Number(inv?.remaining ?? 0) - oi.quantity;
      let newStatus: string;
      if (newRemaining <= 0) {
        newStatus = 'sold';
      } else if (newRemaining < Number(inv?.quantity ?? 0)) {
        newStatus = 'partial';
      } else {
        newStatus = 'available';
      }

      await app.db
        .updateTable('inventory')
        .set({
          remaining: Math.max(0, newRemaining),
          status: newStatus as any,
        })
        .where('id', '=', oi.inventory_id)
        .execute();
    }

    // Create delivery record for the order
    await app.db
      .insertInto('deliveries')
      .values({
        order_id: order.id,
        type: (data.delivery_type ?? 'pickup') as any,
        scheduled_at: scheduledDeliveryAt ?? new Date(),
        status: 'scheduled' as any,
        notes: data.delivery_notes ?? null,
      })
      .execute();

    reply.status(201).send(order);
  });

  // GET /api/orders/:id — user must be a party on the order (or admin)
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const order = await app.db
      .selectFrom('orders')
      .innerJoin('farms', 'farms.id', 'orders.farm_id')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'orders.notes',
        'orders.created_at',
        'orders.delivery_type',
        'orders.scheduled_delivery_at',
        'orders.delivery_notes',
        'orders.updated_at',
        'farms.name as farm_name',
        'farms.location as farm_location',
        'markets.name as market_name',
        'markets.location as market_location',
        'markets.delivery_pref',
      ])
      .where('orders.id', '=', request.params.id)
      .executeTakeFirst();

    if (!order) return reply.notFound('Order not found');

    const items = await app.db
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', request.params.id)
      .execute();

    return { ...order, items };
  });

  // PUT /api/orders/:id — user must be a party on the order (or admin)
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const { notes } = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (notes !== undefined) updates.notes = notes;

    const [updated] = await app.db
      .updateTable('orders')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Order not found');
    return updated;
  });

  // PATCH /api/orders/:id/status — user must be a party on the order (or admin)
  app.patch<{ Params: { id: string } }>('/:id/status', {
    preHandler: [auth, orderParty],
  }, async (request, reply) => {
    const schema = z.object({
      status: z.enum(['pending', 'confirmed', 'in_transit', 'delivered', 'cancelled']),
    });

    const { status: newStatus } = schema.parse(request.body);

    const order = await app.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', request.params.id)
      .executeTakeFirst();

    if (!order) return reply.notFound('Order not found');

    // Validate state transition
    const validTransitions: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['in_transit', 'cancelled'],
      in_transit: ['delivered', 'failed'],
      delivered: [],
      cancelled: [],
    };

    const allowed = validTransitions[order.status] || [];
    if (!allowed.includes(newStatus)) {
      return reply.badRequest(`Cannot transition from ${order.status} to ${newStatus}`);
    }

    const [updated] = await app.db
      .updateTable('orders')
      .set({ status: newStatus })
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    // Restore inventory when an order is cancelled
    if (newStatus === 'cancelled') {
      const items = await app.db
        .selectFrom('order_items')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute();

      for (const item of items) {
        const inv = await app.db
          .selectFrom('inventory')
          .select(['remaining', 'quantity'])
          .where('id', '=', item.inventory_id)
          .executeTakeFirst();

        if (inv) {
          const restored = Math.min(Number(inv.quantity), Number(inv.remaining) + Number(item.quantity));
          const restoredStatus = restored >= Number(inv.quantity) ? 'available' : 'partial';
          await app.db
            .updateTable('inventory')
            .set({ remaining: restored, status: restoredStatus as any })
            .where('id', '=', item.inventory_id)
            .execute();
        }
      }
    }

    // Update delivery record based on order status transition
    if (newStatus === 'cancelled') {
      await app.db
        .updateTable('deliveries')
        .set({ status: 'failed' as any })
        .where('order_id', '=', order.id)
        .execute();
    } else if (newStatus === 'in_transit') {
      await app.db
        .updateTable('deliveries')
        .set({ status: 'in_transit' as any })
        .where('order_id', '=', order.id)
        .execute();
    } else if (newStatus === 'delivered') {
      await app.db
        .updateTable('deliveries')
        .set({ status: 'completed' as any, completed_at: new Date() })
        .where('order_id', '=', order.id)
        .execute();
    }

    // Trigger SMS notifications based on state transition
    try {
      await sendOrderStatusNotification({
        db: app.db,
        env: app.env,
        orderId: order.id,
        oldStatus: order.status,
        newStatus,
      });
    } catch (err) {
      app.log.error({ err, orderId: order.id }, 'Failed to send order notification');
    }

    return updated;
  });
}
