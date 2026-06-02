import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { sendSms } from './sms.js';
import { v4 as uuid } from 'uuid';

export async function processRecurringOrders(db: Firestore, env: Env): Promise<{ processed: number; created: number; skipped: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Filter by next_delivery in memory to avoid an active+next_delivery composite index.
  const activeSnap = await db.collection('recurring_orders')
    .where('active', '==', true)
    .get();
  const dueSnap = {
    docs: activeSnap.docs.filter((d) => {
      const nd = d.data().next_delivery?.toDate?.() || new Date(d.data().next_delivery);
      return nd <= today;
    }),
    get size() { return this.docs.length; },
  };

  let created = 0;
  let skipped = 0;

  for (const roDoc of dueSnap.docs) {
    const ro = roDoc.data();

    const farmDoc = await db.collection('farms').doc(ro.farm_id).get();
    const marketDoc = await db.collection('markets').doc(ro.market_id).get();
    if (!farmDoc.exists || !marketDoc.exists) { skipped++; continue; }

    const farm = farmDoc.data()!;
    const market = marketDoc.data()!;
    const farmerUserDoc = await db.collection('users').doc(farm.user_id).get();
    const marketUserDoc = await db.collection('users').doc(market.user_id).get();
    const farmerPhone = farmerUserDoc.data()?.phone;
    const marketPhone = marketUserDoc.data()?.phone;

    const itemsSnap = await db.collection('recurring_orders').doc(roDoc.id).collection('recurring_order_items').get();

    const orderItems: Array<{ inventory_id: string; product_name: string; quantity: number; unit: string; unit_price: number; line_total: number }> = [];
    const unavailable: string[] = [];

    for (const itemDoc of itemsSnap.docs) {
      const item = itemDoc.data();
      const prodDoc = await db.collection('products').doc(item.product_id).get();
      const productName = prodDoc.data()?.name || 'Unknown';

      const invSnap = await db.collection('inventory')
        .where('farm_id', '==', ro.farm_id)
        .get();

      const inv = invSnap.docs.find((d) => {
        const v = d.data();
        return v.product_id === item.product_id
          && ['available', 'partial'].includes(v.status)
          && v.remaining >= item.quantity;
      });
      if (!inv) {
        unavailable.push(`${item.quantity} ${item.unit} ${productName}`);
        continue;
      }

      const invData = inv.data();
      const lineTotal = Number(invData.price) * item.quantity;
      orderItems.push({
        inventory_id: inv.id,
        product_name: productName,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: Number(invData.price),
        line_total: lineTotal,
      });
    }

    if (unavailable.length > 0) {
      if (farmerPhone) await sendSms({ env, to: farmerPhone, body: `Standing order for ${market.name} is short: ${unavailable.join(', ')}` }).catch(() => null);
      if (marketPhone) await sendSms({ env, to: marketPhone, body: `Your standing order from ${farm.name} may be short today.` }).catch(() => null);
      if (orderItems.length === 0) { skipped++; }
    }

    if (orderItems.length > 0) {
      const total = orderItems.reduce((sum, oi) => sum + oi.line_total, 0);
      const orderId = uuid();
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;

      await db.collection('orders').doc(orderId).set({
        farm_id: ro.farm_id, market_id: ro.market_id, order_number: orderNumber,
        status: 'pending', total, order_date: new Date(),
        notes: `Auto-created from standing order`, created_at: new Date(), updated_at: new Date(),
      });

      for (const oi of orderItems) {
        await db.collection('orders').doc(orderId).collection('order_items').doc(uuid()).set(oi);
        const invRef = db.collection('inventory').doc(oi.inventory_id);
        const invDoc = await invRef.get();
        const inv = invDoc.data()!;
        const newRemaining = inv.remaining - oi.quantity;
        await invRef.update({ remaining: Math.max(0, newRemaining), status: newRemaining <= 0 ? 'sold' : 'partial' });
      }

      const itemSummary = orderItems.map((oi) => `${oi.quantity} ${oi.unit} ${oi.product_name}`).join(', ');
      if (farmerPhone) await sendSms({ env, to: farmerPhone, body: `Standing order fulfilled: ${market.name}\n${itemSummary}\nTotal: $${total.toFixed(2)}` }).catch(() => null);
      if (marketPhone) await sendSms({ env, to: marketPhone, body: `Your standing order from ${farm.name} confirmed!\n${itemSummary}\nTotal: $${total.toFixed(2)}` }).catch(() => null);

      created++;
    }

    const nextDate = calculateNextDelivery(ro.frequency, ro.schedule_days, new Date());
    await roDoc.ref.update({ next_delivery: nextDate });
  }

  return { processed: dueSnap.size, created, skipped };
}

function calculateNextDelivery(frequency: string, scheduleDays: string, fromDate: Date): Date {
  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const targetDays = scheduleDays.toLowerCase().split(/[,&\s]+/).map((d) => d.trim()).filter(Boolean)
    .map((d) => DAY_NAMES.indexOf(d.slice(0, 3))).filter((d) => d >= 0).sort((a, b) => a - b);

  const next = new Date(fromDate);
  next.setDate(next.getDate() + 1);

  switch (frequency) {
    case 'daily': return next;
    case 'twice_weekly':
    case 'weekly':
      if (targetDays.length === 0) { next.setDate(next.getDate() + 6); return next; }
      for (let i = 0; i < 14; i++) { if (targetDays.includes(next.getDay())) return next; next.setDate(next.getDate() + 1); }
      return next;
    case 'biweekly':
      next.setDate(next.getDate() + 7);
      for (let i = 0; i < 14; i++) { if (targetDays.includes(next.getDay())) return next; next.setDate(next.getDate() + 1); }
      return next;
    case 'monthly':
      next.setMonth(next.getMonth() + 1); next.setDate(fromDate.getDate()); return next;
    default:
      next.setDate(next.getDate() + 6); return next;
  }
}
