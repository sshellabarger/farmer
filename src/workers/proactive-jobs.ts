import { Queue, Worker } from 'bullmq';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { sendSms } from '../services/twilio.js';

// ── In-memory dedup for low-inventory alerts (inventory_id -> timestamp) ──
const lowInventoryAlertsSent = new Map<string, number>();
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helper: send SMS with fallback to logging ────────────────────
export async function sendProactiveSms(
  env: Env,
  phone: string,
  message: string,
): Promise<void> {
  try {
    await sendSms({ env, to: phone, body: message });
    console.log(`[proactive] SMS sent to ${phone}: ${message.slice(0, 60)}...`);
  } catch (err) {
    console.warn(`[proactive] SMS send failed for ${phone}, logging instead:`, (err as Error).message);
    console.log(`[proactive-fallback] To: ${phone} | Message: ${message}`);
  }
}

// ── (a) Low Inventory Alert ──────────────────────────────────────
async function processLowInventoryAlerts(db: Kysely<DB>, env: Env): Promise<number> {
  // Purge expired entries from dedup map
  const now = Date.now();
  for (const [id, ts] of lowInventoryAlertsSent) {
    if (now - ts > ALERT_COOLDOWN_MS) {
      lowInventoryAlertsSent.delete(id);
    }
  }

  // Query inventory where remaining < 20% of quantity
  const lowItems = await db
    .selectFrom('inventory')
    .innerJoin('products', 'products.id', 'inventory.product_id')
    .innerJoin('farms', 'farms.id', 'inventory.farm_id')
    .innerJoin('users', 'users.id', 'farms.user_id')
    .select([
      'inventory.id as inventory_id',
      'inventory.quantity',
      'inventory.remaining',
      'products.name as product_name',
      'products.unit',
      'users.phone',
    ])
    .where('inventory.status', 'in', ['available', 'partial'] as const)
    .where(
      sql<boolean>`inventory.remaining < inventory.quantity * 0.2`,
    )
    .where('inventory.remaining', '>', 0)
    .execute();

  let sent = 0;
  for (const item of lowItems) {
    // Skip if already alerted within 24h
    if (lowInventoryAlertsSent.has(item.inventory_id)) {
      continue;
    }

    const percent = Math.round((Number(item.remaining) / Number(item.quantity)) * 100);
    const message = `\u{1F4C9} Low stock alert: ${item.product_name} has ${item.remaining} ${item.unit} left (${percent}%). Update or restock?`;

    await sendProactiveSms(env, item.phone, message);
    lowInventoryAlertsSent.set(item.inventory_id, Date.now());
    sent++;
  }

  return sent;
}

// ── (b) Morning Harvest Reminder ─────────────────────────────────
async function processMorningHarvestReminder(db: Kysely<DB>, env: Env): Promise<number> {
  const today = new Date().toISOString().split('T')[0];

  // Get recurring orders due today, grouped by farm
  const dueOrders = await db
    .selectFrom('recurring_orders')
    .innerJoin('recurring_order_items', 'recurring_order_items.recurring_order_id', 'recurring_orders.id')
    .innerJoin('products', 'products.id', 'recurring_order_items.product_id')
    .innerJoin('farms', 'farms.id', 'recurring_orders.farm_id')
    .innerJoin('users', 'users.id', 'farms.user_id')
    .select([
      'recurring_orders.farm_id',
      'recurring_orders.id as recurring_order_id',
      'products.name as product_name',
      'recurring_order_items.quantity',
      'recurring_order_items.unit',
      'users.phone',
    ])
    .where('recurring_orders.active', '=', true)
    .where(sql<boolean>`recurring_orders.next_delivery::date = ${today}::date`)
    .execute();

  if (dueOrders.length === 0) return 0;

  // Group by farm
  const byFarm = new Map<string, { phone: string; orderIds: Set<string>; products: string[] }>();
  for (const row of dueOrders) {
    let entry = byFarm.get(row.farm_id);
    if (!entry) {
      entry = { phone: row.phone, orderIds: new Set(), products: [] };
      byFarm.set(row.farm_id, entry);
    }
    entry.orderIds.add(row.recurring_order_id);
    entry.products.push(`${row.quantity} ${row.unit} ${row.product_name}`);
  }

  let sent = 0;
  for (const [, farm] of byFarm) {
    const count = farm.orderIds.size;
    const productList = farm.products.join(', ');
    const message = `\u{1F305} Good morning! You have ${count} standing order(s) to fulfill today: ${productList}. Reply 'ready' when packed!`;
    await sendProactiveSms(env, farm.phone, message);
    sent++;
  }

  return sent;
}

// ── (c) Weekly Sales Summary ─────────────────────────────────────
async function processWeeklySalesSummary(db: Kysely<DB>, env: Env): Promise<number> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Revenue and order count per farm
  const farmStats = await db
    .selectFrom('orders')
    .innerJoin('farms', 'farms.id', 'orders.farm_id')
    .innerJoin('users', 'users.id', 'farms.user_id')
    .select([
      'orders.farm_id',
      'users.phone',
      sql<number>`count(orders.id)::int`.as('order_count'),
      sql<number>`coalesce(sum(orders.total), 0)`.as('total_revenue'),
    ])
    .where('orders.order_date', '>=', sevenDaysAgo)
    .where('orders.status', '!=', 'cancelled' as const)
    .groupBy(['orders.farm_id', 'users.phone'])
    .execute();

  if (farmStats.length === 0) return 0;

  // Top product per farm
  const topProducts = await db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select([
      'orders.farm_id',
      'order_items.product_name',
      sql<number>`sum(order_items.quantity)::int`.as('total_qty'),
    ])
    .where('orders.order_date', '>=', sevenDaysAgo)
    .where('orders.status', '!=', 'cancelled' as const)
    .groupBy(['orders.farm_id', 'order_items.product_name'])
    .orderBy(sql`sum(order_items.quantity)`, 'desc')
    .execute();

  const topByFarm = new Map<string, string>();
  for (const row of topProducts) {
    if (!topByFarm.has(row.farm_id)) {
      topByFarm.set(row.farm_id, row.product_name);
    }
  }

  let sent = 0;
  for (const farm of farmStats) {
    const topProduct = topByFarm.get(farm.farm_id) ?? 'N/A';
    const total = Number(farm.total_revenue).toFixed(2);
    const message = `\u{1F4CA} Weekly recap: ${farm.order_count} orders, $${total} revenue. Top seller: ${topProduct}. Great week! \u{1F33E}`;
    await sendProactiveSms(env, farm.phone, message);
    sent++;
  }

  return sent;
}

// ── (d) Standing Order Confirmation ──────────────────────────────
async function processStandingOrderConfirmation(db: Kysely<DB>, env: Env): Promise<number> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const dueOrders = await db
    .selectFrom('recurring_orders')
    .innerJoin('recurring_order_items', 'recurring_order_items.recurring_order_id', 'recurring_orders.id')
    .innerJoin('products', 'products.id', 'recurring_order_items.product_id')
    .innerJoin('farms', 'farms.id', 'recurring_orders.farm_id')
    .innerJoin('markets', 'markets.id', 'recurring_orders.market_id')
    .innerJoin('users', 'users.id', 'markets.user_id')
    .select([
      'recurring_orders.id as recurring_order_id',
      'recurring_orders.market_id',
      'farms.name as farm_name',
      'products.name as product_name',
      'recurring_order_items.quantity',
      'recurring_order_items.unit',
      'users.phone as market_phone',
    ])
    .where('recurring_orders.active', '=', true)
    .where(sql<boolean>`recurring_orders.next_delivery::date = ${tomorrowStr}::date`)
    .execute();

  if (dueOrders.length === 0) return 0;

  // Group by market + recurring order
  const byMarketOrder = new Map<string, { marketPhone: string; farmName: string; items: string[] }>();
  for (const row of dueOrders) {
    const key = `${row.market_id}:${row.recurring_order_id}`;
    let entry = byMarketOrder.get(key);
    if (!entry) {
      entry = { marketPhone: row.market_phone, farmName: row.farm_name, items: [] };
      byMarketOrder.set(key, entry);
    }
    entry.items.push(`${row.quantity} ${row.unit} ${row.product_name}`);
  }

  let sent = 0;
  for (const [, order] of byMarketOrder) {
    const items = order.items.join(', ');
    const message = `\u{1F4CB} Reminder: Your standing order from ${order.farmName} delivers tomorrow \u{2014} ${items}. Reply 'confirm' or 'skip'.`;
    await sendProactiveSms(env, order.marketPhone, message);
    sent++;
  }

  return sent;
}

// ── Setup: register all proactive job queues and workers ─────────
export async function setupProactiveJobs(
  db: Kysely<DB>,
  env: Env,
  redisUrl: string,
): Promise<{ queue: Queue; worker: Worker }> {
  const proactiveQueue = new Queue('proactive', { connection: { url: redisUrl } });

  // Register all scheduled jobs (BullMQ deduplicates by scheduler ID)
  await proactiveQueue.upsertJobScheduler(
    'low-inventory-alert',
    { pattern: '0 */4 * * *' }, // every 4 hours
    { name: 'low-inventory-alert' },
  );

  await proactiveQueue.upsertJobScheduler(
    'morning-harvest-reminder',
    { pattern: '0 7 * * *' }, // daily at 7am
    { name: 'morning-harvest-reminder' },
  );

  await proactiveQueue.upsertJobScheduler(
    'weekly-sales-summary',
    { pattern: '0 8 * * 0' }, // Sunday at 8am
    { name: 'weekly-sales-summary' },
  );

  await proactiveQueue.upsertJobScheduler(
    'standing-order-confirmation',
    { pattern: '0 8 * * *' }, // daily at 8am
    { name: 'standing-order-confirmation' },
  );

  const proactiveWorker = new Worker(
    'proactive',
    async (job) => {
      console.log(`[proactive] Processing job: ${job.name}`);

      switch (job.name) {
        case 'low-inventory-alert': {
          const count = await processLowInventoryAlerts(db, env);
          console.log(`[proactive] Low inventory alerts sent: ${count}`);
          return { sent: count };
        }
        case 'morning-harvest-reminder': {
          const count = await processMorningHarvestReminder(db, env);
          console.log(`[proactive] Morning harvest reminders sent: ${count}`);
          return { sent: count };
        }
        case 'weekly-sales-summary': {
          const count = await processWeeklySalesSummary(db, env);
          console.log(`[proactive] Weekly sales summaries sent: ${count}`);
          return { sent: count };
        }
        case 'standing-order-confirmation': {
          const count = await processStandingOrderConfirmation(db, env);
          console.log(`[proactive] Standing order confirmations sent: ${count}`);
          return { sent: count };
        }
        default:
          console.warn(`[proactive] Unknown job name: ${job.name}`);
      }
    },
    {
      connection: { url: redisUrl },
      concurrency: 1, // run one proactive job at a time
    },
  );

  proactiveWorker.on('completed', (job) => {
    console.log(`[proactive] Job ${job.name} completed`);
  });

  proactiveWorker.on('failed', (job, err) => {
    console.error(`[proactive] Job ${job?.name} failed:`, err.message);
  });

  console.log('[proactive] Proactive messaging jobs registered:');
  console.log('  - Low inventory alert (every 4h)');
  console.log('  - Morning harvest reminder (daily 7am)');
  console.log('  - Weekly sales summary (Sunday 8am)');
  console.log('  - Standing order confirmation (daily 8am)');

  return { queue: proactiveQueue, worker: proactiveWorker };
}
