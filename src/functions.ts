import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { setGlobalOptions } from 'firebase-functions/v2';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { getDb } from './db/firestore.js';
import { getEnv } from './config/env.js';
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

setGlobalOptions({
  region: 'us-central1',
  memory: '512MiB',
  timeoutSeconds: 60,
});

let app: ReturnType<typeof Fastify> | null = null;

async function getApp() {
  if (app) return app;

  const env = getEnv();
  const db = getDb();

  app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req: any) => req.ip,
  });

  app.decorate('db', db);
  app.decorate('env', env);

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

  await app.ready();
  return app;
}

// Main API function — handles all /api/* requests
export const api = onRequest(async (req, res) => {
  const fastify = await getApp();
  fastify.server.emit('request', req, res);
});

// Scheduled function: process recurring orders daily at midnight CT
export const processRecurringOrders = onSchedule(
  { schedule: '0 0 * * *', timeZone: 'America/Chicago' },
  async () => {
    const { processRecurringOrders: process } = await import('./services/recurring-orders.js');
    const db = getDb();
    const env = getEnv();
    const result = await process(db, env);
    console.log(`Recurring orders: ${result.processed} processed, ${result.created} created, ${result.skipped} skipped`);
  }
);

// Cloud Task handler: send delayed notifications
export const sendNotification = onTaskDispatched(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 10 } },
  async (req) => {
    const { notificationId, phone, message } = req.data as {
      notificationId: string;
      phone: string;
      message: string;
    };

    const db = getDb();
    const env = getEnv();
    const notifDoc = await db.collection('notifications').doc(notificationId).get();

    if (!notifDoc.exists || notifDoc.data()?.status !== 'pending') {
      console.log(`Notification ${notificationId} already processed, skipping`);
      return;
    }

    const notif = notifDoc.data()!;
    if (notif.inventory_id) {
      const invDoc = await db.collection('inventory').doc(notif.inventory_id).get();
      const inv = invDoc.data();
      if (!inv || inv.status === 'sold' || inv.remaining <= 0) {
        await db.collection('notifications').doc(notificationId).update({ status: 'failed' });
        return;
      }
    }

    try {
      const { sendSms } = await import('./services/sms.js');
      await sendSms({ env, to: phone, body: message });
      await db.collection('notifications').doc(notificationId).update({
        status: 'sent',
        sent_at: new Date(),
      });
    } catch (err) {
      await db.collection('notifications').doc(notificationId).update({ status: 'failed' });
      throw err;
    }
  }
);
