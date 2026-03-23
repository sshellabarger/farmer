import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function recurringOrderRoutes(app: FastifyInstance) {
  // GET /api/recurring-orders?farm_id=&market_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    let query = app.db
      .selectFrom('recurring_orders')
      .innerJoin('farms', 'farms.id', 'recurring_orders.farm_id')
      .innerJoin('markets', 'markets.id', 'recurring_orders.market_id')
      .select([
        'recurring_orders.id',
        'recurring_orders.farm_id',
        'recurring_orders.market_id',
        'farms.name as farm_name',
        'markets.name as market_name',
        'recurring_orders.frequency',
        'recurring_orders.schedule_days',
        'recurring_orders.next_delivery',
        'recurring_orders.active',
        'recurring_orders.created_at',
      ]);

    const { farm_id, market_id } = request.query;
    if (farm_id) query = query.where('recurring_orders.farm_id', '=', farm_id);
    if (market_id) query = query.where('recurring_orders.market_id', '=', market_id);

    const orders = await query.orderBy('recurring_orders.next_delivery', 'asc').execute();

    // Load items for each recurring order
    const result = await Promise.all(
      orders.map(async (ro) => {
        const items = await app.db
          .selectFrom('recurring_order_items')
          .innerJoin('products', 'products.id', 'recurring_order_items.product_id')
          .select([
            'recurring_order_items.id',
            'recurring_order_items.product_id',
            'products.name as product_name',
            'recurring_order_items.quantity',
            'recurring_order_items.unit',
          ])
          .where('recurring_order_items.recurring_order_id', '=', ro.id)
          .execute();

        return { ...ro, items };
      })
    );

    return { recurring_orders: result };
  });

  // POST /api/recurring-orders
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string().uuid(),
      market_id: z.string().uuid(),
      frequency: z.enum(['daily', 'twice_weekly', 'weekly', 'biweekly', 'monthly']),
      schedule_days: z.string().min(1),
      next_delivery: z.string(), // YYYY-MM-DD
      items: z.array(
        z.object({
          product_id: z.string().uuid(),
          quantity: z.number().positive(),
          unit: z.string().min(1),
        })
      ),
    });

    const data = schema.parse(request.body);

    const [ro] = await app.db
      .insertInto('recurring_orders')
      .values({
        farm_id: data.farm_id,
        market_id: data.market_id,
        frequency: data.frequency,
        schedule_days: data.schedule_days,
        next_delivery: new Date(data.next_delivery),
      })
      .returningAll()
      .execute();

    // Insert items
    for (const item of data.items) {
      await app.db
        .insertInto('recurring_order_items')
        .values({
          recurring_order_id: ro.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit: item.unit,
        })
        .execute();
    }

    reply.status(201).send(ro);
  });

  // PUT /api/recurring-orders/:id
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { frequency, schedule_days, next_delivery, active, items } = request.body as Record<string, any>;

    const updates: Record<string, unknown> = {};
    if (frequency !== undefined) updates.frequency = frequency;
    if (schedule_days !== undefined) updates.schedule_days = schedule_days;
    if (next_delivery !== undefined) updates.next_delivery = new Date(next_delivery);
    if (active !== undefined) updates.active = active;

    if (Object.keys(updates).length > 0) {
      const [updated] = await app.db
        .updateTable('recurring_orders')
        .set(updates)
        .where('id', '=', request.params.id)
        .returningAll()
        .execute();

      if (!updated) return reply.notFound('Recurring order not found');
    }

    // Replace items if provided
    if (items && Array.isArray(items)) {
      await app.db
        .deleteFrom('recurring_order_items')
        .where('recurring_order_id', '=', request.params.id)
        .execute();

      for (const item of items) {
        await app.db
          .insertInto('recurring_order_items')
          .values({
            recurring_order_id: request.params.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit: item.unit,
          })
          .execute();
      }
    }

    return { success: true };
  });

  // DELETE /api/recurring-orders/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    await app.db.deleteFrom('recurring_orders').where('id', '=', request.params.id).execute();
    reply.status(204).send();
  });
}
