import type { ToolContext } from './index.js';
import { getNotificationQueue } from '../workers/notification-queue.js';

export async function notifyMarkets(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env } = ctx;
  const inventoryId = input.inventory_id as string;
  const specificMarketIds = input.market_ids as string[] | undefined;

  // Get the inventory item with farm info
  const inv = await db
    .selectFrom('inventory')
    .innerJoin('products', 'products.id', 'inventory.product_id')
    .innerJoin('farms', 'farms.id', 'inventory.farm_id')
    .select([
      'inventory.id',
      'inventory.farm_id',
      'products.name as product_name',
      'inventory.remaining',
      'products.unit',
      'inventory.price',
      'farms.name as farm_name',
    ])
    .where('inventory.id', '=', inventoryId)
    .executeTakeFirst();

  if (!inv) throw new Error('Inventory not found');

  // Get connected markets with priority/delay settings
  let marketsQuery = db
    .selectFrom('farm_market_rels')
    .innerJoin('markets', 'markets.id', 'farm_market_rels.market_id')
    .innerJoin('users', 'users.id', 'markets.user_id')
    .select([
      'markets.id as market_id',
      'markets.name as market_name',
      'users.phone',
      'farm_market_rels.priority',
      'farm_market_rels.notification_delay_min',
    ])
    .where('farm_market_rels.farm_id', '=', inv.farm_id)
    .where('farm_market_rels.active', '=', true);

  if (specificMarketIds && specificMarketIds.length > 0) {
    marketsQuery = marketsQuery.where('markets.id', 'in', specificMarketIds);
  }

  const markets = await marketsQuery.orderBy('farm_market_rels.priority', 'asc').execute();

  if (markets.length === 0) {
    return { success: false, message: 'No connected markets to notify' };
  }

  // Queue notifications with priority-based delays
  const queue = getNotificationQueue(env.REDIS_URL);
  const scheduled: Array<{ market: string; delay_min: number }> = [];

  for (const market of markets) {
    const delayMs = market.notification_delay_min * 60 * 1000;

    // Create notification record in DB
    const [notification] = await db
      .insertInto('notifications')
      .values({
        market_id: market.market_id,
        inventory_id: inventoryId,
        type: 'new_inventory',
        channel: 'sms',
        status: 'pending',
        scheduled_for: new Date(Date.now() + delayMs),
      })
      .returningAll()
      .execute();

    // Queue the BullMQ job
    await queue.add(
      'send-notification',
      {
        notificationId: notification.id,
        marketId: market.market_id,
        phone: market.phone,
        message: `🌱 New from ${inv.farm_name}: ${inv.remaining} ${inv.unit} of ${inv.product_name} @ $${inv.price}/${inv.unit}. Reply to order!`,
      },
      {
        delay: delayMs,
        jobId: `notif-${notification.id}`,
      }
    );

    scheduled.push({
      market: market.market_name,
      delay_min: market.notification_delay_min,
    });
  }

  return {
    success: true,
    markets_notified: scheduled.length,
    schedule: scheduled,
  };
}
