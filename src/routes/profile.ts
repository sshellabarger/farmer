import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';

export async function profileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate(app));

  // GET /api/profile — the caller's own user record
  app.get('/', async (request, reply) => {
    const userDoc = await app.db.collection('users').doc(request.authUser!.id).get();
    if (!userDoc.exists) return reply.status(404).send({ error: 'User not found' });
    return { user: { id: userDoc.id, ...userDoc.data() } };
  });

  // PUT /api/profile/user
  app.put('/user', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().nullable().optional(),
      logo_url: z.string().nullable().optional(),
    });

    const data = schema.parse(request.body);
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.email !== undefined) updates.email = data.email;
    if (data.logo_url !== undefined) updates.logo_url = data.logo_url;

    if (Object.keys(updates).length <= 1) return reply.badRequest('No fields to update');

    const ref = app.db.collection('users').doc(request.authUser!.id);
    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });
}
