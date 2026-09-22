import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
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

// Scheduled function: deliver due user reminders (checked every 15 minutes).
// Deploying with `npm run deploy:functions` prompts to delete
// processRecurringOrders, freshnessAlerts and sendNotification (retired in
// Phase 1) and removes their Cloud Scheduler jobs.
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

// Nightly market-date roll (Phase 2 contract §3). The cron's America/Chicago
// zone only anchors when the job fires; every date/time computation inside
// the generator uses each market's own `timezone`, never this one.
export const rollMarketDates = onSchedule(
  { schedule: '15 3 * * *', timeZone: 'America/Chicago' },
  async () => {
    const db = getDb();
    const env = getEnv();
    try {
      const { generateMarketDates } = await import('./services/market-dates.js');
      const snap = await db.collection('farmers_markets').where('active', '==', true).get();
      let created = 0;
      let updated = 0;
      let cancelled = 0;
      for (const doc of snap.docs) {
        const market = { id: doc.id, ...(doc.data() as Record<string, unknown>) } as import('./services/markets.js').FarmersMarket;
        const result = await generateMarketDates(db, market, { scope: 'window', actor: 'scheduler' });
        created += result.created;
        updated += result.updated;
        cancelled += result.cancelled;
      }
      console.log(`rollMarketDates: ${snap.docs.length} markets, created=${created} updated=${updated} cancelled=${cancelled}`);
    } catch (err) {
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'scheduler:rollMarketDates' }).catch(() => {});
      throw err;
    }
  }
);

// Phase 3 check-in workflow engine (contract §3.1). Runs every 5 minutes;
// each date's own idempotency claims (src/services/checkin-workflow.ts)
// make an interrupted run safe to resume on the next tick. The cron's
// America/Chicago zone only anchors when the job fires — every instant the
// engine computes comes from each market's own timezone/workflow/quiet_hours.
export const processMarketDates = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Chicago', timeoutSeconds: 300 },
  async () => {
    const db = getDb();
    const env = getEnv();
    try {
      const { processMarketDates: run } = await import('./services/checkin-workflow.js');
      const r = await run(db, env);
      console.log(
        `processMarketDates: scanned=${r.scanned} considered=${r.considered} checkin_sent=${r.checkin_sent} reminders_sent=${r.reminders_sent} deadlines=${r.deadlines_processed} summaries=${r.summaries_sent} claimed=${r.skipped_claimed} errors=${r.errors.length}`,
      );
      if (r.errors.length > 0) {
        const { notifyError } = await import('./services/error-notify.js');
        await notifyError({ env, err: new Error(r.errors.join('\n')), source: 'scheduler:processMarketDates' }).catch(() => {});
      }
    } catch (err) {
      const { notifyError } = await import('./services/error-notify.js');
      await notifyError({ env, err, source: 'scheduler:processMarketDates' }).catch(() => {});
      throw err;
    }
  },
);
