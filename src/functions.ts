import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { setGlobalOptions } from 'firebase-functions/v2';
import Fastify, { type FastifyRequest, type FastifyReply, type FastifyError } from 'fastify';
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
import { inviteRoutes } from './routes/invite.js';
import { pushRoutes } from './routes/push.js';
import { errorRoutes } from './routes/errors.js';
import { reminderRoutes } from './routes/reminders.js';
import { adminRoutes } from './routes/admin.js';
import { serializeTimestamps } from './utils/serialize.js';

setGlobalOptions({
  region: 'us-central1',
  memory: '512MiB',
  timeoutSeconds: 120,
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

  // Convert Firestore Timestamps to ISO strings in all JSON responses.
  app.addHook('preSerialization', async (_req: FastifyRequest, _reply: FastifyReply, payload: unknown) => serializeTimestamps(payload));

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
  await app.register(errorRoutes, { prefix: '/api/errors' });
  await app.register(reminderRoutes, { prefix: '/api/reminders' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Short view-link redirect: /api/view/:token → dashboard with a signed JWT
  app.get('/api/view/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    if (!token) return reply.status(404).send('Not found.');
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

  // Global error handler — any unhandled route error gets logged, alerted
  // (text + email with AI-researched fix), and returned as a clean 500.
  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error(error);
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Only alert on real server-side failures (5xx), not client/validation 4xx.
    if (status >= 500) {
      try {
        const { notifyError } = await import('./services/error-notify.js');
        // Awaited so the alert completes before the function instance freezes.
        await notifyError({
          env,
          err: error,
          source: 'api-route',
          context: { route: request.url, method: request.method },
        });
      } catch (e) {
        console.error('notifyError failed:', e);
      }
    }
    reply.status(status).send({ error: status >= 500 ? 'Internal server error' : error.message });
  });

  await app.ready();
  return app;
}

// Main API function — handles all /api/* requests
export const api = onRequest(async (req, res) => {
  const fastify = await getApp();

  // Use the RAW request body (a Buffer that Firebase populates) so multipart
  // file uploads and any binary/content-type are preserved. JSON.stringify(req.body)
  // would corrupt multipart boundaries and binary data, breaking image uploads.
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const payload = rawBody && rawBody.length > 0
    ? rawBody
    : req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body)
      : undefined;

  const response = await fastify.inject({
    method: req.method as any,
    url: req.url || '/',
    headers: req.headers as Record<string, string>,
    payload,
  });

  res.status(response.statusCode);
  for (const [key, value] of Object.entries(response.headers)) {
    if (value) res.setHeader(key, value as string);
  }
  res.send(response.body);
});

// Scheduled function: process recurring orders daily at midnight CT
export const processRecurringOrders = onSchedule(
  { schedule: '0 0 * * *', timeZone: 'America/Chicago' },
  async () => {
    const db = getDb();
    const env = getEnv();
    try {
      const { processRecurringOrders: process } = await import('./services/recurring-orders.js');
      const result = await process(db, env);
      console.log(`Recurring orders: ${result.processed} processed, ${result.created} created, ${result.skipped} skipped`);
    } catch (err) {
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'scheduler:recurring-orders' }).catch(() => {});
      throw err;
    }
  }
);

// Scheduled function: freshness sweep daily at 7am CT — flags aging produce
// and texts farmers what to sell soon, donate, or compost.
export const freshnessAlerts = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Chicago' },
  async () => {
    const db = getDb();
    const env = getEnv();
    try {
      const { sendFreshnessAlerts } = await import('./services/freshness-alerts.js');
      const result = await sendFreshnessAlerts(db, env);
      console.log(`Freshness alerts: ${result.farmsAlerted} farms alerted (${result.agingItems} aging, ${result.pastItems} past shelf life)`);
    } catch (err) {
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'scheduler:freshness-alerts' }).catch(() => {});
      throw err;
    }
  }
);

// Scheduled function: deliver due user reminders (checked every 15 minutes)
export const processReminders = onSchedule(
  { schedule: '*/15 * * * *', timeZone: 'America/Chicago' },
  async () => {
    const db = getDb();
    const env = getEnv();
    try {
      const { processDueReminders } = await import('./services/reminders.js');
      const result = await processDueReminders(db, env);
      if (result.sent > 0) console.log(`Reminders: ${result.sent}/${result.checked} sent`);
    } catch (err) {
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'scheduler:reminders' }).catch(() => {});
      throw err;
    }
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
      const { notifyByPhone } = await import('./services/push.js');
      const channel = await notifyByPhone(db, env, phone, { title: 'FarmLink', body: message, url: '/', sms: message });
      if (channel === 'none') throw new Error('No delivery channel succeeded');
      await db.collection('notifications').doc(notificationId).update({
        status: 'sent',
        channel,
        sent_at: new Date(),
      });
    } catch (err) {
      await db.collection('notifications').doc(notificationId).update({ status: 'failed' });
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'task:sendNotification', context: { userPhone: phone } }).catch(() => {});
      throw err;
    }
  }
);
