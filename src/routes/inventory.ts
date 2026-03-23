import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireInventoryFarmOwner } from '../middleware/rbac.js';

export async function inventoryRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const farmerOrAdmin = requireRole('farmer', 'admin');
  const invFarmOwner = requireInventoryFarmOwner(app);

  // GET /api/inventory?farm_id=&category=&status= (public read)
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    let query = app.db
      .selectFrom('inventory')
      .innerJoin('products', 'products.id', 'inventory.product_id')
      .innerJoin('farms', 'farms.id', 'inventory.farm_id')
      .select([
        'inventory.id',
        'products.name as product_name',
        'products.category',
        'farms.name as farm_name',
        'inventory.quantity',
        'inventory.remaining',
        'products.unit',
        'inventory.price',
        'inventory.status',
        'inventory.harvest_date',
        'inventory.listed_at',
        'inventory.image_url',
      ]);

    const { farm_id, category, status } = request.query;
    if (farm_id) query = query.where('inventory.farm_id', '=', farm_id);
    if (category) query = query.where('products.category', 'ilike', `%${category}%`);
    if (status) query = query.where('inventory.status', '=', status as any);

    const results = await query.orderBy('inventory.listed_at', 'desc').execute();
    return { inventory: results };
  });

  // POST /api/inventory — farmer must own the farm (or admin)
  app.post('/', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const schema = z.object({
      farm_id: z.string().uuid(),
      product_id: z.string().uuid(),
      quantity: z.number().positive(),
      price: z.number().positive(),
      harvest_date: z.string().optional(),
      image_url: z.string().optional(),
    });

    const data = schema.parse(request.body);

    const [inv] = await app.db
      .insertInto('inventory')
      .values({
        farm_id: data.farm_id,
        product_id: data.product_id,
        quantity: data.quantity,
        remaining: data.quantity,
        price: data.price,
        harvest_date: data.harvest_date ? new Date(data.harvest_date) : null,
        image_url: data.image_url || null,
      })
      .returningAll()
      .execute();

    reply.status(201).send(inv);
  });

  // PUT /api/inventory/:id — farmer must own the farm (or admin)
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const { remaining, price, status, image_url } = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (remaining !== undefined) updates.remaining = remaining;
    if (price !== undefined) updates.price = price;
    if (status !== undefined) updates.status = status;
    if (image_url !== undefined) updates.image_url = image_url;

    const [updated] = await app.db
      .updateTable('inventory')
      .set(updates)
      .where('id', '=', request.params.id)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Inventory not found');
    return updated;
  });

  // DELETE /api/inventory/:id — farmer must own the farm (or admin)
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    await app.db.deleteFrom('inventory').where('id', '=', request.params.id).execute();
    reply.status(204).send();
  });
}
