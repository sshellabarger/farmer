import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { getEnv } from './config/env.js';
import { getDb } from './db/database.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const env = getEnv();
  const db = getDb(env.DATABASE_URL);

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

  // Rate limiting — global: 100 req/min per IP
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Serve uploaded files
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Decorate with shared deps
  app.decorate('db', db);
  app.decorate('env', env);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  // SMS routes with tighter rate limit: 10 req/min per IP
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(smsRoutes);
  }, { prefix: '/api/sms' });
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

  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`🌱 FarmLink API running on ${env.HOST}:${env.PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
