import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Worker, Queue } from 'bullmq';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { processRecurringOrders } from '../services/recurring-orders.js';
import { setupProactiveJobs } from './proactive-jobs.js';
import { sendSms } from '../services/telnyx.js';

const { Pool } = pg;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL!;

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: databaseUrl }),
  }),
});

const env: Env = {
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  TELNYX_API_KEY: process.env.TELNYX_API_KEY!,
  TELNYX_PHONE_NUMBER: process.env.TELNYX_PHONE_NUMBER!,
  TELNYX_MESSAGING_PROFILE_ID: process.env.TELNYX_MESSAGING_PROFILE_ID,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
  JWT_SECRET: process.env.JWT_SECRET!,
};

interface NotificationJobData {
  notificationId: string;
  marketId: string;
  phone: string;
  message: string;
}

const worker = new Worker<NotificationJobData>(
  'notifications',
  async (job) => {
    const { notificationId, phone, message } = job.data;

    console.log(`📤 Processing notification ${notificationId} → ${phone}`);

    // Check if the inventory is still available (it may have sold before the delayed notification fires)
    const notification = await db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirst();

    if (!notification || notification.status !== 'pending') {
      console.log(`⏭ Notification ${notificationId} already processed, skipping`);
      return;
    }

    if (notification.inventory_id) {
      const inv = await db
        .selectFrom('inventory')
        .select(['remaining', 'status'])
        .where('id', '=', notification.inventory_id)
        .executeTakeFirst();

      if (!inv || inv.status === 'sold' || Number(inv.remaining) <= 0) {
        console.log(`⏭ Inventory sold out, cancelling notification ${notificationId}`);
        await db
          .updateTable('notifications')
          .set({ status: 'failed' })
          .where('id', '=', notificationId)
          .execute();
        return;
      }
    }

    // Send the SMS via Telnyx
    try {
      await sendSms({ env, to: phone, body: message });

      await db
        .updateTable('notifications')
        .set({ status: 'sent', sent_at: new Date() })
        .where('id', '=', notificationId)
        .execute();

      console.log(`✅ Notification ${notificationId} sent`);
    } catch (err) {
      console.error(`❌ Failed to send notification ${notificationId}:`, err);
      await db
        .updateTable('notifications')
        .set({ status: 'failed' })
        .where('id', '=', notificationId)
        .execute();
      throw err; // BullMQ will retry
    }
  },
  {
    connection: { url: redisUrl },
    concurrency: 5,
    limiter: {
      max: 1,
      duration: 1000, // 1 msg/sec rate limit
    },
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

console.log('🔄 Notification worker started');

// ── Scheduler: Recurring Order Fulfillment ──────────────────────
// Runs daily at midnight (server timezone). Each run processes all
// recurring orders whose next_delivery <= today.

const schedulerQueue = new Queue('scheduler', { connection: { url: redisUrl } });

// Add the repeatable job (BullMQ deduplicates by repeat key)
await schedulerQueue.upsertJobScheduler(
  'recurring-orders-daily',
  { pattern: '0 0 * * *' }, // midnight daily
  { name: 'process-recurring-orders' }
);

const schedulerWorker = new Worker(
  'scheduler',
  async (job) => {
    if (job.name === 'process-recurring-orders') {
      console.log('📅 Processing recurring orders...');
      const result = await processRecurringOrders(db, env);
      console.log(`📅 Recurring orders: ${result.processed} processed, ${result.created} created, ${result.skipped} skipped`);
      return result;
    }
  },
  { connection: { url: redisUrl } }
);

schedulerWorker.on('completed', (job) => {
  console.log(`Scheduler job ${job.name} completed`);
});

schedulerWorker.on('failed', (job, err) => {
  console.error(`Scheduler job ${job?.name} failed:`, err.message);
});

console.log('📅 Recurring order scheduler started (daily at midnight)');

// ── Proactive AI-Driven Messaging Jobs ──────────────────────────
await setupProactiveJobs(db, env, redisUrl);
console.log('🤖 Proactive messaging jobs started');
