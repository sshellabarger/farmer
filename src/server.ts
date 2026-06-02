import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { getEnv } from './config/env.js';
import { getDb } from './db/firestore.js';
import { serializeTimestamps } from './utils/serialize.js';
import { smsRoutes } from './routes/sms.js';
import { farmRoutes } from './routes/farms.js';
import { marketRoutes } from './routes/markets.js';
import { inventoryRoutes } from './routes/inventory.js';
import { orderRoutes } from './routes/orders.js';
import { authRoutes } from './routes/auth.js';
import { relationshipRoutes } from './routes/relationships.js';
import { recurringOrderRoutes } from './routes/recurring-orders.js';
import { analyticsRoutes } from './routes/analytics.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { productRoutes } from './routes/products.js';
import { uploadRoutes } from './routes/uploads.js';
import { profileRoutes } from './routes/profile.js';
import { feedbackRoutes } from './routes/feedback.js';
import { directoryRoutes } from './routes/directory.js';
import { inviteRoutes } from './routes/invite.js';
import { pushRoutes } from './routes/push.js';

async function start() {
  const env = getEnv();
  const db = getDb();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: (req) => req.ip });

  app.decorate('db', db);
  app.decorate('env', env);

  app.addHook('preSerialization', async (_req, _reply, payload) => serializeTimestamps(payload));

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(smsRoutes, { prefix: '/api/sms' });
  await app.register(farmRoutes, { prefix: '/api/farms' });
  await app.register(marketRoutes, { prefix: '/api/markets' });
  await app.register(inventoryRoutes, { prefix: '/api/inventory' });
  await app.register(orderRoutes, { prefix: '/api/orders' });
  await app.register(relationshipRoutes, { prefix: '/api/farm-market-rels' });
  await app.register(recurringOrderRoutes, { prefix: '/api/recurring-orders' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(deliveryRoutes, { prefix: '/api/deliveries' });
  await app.register(productRoutes, { prefix: '/api/products' });
  await app.register(uploadRoutes, { prefix: '/api/uploads' });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(feedbackRoutes, { prefix: '/api/feedback' });
  await app.register(directoryRoutes, { prefix: '/api/directory' });
  await app.register(inviteRoutes, { prefix: '/api/invite' });
  await app.register(pushRoutes, { prefix: '/api/push' });

  // View link redirect
  app.get('/api/view/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const doc = await db.collection('view_links').doc(token).get();
    if (!doc.exists) return reply.status(410).send('Link expired or invalid.');

    const data = doc.data()!;
    const expiresAt = data.expires_at?.toDate?.() || new Date(data.expires_at);
    if (expiresAt < new Date()) return reply.status(410).send('Link expired.');

    const { signJwt } = await import('./utils/jwt.js');
    const jwt = signJwt({ sub: data.userId, role: data.role }, env.JWT_SECRET);
    const page = data.role === 'market' ? 'market' : 'farmer';
    return reply.redirect(`/${page}?token=${jwt}&tab=${data.tab}`);
  });

  await app.listen({ port: env.LOCAL_PORT, host: env.HOST });
  console.log(`FarmLink API running on ${env.HOST}:${env.LOCAL_PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
