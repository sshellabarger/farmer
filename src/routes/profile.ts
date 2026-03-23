import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyJwt } from '../utils/jwt.js';

const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  country: z.string().optional(),
}).nullable().optional();

const contactSchema = z.object({
  name: z.string(),
  role: z.string(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

function getUserId(request: any, env: any): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const payload = verifyJwt(authHeader.slice(7), env.JWT_SECRET);
  return payload?.sub ?? null;
}

export async function profileRoutes(app: FastifyInstance) {
  // GET /api/profile — full profile for logged-in user
  app.get('/', async (request, reply) => {
    const userId = getUserId(request, app.env);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const user = await app.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user) return reply.status(404).send({ error: 'User not found' });

    const farm = await app.db
      .selectFrom('farms')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    const market = await app.db
      .selectFrom('markets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return { user, farm, market };
  });

  // PUT /api/profile/user — update user fields
  app.put('/user', async (request, reply) => {
    const userId = getUserId(request, app.env);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const schema = z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().nullable().optional(),
      logo_url: z.string().nullable().optional(),
    });

    const data = schema.parse(request.body);
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.email !== undefined) updates.email = data.email;
    if (data.logo_url !== undefined) updates.logo_url = data.logo_url;

    if (Object.keys(updates).length === 0) {
      return reply.badRequest('No fields to update');
    }

    const [updated] = await app.db
      .updateTable('users')
      .set(updates)
      .where('id', '=', userId)
      .returningAll()
      .execute();

    return updated;
  });

  // PUT /api/profile/farm — update farm profile
  app.put('/farm', async (request, reply) => {
    const userId = getUserId(request, app.env);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const schema = z.object({
      name: z.string().min(1).optional(),
      location: z.string().optional(),
      specialty: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().email().nullable().optional(),
      logo_url: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      physical_address: addressSchema,
      billing_address: addressSchema,
      contacts: z.array(contactSchema).optional(),
      delivery_schedule: z.array(z.object({
        day: z.string(),
        time_window: z.string(),
        areas: z.array(z.string()).optional(),
      })).optional(),
    });

    const data = schema.parse(request.body);
    const updates: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        // JSONB columns need JSON.stringify
        if (['physical_address', 'billing_address', 'contacts', 'delivery_schedule'].includes(key)) {
          updates[key] = JSON.stringify(value);
        } else {
          updates[key] = value;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.badRequest('No fields to update');
    }

    const [updated] = await app.db
      .updateTable('farms')
      .set(updates)
      .where('user_id', '=', userId)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Farm not found');
    return updated;
  });

  // PUT /api/profile/market — update market profile
  app.put('/market', async (request, reply) => {
    const userId = getUserId(request, app.env);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const schema = z.object({
      name: z.string().min(1).optional(),
      location: z.string().optional(),
      type: z.enum(['grocery', 'restaurant', 'co-op', 'farmers_market']).optional(),
      delivery_pref: z.enum(['pickup', 'delivery', 'either']).optional(),
      phone: z.string().nullable().optional(),
      email: z.string().email().nullable().optional(),
      logo_url: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      physical_address: addressSchema,
      billing_address: addressSchema,
      contacts: z.array(contactSchema).optional(),
    });

    const data = schema.parse(request.body);
    const updates: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        if (['physical_address', 'billing_address', 'contacts'].includes(key)) {
          updates[key] = JSON.stringify(value);
        } else {
          updates[key] = value;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.badRequest('No fields to update');
    }

    const [updated] = await app.db
      .updateTable('markets')
      .set(updates)
      .where('user_id', '=', userId)
      .returningAll()
      .execute();

    if (!updated) return reply.notFound('Market not found');
    return updated;
  });
}
