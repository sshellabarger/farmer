import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { byDateAsc } from '../utils/sort.js';
import { v4 as uuid } from 'uuid';

export async function recurringOrderRoutes(app: FastifyInstance) {
  // GET /api/recurring-orders?farm_id=&market_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { farm_id, market_id } = request.query;
    // Single equality filter at DB layer; sort in memory to avoid composite index.
    let query: FirebaseFirestore.Query = app.db.collection('recurring_orders');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    else if (market_id) query = query.where('market_id', '==', market_id);

    const snapshot = await query.get();
    const filtered = snapshot.docs.filter((d) => {
      if (market_id && d.data().market_id !== market_id) return false;
      return true;
    });
    const roDocs = byDateAsc(filtered.map((d) => ({ doc: d, next_delivery: d.data().next_delivery })), 'next_delivery').map((x) => x.doc);

    const result = await Promise.all(
      roDocs.map(async (doc) => {
        const ro = doc.data();
        const farmDoc = await app.db.collection('farms').doc(ro.farm_id).get();
        const marketDoc = await app.db.collection('markets').doc(ro.market_id).get();

        const itemsSnap = await app.db
          .collection('recurring_orders').doc(doc.id).collection('recurring_order_items').get();

        const items = await Promise.all(
          itemsSnap.docs.map(async (itemDoc) => {
            const item = itemDoc.data();
            const prodDoc = await app.db.collection('products').doc(item.product_id).get();
            return {
              id: itemDoc.id,
              product_id: item.product_id,
              product_name: prodDoc.data()?.name || 'Unknown',
              quantity: item.quantity,
              unit: item.unit,
            };
          }),
        );

        return {
          id: doc.id,
          farm_id: ro.farm_id,
          market_id: ro.market_id,
          farm_name: farmDoc.data()?.name || 'Unknown',
          market_name: marketDoc.data()?.name || 'Unknown',
          frequency: ro.frequency,
          schedule_days: ro.schedule_days,
          next_delivery: ro.next_delivery,
          active: ro.active,
          created_at: ro.created_at,
          items,
        };
      }),
    );

    return { recurring_orders: result };
  });

  // POST /api/recurring-orders
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      market_id: z.string(),
      frequency: z.enum(['daily', 'twice_weekly', 'weekly', 'biweekly', 'monthly']),
      schedule_days: z.string().min(1),
      next_delivery: z.string(),
      items: z.array(
        z.object({
          product_id: z.string(),
          quantity: z.number().positive(),
          unit: z.string().min(1),
        })
      ),
    });

    const data = schema.parse(request.body);
    const id = uuid();
    const ro = {
      farm_id: data.farm_id,
      market_id: data.market_id,
      frequency: data.frequency,
      schedule_days: data.schedule_days,
      next_delivery: new Date(data.next_delivery),
      active: true,
      created_at: new Date(),
    };

    await app.db.collection('recurring_orders').doc(id).set(ro);

    for (const item of data.items) {
      await app.db
        .collection('recurring_orders').doc(id).collection('recurring_order_items')
        .doc(uuid()).set(item);
    }

    reply.status(201).send({ id, ...ro });
  });

  // PUT /api/recurring-orders/:id
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { frequency, schedule_days, next_delivery, active, items } = request.body as Record<string, any>;

    const ref = app.db.collection('recurring_orders').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Recurring order not found');

    const updates: Record<string, unknown> = {};
    if (frequency !== undefined) updates.frequency = frequency;
    if (schedule_days !== undefined) updates.schedule_days = schedule_days;
    if (next_delivery !== undefined) updates.next_delivery = new Date(next_delivery);
    if (active !== undefined) updates.active = active;

    if (Object.keys(updates).length > 0) await ref.update(updates);

    if (items && Array.isArray(items)) {
      const itemsSnap = await ref.collection('recurring_order_items').get();
      for (const d of itemsSnap.docs) await d.ref.delete();

      for (const item of items) {
        await ref.collection('recurring_order_items').doc(uuid()).set(item);
      }
    }

    return { success: true };
  });

  // DELETE /api/recurring-orders/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const ref = app.db.collection('recurring_orders').doc(request.params.id);
    const itemsSnap = await ref.collection('recurring_order_items').get();
    for (const d of itemsSnap.docs) await d.ref.delete();
    await ref.delete();
    reply.status(204).send();
  });
}
