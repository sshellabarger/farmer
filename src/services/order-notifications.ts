import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { DEPOT } from '../config/depot.js';
import { notifyByPhone } from './push.js';
import { v4 as uuid } from 'uuid';

export async function sendOrderStatusNotification(params: {
  db: Firestore;
  env: Env;
  orderId: string;
  oldStatus: string;
  newStatus: string;
}) {
  const { db, env, orderId, newStatus } = params;

  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data()!;

  const farmDoc = await db.collection('farms').doc(order.farm_id).get();
  const marketDoc = await db.collection('markets').doc(order.market_id).get();
  if (!farmDoc.exists || !marketDoc.exists) return;

  const farm = farmDoc.data()!;
  const market = marketDoc.data()!;
  const farmerUserDoc = await db.collection('users').doc(farm.user_id).get();
  const marketUserDoc = await db.collection('users').doc(market.user_id).get();

  const farmerPhone = farmerUserDoc.data()?.phone;
  const marketPhone = marketUserDoc.data()?.phone;
  if (!farmerPhone || !marketPhone) return;

  const itemsSnap = await db.collection('orders').doc(orderId).collection('order_items').get();
  const itemSummary = itemsSnap.docs.map((d) => { const i = d.data(); return `  ${i.product_name}: ${i.quantity} ${i.unit}`; }).join('\n');

  const notifications: Array<{ phone: string; message: string }> = [];

  switch (newStatus) {
    case 'confirmed':
      notifications.push({ phone: farmerPhone, message: `Order ${order.order_number} confirmed!\n${market.name} ordered:\n${itemSummary}\nTotal: $${Number(order.total).toFixed(2)}\n\nDrop off at: ${DEPOT.short}` });
      notifications.push({ phone: marketPhone, message: `Your order ${order.order_number} from ${farm.name} is confirmed!\nTotal: $${Number(order.total).toFixed(2)}\n\nPickup at: ${DEPOT.short}` });
      break;
    case 'in_transit':
      notifications.push({ phone: marketPhone, message: `Order ${order.order_number} from ${farm.name} has been dropped off at the depot!\n\nPickup at: ${DEPOT.short}` });
      break;
    case 'delivered':
      notifications.push({ phone: farmerPhone, message: `Pickup confirmed! ${market.name} picked up order ${order.order_number} from the depot.` });
      break;
    case 'cancelled':
      notifications.push({ phone: farmerPhone, message: `Order ${order.order_number} cancelled. Market: ${market.name}` });
      notifications.push({ phone: marketPhone, message: `Order ${order.order_number} cancelled. Farm: ${farm.name}` });
      break;
  }

  for (const notif of notifications) {
    const notifId = uuid();
    await db.collection('notifications').doc(notifId).set({
      market_id: order.market_id,
      order_id: orderId,
      type: 'order_update',
      channel: 'push_or_sms',
      status: 'pending',
      scheduled_for: new Date(),
      created_at: new Date(),
    });

    // Prefer free push (if the recipient has the app), fall back to SMS.
    const channel = await notifyByPhone(db, env, notif.phone, {
      title: `Order ${order.order_number}`,
      body: notif.message,
      url: '/',
      sms: notif.message,
    });
    await db.collection('notifications').doc(notifId).update({
      status: channel === 'none' ? 'failed' : 'sent',
      channel,
      sent_at: new Date(),
    });
  }
}

/**
 * Calculate the next drop-off date at the depot based on a farm's schedule.
 * Kept as an alias so existing route imports still work.
 */
export const calculateNextDeliveryDate = calculateNextDropoff;

export function calculateNextDropoff(
  deliverySchedule: Array<{ day: string; time_window: string }>,
): { date: Date; timeWindow: string } | null {
  if (!deliverySchedule || deliverySchedule.length === 0) return null;

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();

  for (let offset = 1; offset <= 7; offset++) {
    const candidateDate = new Date(now);
    candidateDate.setDate(now.getDate() + offset);
    const dayName = dayNames[candidateDate.getDay()];

    for (const slot of deliverySchedule) {
      if (slot.day.toLowerCase() === dayName) {
        const startHour = parseTimeWindowStart(slot.time_window);
        candidateDate.setHours(startHour, 0, 0, 0);
        return { date: candidateDate, timeWindow: slot.time_window };
      }
    }
  }

  return null;
}

function parseTimeWindowStart(timeWindow: string): number {
  const match = timeWindow.match(/^(\d{1,2})\s*(am|pm)/i);
  if (!match) return 8;
  let hour = parseInt(match[1]);
  if (match[2].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[2].toLowerCase() === 'am' && hour === 12) hour = 0;
  return hour;
}
