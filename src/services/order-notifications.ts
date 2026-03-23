import type { Kysely } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { getNotificationQueue } from '../workers/notification-queue.js';

/**
 * Send SMS notifications when order status changes.
 * Called from both the REST API and AI tool.
 */
export async function sendOrderStatusNotification(params: {
  db: Kysely<DB>;
  env: Env;
  orderId: string;
  oldStatus: string;
  newStatus: string;
}) {
  const { db, env, orderId, oldStatus, newStatus } = params;

  // Load order with farm + market + user details
  const order = await db
    .selectFrom('orders')
    .innerJoin('farms', 'farms.id', 'orders.farm_id')
    .innerJoin('markets', 'markets.id', 'orders.market_id')
    .select([
      'orders.id',
      'orders.order_number',
      'orders.total',
      'orders.delivery_type',
      'orders.scheduled_delivery_at',
      'farms.id as farm_id',
      'farms.name as farm_name',
      'farms.user_id as farm_user_id',
      'markets.id as market_id',
      'markets.name as market_name',
      'markets.user_id as market_user_id',
    ])
    .where('orders.id', '=', orderId)
    .executeTakeFirst();

  if (!order) return;

  // Get phone numbers
  const farmerUser = await db.selectFrom('users').select('phone').where('id', '=', order.farm_user_id).executeTakeFirst();
  const marketUser = await db.selectFrom('users').select('phone').where('id', '=', order.market_user_id).executeTakeFirst();

  if (!farmerUser || !marketUser) return;

  // Load order items for detailed messages
  const items = await db
    .selectFrom('order_items')
    .select(['product_name', 'quantity', 'unit', 'unit_price', 'line_total'])
    .where('order_id', '=', orderId)
    .execute();

  const itemSummary = items.map((i) => `  ${i.product_name}: ${i.quantity} ${i.unit} @ $${i.unit_price}`).join('\n');
  const deliveryInfo = order.delivery_type
    ? `\n${order.delivery_type === 'pickup' ? '📍 Pickup' : '🚚 Delivery'}${order.scheduled_delivery_at ? ` — ${formatDeliveryDate(order.scheduled_delivery_at)}` : ''}`
    : '';

  const queue = getNotificationQueue(env.REDIS_URL);

  // Build messages based on transition
  const notifications: Array<{ phone: string; message: string; target: 'farmer' | 'market' }> = [];

  switch (newStatus) {
    case 'confirmed': {
      // Notify both farmer and market
      notifications.push({
        phone: farmerUser.phone,
        target: 'farmer',
        message: `✅ Order ${order.order_number} confirmed!\n${order.market_name} ordered:\n${itemSummary}\nTotal: $${Number(order.total).toFixed(2)}${deliveryInfo}`,
      });
      notifications.push({
        phone: marketUser.phone,
        target: 'market',
        message: `✅ Your order ${order.order_number} from ${order.farm_name} is confirmed!\n${itemSummary}\nTotal: $${Number(order.total).toFixed(2)}${deliveryInfo}`,
      });
      break;
    }

    case 'in_transit': {
      // Notify market
      notifications.push({
        phone: marketUser.phone,
        target: 'market',
        message: `🚚 Order ${order.order_number} from ${order.farm_name} is on its way!\n${itemSummary}\nTotal: $${Number(order.total).toFixed(2)}`,
      });
      break;
    }

    case 'delivered': {
      // Notify farmer
      notifications.push({
        phone: farmerUser.phone,
        target: 'farmer',
        message: `📦 Delivery confirmed! Order ${order.order_number} to ${order.market_name} has been delivered.\nTotal: $${Number(order.total).toFixed(2)}`,
      });
      break;
    }

    case 'cancelled': {
      const cancelMsg = `❌ Order ${order.order_number} has been cancelled.\n${itemSummary}\nPrevious total: $${Number(order.total).toFixed(2)}`;
      // Notify both
      notifications.push({
        phone: farmerUser.phone,
        target: 'farmer',
        message: `${cancelMsg}\nMarket: ${order.market_name}`,
      });
      notifications.push({
        phone: marketUser.phone,
        target: 'market',
        message: `${cancelMsg}\nFarm: ${order.farm_name}`,
      });
      break;
    }
  }

  // Queue all notifications
  for (const notif of notifications) {
    const [notification] = await db
      .insertInto('notifications')
      .values({
        market_id: order.market_id,
        order_id: orderId,
        type: 'order_update',
        channel: 'sms',
        status: 'pending',
        scheduled_for: new Date(),
      })
      .returningAll()
      .execute();

    await queue.add(
      'send-notification',
      {
        notificationId: notification.id,
        marketId: order.market_id,
        phone: notif.phone,
        message: notif.message,
      },
      { jobId: `order-notif-${notification.id}` }
    );
  }
}

/**
 * Calculate the next delivery date for an order based on farm's delivery schedule.
 * Returns the next available delivery slot considering the farm's schedule and the delivery type.
 */
export function calculateNextDeliveryDate(
  deliverySchedule: Array<{ day: string; time_window: string; areas?: string[] }>,
  deliveryType: 'pickup' | 'delivery',
  marketLocation?: string,
): { date: Date; timeWindow: string } | null {
  if (!deliverySchedule || deliverySchedule.length === 0) return null;

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();
  const todayDayIndex = now.getDay();

  // Try to find the next matching slot within the next 7 days
  for (let offset = 1; offset <= 7; offset++) {
    const candidateDate = new Date(now);
    candidateDate.setDate(now.getDate() + offset);
    const dayIndex = candidateDate.getDay();
    const dayName = dayNames[dayIndex];

    for (const slot of deliverySchedule) {
      if (slot.day.toLowerCase() === dayName) {
        // If delivery type and areas specified, check if market location is in the area
        // For now, accept any matching day
        // Parse time window to set the date correctly (e.g. "6am-10am" → 6:00)
        const startHour = parseTimeWindowStart(slot.time_window);
        candidateDate.setHours(startHour, 0, 0, 0);

        return { date: candidateDate, timeWindow: slot.time_window };
      }
    }
  }

  return null;
}

function parseTimeWindowStart(timeWindow: string): number {
  // Parse "6am-10am" or "2pm-5pm" format
  const match = timeWindow.match(/^(\d{1,2})\s*(am|pm)/i);
  if (!match) return 8; // default 8am
  let hour = parseInt(match[1]);
  if (match[2].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[2].toLowerCase() === 'am' && hour === 12) hour = 0;
  return hour;
}

function formatDeliveryDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}, ${h}:00 ${ampm}`;
}
