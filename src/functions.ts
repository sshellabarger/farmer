import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { setGlobalOptions } from 'firebase-functions/v2';
import type { FastifyInstance } from 'fastify';
import { getDb } from './db/firestore.js';
import { getEnv } from './config/env.js';
import { buildApp } from './app.js';

setGlobalOptions({
  region: 'us-central1',
  memory: '512MiB',
  timeoutSeconds: 120,
});

let app: FastifyInstance | null = null;

// The Fastify app is built once per function instance and reused across
// invocations. The plugin/route setup lives in buildApp() and is shared with
// the local dev runner (src/server.ts).
async function getApp(): Promise<FastifyInstance> {
  if (app) return app;
  app = await buildApp({ db: getDb(), env: getEnv() });
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
