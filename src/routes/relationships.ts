import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';

export async function relationshipRoutes(app: FastifyInstance) {
  // POST /api/farm-market-rels
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      market_id: z.string(),
      priority: z.number().int().positive().default(99),
      notification_delay_min: z.number().int().min(0).default(0),
    });

    const data = schema.parse(request.body);
    const id = uuid();
    const rel = {
      farm_id: data.farm_id,
      market_id: data.market_id,
      priority: data.priority,
      notification_delay_min: data.notification_delay_min,
      active: true,
      status: 'active',
      created_at: new Date(),
    };

    await app.db.collection('farm_market_rels').doc(id).set(rel);
    reply.status(201).send({ id, ...rel });
  });

  // PUT /api/farm-market-rels/:id
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { priority, notification_delay_min, active, delivery_preferences } = request.body as Record<string, unknown>;

    const ref = app.db.collection('farm_market_rels').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Relationship not found');

    const updates: Record<string, unknown> = {};
    if (priority !== undefined) updates.priority = priority;
    if (notification_delay_min !== undefined) updates.notification_delay_min = notification_delay_min;
    if (active !== undefined) updates.active = active;
    if (delivery_preferences !== undefined) updates.delivery_preferences = delivery_preferences;

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });
}
