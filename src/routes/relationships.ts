import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function relationshipRoutes(app: FastifyInstance) {
  // POST /api/farm-market-rels — connect a farm and market
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string().uuid(),
      market_id: z.string().uuid(),
      priority: z.number().int().positive().default(99),
      notification_delay_min: z.number().int().min(0).default(0),
    });

    const data = schema.parse(request.body);

    const [rel] = await app.db
      .insertInto('farm_market_rels')
      .values({
        farm_id: data.farm_id,
        market_id: data.market_id,
        priority: data.priority,
        notification_delay_min: data.notification_delay_min,
      })
      .returningAll()
      .execute();

    reply.status(201).send(rel);
  });

  // PUT /api/farm-market-rels/:id — update priority/delay
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { priority, notification_delay_min, active, delivery_preferences } = request.body as Record<
      string,
      unknown
    >;

    const updates: Record<string, unknown> = {};
    if (priority !== undefined) updates.priority = priority;
    if (notification_delay_min !== undefined) updates.notification_delay_min = notification_delay_min;
    if (active !== undefined) updates.active = active;
    if (delivery_preferences !== undefined)
      updates.delivery_preferences = JSON.stringify(delivery_preferences);

    const [updated] = await app.db
      .updateTable('farm_market_rels')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Relationship not found');
    return updated;
  });
}
