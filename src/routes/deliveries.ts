import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function deliveryRoutes(app: FastifyInstance) {
  // GET /api/deliveries?date=&farm_id=&market_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    let query = app.db
      .selectFrom('deliveries')
      .innerJoin('orders', 'orders.id', 'deliveries.order_id')
      .innerJoin('farms', 'farms.id', 'orders.farm_id')
      .innerJoin('markets', 'markets.id', 'orders.market_id')
      .select([
        'deliveries.id',
        'deliveries.type',
        'deliveries.scheduled_at',
        'deliveries.completed_at',
        'deliveries.status',
        'deliveries.notes',
        'orders.id as order_id',
        'orders.order_number',
        'orders.total',
        'farms.name as farm_name',
        'markets.name as market_name',
      ]);

    const { date, farm_id, market_id } = request.query;
    if (date) {
      query = query.where('deliveries.scheduled_at', '>=', `${date}T00:00:00Z` as any);
      query = query.where('deliveries.scheduled_at', '<', `${date}T23:59:59Z` as any);
    }
    if (farm_id) query = query.where('orders.farm_id', '=', farm_id);
    if (market_id) query = query.where('orders.market_id', '=', market_id);

    const deliveries = await query.orderBy('deliveries.scheduled_at', 'asc').execute();
    return { deliveries };
  });

  // PUT /api/deliveries/:id/status
  app.put<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    const schema = z.object({
      status: z.enum(['scheduled', 'in_transit', 'completed', 'failed']),
    });

    const { status } = schema.parse(request.body);

    const updates: Record<string, unknown> = { status };
    if (status === 'completed') {
      updates.completed_at = new Date();
    }

    const [updated] = await app.db
      .updateTable('deliveries')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Delivery not found');
    return updated;
  });
}
