import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireInventoryFarmOwner } from '../middleware/rbac.js';
import { v4 as uuid } from 'uuid';

export async function inventoryRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const farmerOrAdmin = requireRole('farmer', 'admin');
  const invFarmOwner = requireInventoryFarmOwner(app);

  // GET /api/inventory?farm_id=&category=&status= (public read)
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { farm_id, category, status } = request.query;

    let query: FirebaseFirestore.Query = app.db.collection('inventory');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    if (status) query = query.where('status', '==', status);

    const snapshot = await query.orderBy('listed_at', 'desc').get();

    const inventory = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const inv = doc.data();
        const productDoc = await app.db.collection('products').doc(inv.product_id).get();
        const product = productDoc.data() || {};
        const farmDoc = await app.db.collection('farms').doc(inv.farm_id).get();
        const farm = farmDoc.data() || {};

        if (category && !product.category?.toLowerCase().includes(category.toLowerCase())) {
          return null;
        }

        return {
          id: doc.id,
          product_name: product.name || 'Unknown',
          category: product.category || '',
          farm_name: farm.name || 'Unknown',
          quantity: inv.quantity,
          remaining: inv.remaining,
          unit: product.unit || '',
          price: inv.price,
          status: inv.status,
          harvest_date: inv.harvest_date,
          listed_at: inv.listed_at,
          image_url: inv.image_url,
        };
      }),
    );

    return { inventory: inventory.filter(Boolean) };
  });

  // POST /api/inventory
  app.post('/', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      product_id: z.string(),
      quantity: z.number().positive(),
      price: z.number().positive(),
      harvest_date: z.string().optional(),
      image_url: z.string().optional(),
    });

    const data = schema.parse(request.body);
    const id = uuid();

    const inv = {
      farm_id: data.farm_id,
      product_id: data.product_id,
      quantity: data.quantity,
      remaining: data.quantity,
      price: data.price,
      harvest_date: data.harvest_date ? new Date(data.harvest_date) : null,
      image_url: data.image_url || null,
      status: 'available',
      listed_at: new Date(),
    };

    await app.db.collection('inventory').doc(id).set(inv);
    reply.status(201).send({ id, ...inv });
  });

  // PUT /api/inventory/:id
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const { remaining, price, status, image_url } = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (remaining !== undefined) updates.remaining = remaining;
    if (price !== undefined) updates.price = price;
    if (status !== undefined) updates.status = status;
    if (image_url !== undefined) updates.image_url = image_url;

    const ref = app.db.collection('inventory').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Inventory not found');

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // DELETE /api/inventory/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    await app.db.collection('inventory').doc(request.params.id).delete();
    reply.status(204).send();
  });
}
