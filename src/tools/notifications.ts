import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';
import { CloudTasksClient } from '@google-cloud/tasks';

export async function notifyMarkets(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env } = ctx;
  const inventoryId = input.inventory_id as string;
  const specificMarketIds = input.market_ids as string[] | undefined;

  const invDoc = await db.collection('inventory').doc(inventoryId).get();
  if (!invDoc.exists) throw new Error('Inventory not found');
  const inv = invDoc.data()!;

  const prodDoc = await db.collection('products').doc(inv.product_id).get();
  const product = prodDoc.data() || {};
  const farmDoc = await db.collection('farms').doc(inv.farm_id).get();
  const farmName = farmDoc.data()?.name || 'Unknown';

  // Get connected markets (filter active + sort by priority in memory)
  const relsSnap = await db.collection('farm_market_rels')
    .where('farm_id', '==', inv.farm_id)
    .get();
  const relDocs = relsSnap.docs
    .filter((d) => d.data().active)
    .sort((a, b) => (a.data().priority ?? 99) - (b.data().priority ?? 99));

  const markets: Array<{ market_id: string; market_name: string; phone: string; priority: number; notification_delay_min: number }> = [];

  for (const relDoc of relDocs) {
    const rel = relDoc.data();
    if (specificMarketIds && !specificMarketIds.includes(rel.market_id)) continue;

    const marketDoc = await db.collection('markets').doc(rel.market_id).get();
    if (!marketDoc.exists) continue;
    const market = marketDoc.data()!;
    const userDoc = await db.collection('users').doc(market.user_id).get();

    markets.push({
      market_id: rel.market_id,
      market_name: market.name,
      phone: userDoc.data()?.phone || '',
      priority: rel.priority,
      notification_delay_min: rel.notification_delay_min || 0,
    });
  }

  if (markets.length === 0) {
    return { success: false, message: 'No connected markets to notify' };
  }

  const scheduled: Array<{ market: string; delay_min: number }> = [];

  for (const market of markets) {
    const notifId = uuid();
    const delayMs = market.notification_delay_min * 60 * 1000;
    const scheduledFor = new Date(Date.now() + delayMs);

    await db.collection('notifications').doc(notifId).set({
      market_id: market.market_id,
      inventory_id: inventoryId,
      type: 'new_inventory',
      channel: 'sms',
      status: 'pending',
      scheduled_for: scheduledFor,
      created_at: new Date(),
    });

    // Queue via Cloud Tasks if configured, otherwise send immediately
    const message = `New from ${farmName}: ${inv.remaining} ${product.unit} of ${product.name} @ $${inv.price}/${product.unit}. Reply to order!`;

    if (env.CLOUD_FUNCTIONS_URL && env.GCLOUD_PROJECT) {
      try {
        const client = new CloudTasksClient();
        const queuePath = client.queuePath(
          env.GCLOUD_PROJECT,
          env.CLOUD_TASKS_LOCATION,
          env.CLOUD_TASKS_QUEUE,
        );
        await client.createTask({
          parent: queuePath,
          task: {
            scheduleTime: { seconds: Math.floor(scheduledFor.getTime() / 1000) },
            httpRequest: {
              httpMethod: 'POST',
              url: `${env.CLOUD_FUNCTIONS_URL}/sendNotification`,
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify({ notificationId: notifId, phone: market.phone, message })).toString('base64'),
            },
          },
        });
      } catch (err) {
        // Fall back to direct send if Cloud Tasks fails
        const { sendSms } = await import('../services/sms.js');
        await sendSms({ env, to: market.phone, body: message });
        await db.collection('notifications').doc(notifId).update({ status: 'sent', sent_at: new Date() });
      }
    } else {
      // Local dev: send immediately
      const { sendSms } = await import('../services/sms.js');
      try {
        await sendSms({ env, to: market.phone, body: message });
        await db.collection('notifications').doc(notifId).update({ status: 'sent', sent_at: new Date() });
      } catch {
        await db.collection('notifications').doc(notifId).update({ status: 'failed' });
      }
    }

    scheduled.push({ market: market.market_name, delay_min: market.notification_delay_min });
  }

  return { success: true, markets_notified: scheduled.length, schedule: scheduled };
}
