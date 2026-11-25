import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function deliveryRoutes(app: FastifyInstance) {
  // GET /api/deliveries?farm_id=&market_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { farm_id, market_id } = request.query;

    let query: FirebaseFirestore.Query = app.db.collection('deliveries');
    query = query.orderBy('scheduled_at', 'asc');

    const snapshot = await query.get();

    const deliveries = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const deliv = doc.data();
        const orderDoc = await app.db.collection('orders').doc(deliv.order_id).get();
        if (!orderDoc.exists) return null;
        const order = orderDoc.data()!;

        if (farm_id && order.farm_id !== farm_id) return null;
        if (market_id && order.market_id !== market_id) return null;

        const farmDoc = await app.db.collection('farms').doc(order.farm_id).get();
        const marketDoc = await app.db.collection('markets').doc(order.market_id).get();

        return {
          id: doc.id,
          type: deliv.type,
          scheduled_at: deliv.scheduled_at,
          completed_at: deliv.completed_at,
          status: deliv.status,
          notes: deliv.notes,
          order_id: deliv.order_id,
          order_number: order.order_number,
          total: order.total,
          farm_name: farmDoc.data()?.name || 'Unknown',
          market_name: marketDoc.data()?.name || 'Unknown',
        };
      }),
    );

    return { deliveries: deliveries.filter(Boolean) };
  });

  // PUT /api/deliveries/:id/status
  app.put<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    const schema = z.object({
      status: z.enum(['scheduled', 'in_transit', 'completed', 'failed']),
    });
    const { status } = schema.parse(request.body);

    const ref = app.db.collection('deliveries').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Delivery not found');

    const updates: Record<string, unknown> = { status };
    if (status === 'completed') updates.completed_at = new Date();

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });
}
