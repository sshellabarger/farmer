import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireFarmOwner } from '../middleware/rbac.js';

export async function farmRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const farmOwner = requireFarmOwner(app);
  const farmerOrAdmin = requireRole('farmer', 'admin');

  // GET /api/farms — list all farms (public, no auth required)
  app.get('/', async (request) => {
    const farms = await app.db
      .selectFrom('farms')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return { farms };
  });

  // GET /api/farms/:id (public)
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const farm = await app.db
      .selectFrom('farms')
      .selectAll()
      .where('id', '=', request.params.id)
      .executeTakeFirst();

    if (!farm) return reply.notFound('Farm not found');
    return farm;
  });

  // PUT /api/farms/:id — farmer must own the farm (or be admin)
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request, reply) => {
    const { name, location, specialty, timezone } = request.body as any;
    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (specialty) updates.specialty = specialty;
    if (timezone) updates.timezone = timezone;

    const [updated] = await app.db
      .updateTable('farms')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Farm not found');
    return updated;
  });

  // GET /api/farms/:id/inventory — farmer must own the farm (or admin)
  app.get<{ Params: { id: string } }>('/:id/inventory', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const inventory = await app.db
      .selectFrom('inventory')
      .innerJoin('products', 'products.id', 'inventory.product_id')
      .select([
        'inventory.id',
        'products.name as product_name',
        'products.category',
        'inventory.quantity',
        'inventory.remaining',
        'products.unit',
        'inventory.price',
        'inventory.status',
        'inventory.harvest_date',
        'inventory.listed_at',
        'inventory.image_url',
      ])
      .where('inventory.farm_id', '=', request.params.id)
      .orderBy('inventory.listed_at', 'desc')
      .execute();

    return { inventory };
  });

  // GET /api/farms/:id/orders — farmer must own the farm (or admin)
  app.get<{ Params: { id: string } }>('/:id/orders', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const orders = await app.db
      .selectFrom('orders')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'markets.name as market_name',
      ])
      .where('orders.farm_id', '=', request.params.id)
      .orderBy('orders.created_at', 'desc')
      .limit(50)
      .execute();

    return { orders };
  });

  // GET /api/farms/:id/analytics — farmer must own the farm (or admin)
  app.get<{ Params: { id: string } }>('/:id/analytics', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    const totalRevenue = await app.db
      .selectFrom('orders')
      .select((eb) => eb.fn.sum('total').as('revenue'))
      .where('farm_id', '=', farmId)
      .where('status', 'in', ['confirmed', 'delivered'])
      .executeTakeFirst();

    const orderCount = await app.db
      .selectFrom('orders')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('farm_id', '=', farmId)
      .executeTakeFirst();

    const activeListings = await app.db
      .selectFrom('inventory')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('farm_id', '=', farmId)
      .where('status', 'in', ['available', 'partial'])
      .executeTakeFirst();

    return {
      revenue: totalRevenue?.revenue || 0,
      total_orders: orderCount?.count || 0,
      active_listings: activeListings?.count || 0,
    };
  });

  // GET /api/farms/:id/messages — farmer must own the farm (or admin)
  app.get<{ Params: { id: string } }>('/:id/messages', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    // Get recent orders with market names
    const recentOrders = await app.db
      .selectFrom('orders')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'orders.created_at',
        'orders.updated_at',
        'markets.name as market_name',
      ])
      .where('orders.farm_id', '=', farmId)
      .orderBy('orders.updated_at', 'desc')
      .limit(50)
      .execute();

    // Get notifications related to this farm's inventory
    const notifications = await app.db
      .selectFrom('notifications')
      .innerJoin('markets', 'markets.id', 'notifications.market_id')
      .leftJoin('inventory', 'inventory.id', 'notifications.inventory_id')
      .leftJoin('products', 'products.id', 'inventory.product_id')
      .select([
        'notifications.id',
        'notifications.type',
        'notifications.status',
        'notifications.created_at',
        'notifications.sent_at',
        'markets.name as market_name',
        'products.name as product_name',
      ])
      .where('inventory.farm_id', '=', farmId)
      .orderBy('notifications.created_at', 'desc')
      .limit(50)
      .execute();

    // Combine into a unified activity feed
    const messages: any[] = [];

    for (const order of recentOrders) {
      let title = '';
      let description = '';
      const amount = `$${Number(order.total).toFixed(2)}`;

      switch (order.status) {
        case 'pending':
          title = `New order from ${order.market_name}`;
          description = `${order.order_number} for ${amount} — awaiting confirmation`;
          break;
        case 'confirmed':
          title = `Order confirmed — ${order.order_number}`;
          description = `${order.market_name} order for ${amount} confirmed`;
          break;
        case 'cancelled':
          title = `Order cancelled — ${order.order_number}`;
          description = `${order.market_name} order for ${amount} was cancelled`;
          break;
        case 'in_transit':
          title = `Order in transit — ${order.order_number}`;
          description = `${order.market_name} order for ${amount} is on the way`;
          break;
        case 'delivered':
          title = `Order delivered — ${order.order_number}`;
          description = `${order.market_name} order for ${amount} delivered`;
          break;
        default:
          title = `Order update — ${order.order_number}`;
          description = `${order.market_name} order for ${amount} — ${order.status}`;
      }

      messages.push({
        id: order.id,
        type: 'order',
        title,
        description,
        from: order.market_name,
        status: order.status,
        amount: order.total,
        order_number: order.order_number,
        timestamp: order.updated_at || order.created_at,
      });
    }

    for (const notif of notifications) {
      const desc =
        notif.type === 'new_inventory'
          ? `New listing notification for ${notif.product_name || 'item'}`
          : notif.type === 'price_change'
          ? `Price change notification for ${notif.product_name || 'item'}`
          : notif.type === 'order_update'
          ? 'Order update notification'
          : 'Reminder';

      messages.push({
        id: notif.id,
        type: 'notification',
        title: `Notification sent to ${notif.market_name}`,
        description: desc,
        from: notif.market_name,
        status: notif.status,
        notification_type: notif.type,
        product_name: notif.product_name,
        timestamp: notif.sent_at || notif.created_at,
      });
    }

    // Sort by timestamp descending
    messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { messages: messages.slice(0, 50) };
  });

  // GET /api/farms/:id/markets — farmer must own the farm (or admin)
  app.get<{ Params: { id: string } }>('/:id/markets', {
    preHandler: [auth, farmerOrAdmin, farmOwner],
  }, async (request) => {
    const farmId = request.params.id;

    const markets = await app.db
      .selectFrom('farm_market_rels')
      .innerJoin('markets', 'markets.id', 'farm_market_rels.market_id')
      .select([
        'markets.id',
        'markets.name',
        'markets.type',
        'markets.location',
        'farm_market_rels.id as rel_id',
        'farm_market_rels.priority',
        'farm_market_rels.notification_delay_min',
        'farm_market_rels.active',
      ])
      .where('farm_market_rels.farm_id', '=', farmId)
      .orderBy('farm_market_rels.priority', 'asc')
      .execute();

    // Enrich with order stats
    const enriched = await Promise.all(
      markets.map(async (market) => {
        const pendingResult = await app.db
          .selectFrom('orders')
          .select((eb) => [eb.fn.countAll().as('count'), eb.fn.sum('total').as('total')])
          .where('farm_id', '=', farmId)
          .where('market_id', '=', market.id)
          .where('status', '=', 'pending')
          .executeTakeFirst();

        const historyResult = await app.db
          .selectFrom('orders')
          .select((eb) => [eb.fn.countAll().as('count'), eb.fn.sum('total').as('total')])
          .where('farm_id', '=', farmId)
          .where('market_id', '=', market.id)
          .where('status', 'in', ['confirmed', 'delivered', 'in_transit'])
          .executeTakeFirst();

        return {
          ...market,
          pending_orders: Number(pendingResult?.count || 0),
          pending_total: Number(pendingResult?.total || 0),
          history_orders: Number(historyResult?.count || 0),
          history_total: Number(historyResult?.total || 0),
        };
      }),
    );

    return { markets: enriched };
  });
}
