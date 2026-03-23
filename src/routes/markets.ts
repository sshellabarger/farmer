import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireMarketOwner } from '../middleware/rbac.js';

export async function marketRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const marketOwner = requireMarketOwner(app);
  const marketOrAdmin = requireRole('market', 'admin');

  // GET /api/markets — list all markets (public)
  app.get('/', async (request) => {
    const markets = await app.db
      .selectFrom('markets')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return { markets };
  });

  // GET /api/markets/:id (public)
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const market = await app.db
      .selectFrom('markets')
      .selectAll()
      .where('id', '=', request.params.id)
      .executeTakeFirst();

    if (!market) return reply.notFound('Market not found');
    return market;
  });

  // PUT /api/markets/:id — market must own it (or admin)
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request, reply) => {
    const { name, location, type, delivery_pref } = request.body as any;
    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (type) updates.type = type;
    if (delivery_pref) updates.delivery_pref = delivery_pref;

    const [updated] = await app.db
      .updateTable('markets')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Market not found');
    return updated;
  });

  // GET /api/markets/:id/available — market must own it (or admin)
  app.get<{ Params: { id: string } }>('/:id/available', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const inventory = await app.db
      .selectFrom('inventory')
      .innerJoin('products', 'products.id', 'inventory.product_id')
      .innerJoin('farms', 'farms.id', 'inventory.farm_id')
      .innerJoin('farm_market_rels', (join) =>
        join
          .onRef('farm_market_rels.farm_id', '=', 'farms.id')
          .on('farm_market_rels.market_id', '=', request.params.id)
      )
      .select([
        'inventory.id',
        'products.name as product_name',
        'products.category',
        'farms.name as farm_name',
        'farms.id as farm_id',
        'inventory.remaining',
        'products.unit',
        'inventory.price',
        'inventory.status',
        'inventory.harvest_date',
        'inventory.image_url',
      ])
      .where('inventory.status', 'in', ['available', 'partial'])
      .where('inventory.remaining', '>', 0)
      .where('farm_market_rels.active', '=', true)
      .orderBy('products.category')
      .orderBy('inventory.harvest_date', 'desc')
      .execute();

    return { inventory };
  });

  // GET /api/markets/:id/messages — market must own it (or admin)
  app.get<{ Params: { id: string } }>('/:id/messages', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const marketId = request.params.id;

    // Get recent orders with farm names
    const recentOrders = await app.db
      .selectFrom('orders')
      .innerJoin('farms', 'farms.id', 'orders.farm_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'orders.created_at',
        'orders.updated_at',
        'farms.name as farm_name',
      ])
      .where('orders.market_id', '=', marketId)
      .orderBy('orders.updated_at', 'desc')
      .limit(50)
      .execute();

    // Get notifications for this market
    const notifications = await app.db
      .selectFrom('notifications')
      .leftJoin('inventory', 'inventory.id', 'notifications.inventory_id')
      .leftJoin('products', 'products.id', 'inventory.product_id')
      .leftJoin('farms', 'farms.id', 'inventory.farm_id')
      .select([
        'notifications.id',
        'notifications.type',
        'notifications.status',
        'notifications.created_at',
        'notifications.sent_at',
        'farms.name as farm_name',
        'products.name as product_name',
      ])
      .where('notifications.market_id', '=', marketId)
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
          title = `Order placed with ${order.farm_name}`;
          description = `${order.order_number} for ${amount} — awaiting confirmation`;
          break;
        case 'confirmed':
          title = `${order.farm_name} confirmed ${order.order_number}`;
          description = `Order for ${amount} confirmed by farm`;
          break;
        case 'cancelled':
          title = `Order cancelled — ${order.order_number}`;
          description = `${order.farm_name} order for ${amount} was cancelled`;
          break;
        case 'in_transit':
          title = `${order.farm_name} shipped ${order.order_number}`;
          description = `Order for ${amount} is on the way`;
          break;
        case 'delivered':
          title = `Order delivered — ${order.order_number}`;
          description = `${order.farm_name} order for ${amount} delivered`;
          break;
        default:
          title = `Order update — ${order.order_number}`;
          description = `${order.farm_name} order for ${amount} — ${order.status}`;
      }

      messages.push({
        id: order.id,
        type: 'order',
        title,
        description,
        from: order.farm_name,
        status: order.status,
        amount: order.total,
        order_number: order.order_number,
        timestamp: order.updated_at || order.created_at,
      });
    }

    for (const notif of notifications) {
      const desc =
        notif.type === 'new_inventory'
          ? `New listing: ${notif.product_name || 'item'} from ${notif.farm_name || 'farm'}`
          : notif.type === 'price_change'
          ? `Price changed: ${notif.product_name || 'item'} from ${notif.farm_name || 'farm'}`
          : notif.type === 'order_update'
          ? 'Order update'
          : 'Reminder';

      messages.push({
        id: notif.id,
        type: 'notification',
        title: notif.type === 'new_inventory'
          ? `New inventory from ${notif.farm_name || 'farm'}`
          : notif.type === 'price_change'
          ? `Price update from ${notif.farm_name || 'farm'}`
          : `Notification from ${notif.farm_name || 'farm'}`,
        description: desc,
        from: notif.farm_name || 'Unknown',
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

  // GET /api/markets/:id/farms — market must own it (or admin)
  app.get<{ Params: { id: string } }>('/:id/farms', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const marketId = request.params.id;

    const farms = await app.db
      .selectFrom('farm_market_rels')
      .innerJoin('farms', 'farms.id', 'farm_market_rels.farm_id')
      .select([
        'farms.id',
        'farms.name',
        'farms.location',
        'farms.specialty',
        'farm_market_rels.id as rel_id',
        'farm_market_rels.priority',
        'farm_market_rels.notification_delay_min',
        'farm_market_rels.active',
      ])
      .where('farm_market_rels.market_id', '=', marketId)
      .orderBy('farm_market_rels.priority', 'asc')
      .execute();

    // Enrich each farm with available items, pending orders, and order history
    const enriched = await Promise.all(
      farms.map(async (farm) => {
        // Available items count
        const availResult = await app.db
          .selectFrom('inventory')
          .select((eb) => eb.fn.countAll().as('count'))
          .where('farm_id', '=', farm.id)
          .where('status', 'in', ['available', 'partial'])
          .where('remaining', '>', 0)
          .executeTakeFirst();

        // Pending orders from this market to this farm
        const pendingResult = await app.db
          .selectFrom('orders')
          .select((eb) => [eb.fn.countAll().as('count'), eb.fn.sum('total').as('total')])
          .where('farm_id', '=', farm.id)
          .where('market_id', '=', marketId)
          .where('status', '=', 'pending')
          .executeTakeFirst();

        // Order history (completed/confirmed)
        const historyResult = await app.db
          .selectFrom('orders')
          .select((eb) => [eb.fn.countAll().as('count'), eb.fn.sum('total').as('total')])
          .where('farm_id', '=', farm.id)
          .where('market_id', '=', marketId)
          .where('status', 'in', ['confirmed', 'delivered', 'in_transit'])
          .executeTakeFirst();

        // Recent orders for timeline
        const recentOrders = await app.db
          .selectFrom('orders')
          .select(['id', 'order_number', 'status', 'total', 'order_date', 'created_at'])
          .where('farm_id', '=', farm.id)
          .where('market_id', '=', marketId)
          .orderBy('created_at', 'desc')
          .limit(5)
          .execute();

        return {
          ...farm,
          available_items: Number(availResult?.count || 0),
          pending_orders: Number(pendingResult?.count || 0),
          pending_total: Number(pendingResult?.total || 0),
          history_orders: Number(historyResult?.count || 0),
          history_total: Number(historyResult?.total || 0),
          recent_orders: recentOrders,
        };
      }),
    );

    return { farms: enriched };
  });

  // GET /api/markets/:id/orders — market must own it (or admin)
  app.get<{ Params: { id: string } }>('/:id/orders', {
    preHandler: [auth, marketOrAdmin, marketOwner],
  }, async (request) => {
    const orders = await app.db
      .selectFrom('orders')
      .innerJoin('farms', 'farms.id', 'orders.farm_id')
      .select([
        'orders.id',
        'orders.order_number',
        'orders.status',
        'orders.total',
        'orders.order_date',
        'farms.name as farm_name',
      ])
      .where('orders.market_id', '=', request.params.id)
      .orderBy('orders.created_at', 'desc')
      .limit(50)
      .execute();

    return { orders };
  });
}
