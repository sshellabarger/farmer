import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function productRoutes(app: FastifyInstance) {
  // GET /api/products?farm_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    let query = app.db
      .selectFrom('products')
      .selectAll();

    const { farm_id } = request.query;
    if (farm_id) query = query.where('farm_id', '=', farm_id);

    const results = await query.orderBy('name', 'asc').execute();
    return { products: results };
  });

  // POST /api/products
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string().uuid(),
      name: z.string().min(1),
      category: z.string().min(1),
      unit: z.string().min(1),
      default_price: z.number().positive().optional(),
      seasonal: z.boolean().optional(),
    });

    const data = schema.parse(request.body);

    const [product] = await app.db
      .insertInto('products')
      .values({
        farm_id: data.farm_id,
        name: data.name,
        category: data.category,
        unit: data.unit,
        default_price: data.default_price ?? null,
        seasonal: data.seasonal ?? false,
      })
      .returningAll()
      .execute();

    reply.status(201).send(product);
  });
}
