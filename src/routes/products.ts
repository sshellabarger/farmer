import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';

export async function productRoutes(app: FastifyInstance) {
  // GET /api/products?farm_id=
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { farm_id } = request.query;
    let query: FirebaseFirestore.Query = app.db.collection('products');
    if (farm_id) query = query.where('farm_id', '==', farm_id);

    const snapshot = await query.orderBy('name').get();
    const products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { products };
  });

  // POST /api/products
  app.post('/', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      name: z.string().min(1),
      category: z.string().min(1),
      unit: z.string().min(1),
      default_price: z.number().positive().optional(),
      seasonal: z.boolean().optional(),
    });

    const data = schema.parse(request.body);
    const id = uuid();
    const product = {
      farm_id: data.farm_id,
      name: data.name,
      category: data.category,
      unit: data.unit,
      default_price: data.default_price ?? null,
      seasonal: data.seasonal ?? false,
      created_at: new Date(),
    };

    await app.db.collection('products').doc(id).set(product);
    reply.status(201).send({ id, ...product });
  });
}
