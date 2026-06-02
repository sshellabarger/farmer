import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';
import { registerToken, removeToken } from '../services/push.js';

export async function pushRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // POST /api/push/register — save this device's FCM token for the logged-in user.
  app.post('/register', { preHandler: [auth] }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.body);
    await registerToken(app.db, request.authUser!.id, token);
    return { success: true };
  });

  // POST /api/push/unregister — remove a token (e.g. on disabling notifications).
  app.post('/unregister', { preHandler: [auth] }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.body);
    await removeToken(app.db, request.authUser!.id, token);
    return { success: true };
  });
}
