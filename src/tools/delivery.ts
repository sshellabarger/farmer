import type { ToolContext } from './index.js';
import { DEPOT } from '../config/depot.js';
import { byDateDesc } from '../utils/sort.js';

export async function deliveryScheduleSet(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not found');

  const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
  if (farmSnap.empty) throw new Error('No farm found for this user');
  const farmRef = farmSnap.docs[0].ref;
  const farm = farmSnap.docs[0].data();

  const schedule = input.schedule as Array<{ day: string; time_window: string }>;
  if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('Please provide a drop-off schedule with at least one day');
  }

  const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const slot of schedule) {
    if (!validDays.includes(slot.day.toLowerCase())) {
      throw new Error(`Invalid day: ${slot.day}. Use: ${validDays.join(', ')}`);
    }
  }

  const normalized = schedule.map((s) => ({
    day: s.day.toLowerCase(),
    time_window: s.time_window,
  }));

  await farmRef.update({ delivery_schedule: normalized });

  return {
    success: true,
    farm: farm.name,
    schedule: normalized,
    depot_address: DEPOT.short,
    message: `Drop-off schedule updated for ${farm.name}. All drop-offs are at ${DEPOT.short}.`,
  };
}

export async function deliveryQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  let farmId: string | undefined;
  let farmData: any = null;

  if (userId) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    if (!farmSnap.empty) { farmId = farmSnap.docs[0].id; farmData = farmSnap.docs[0].data(); }
  }

  if (input.farm_id) farmId = input.farm_id as string;
  const marketId = input.market_id as string | undefined;

  // Single equality filter at DB layer; filter status + sort in memory.
  let query: FirebaseFirestore.Query = db.collection('orders');

  if (farmId) query = query.where('farm_id', '==', farmId);
  else if (marketId) query = query.where('market_id', '==', marketId);
  else if (!farmId && userId) {
    const marketSnap = await db.collection('markets').where('user_id', '==', userId).limit(1).get();
    if (!marketSnap.empty) query = query.where('market_id', '==', marketSnap.docs[0].id);
  }

  const snapshot = await query.get();
  const activeStatuses = ['confirmed', 'in_transit', 'pending'];
  const filtered = snapshot.docs.filter((d) => activeStatuses.includes(d.data().status));
  const orderDocs = byDateDesc(filtered.map((d) => ({ doc: d, order_date: d.data().order_date })), 'order_date').slice(0, 20).map((x) => x.doc);

  const deliveries = await Promise.all(
    orderDocs.map(async (doc) => {
      const order = doc.data();
      const fDoc = await db.collection('farms').doc(order.farm_id).get();
      const mDoc = await db.collection('markets').doc(order.market_id).get();
      return {
        id: doc.id,
        order_number: order.order_number,
        status: order.status,
        total: order.total,
        scheduled_delivery_at: order.scheduled_delivery_at,
        order_date: order.order_date,
        farm_name: fDoc.data()?.name || 'Unknown',
        market_name: mDoc.data()?.name || 'Unknown',
        depot_address: DEPOT.short,
      };
    }),
  );

  const scheduleInfo = farmData?.delivery_schedule
    ? { farm_dropoff_schedule: farmData.delivery_schedule, depot_address: DEPOT.short }
    : null;

  return { count: deliveries.length, deliveries, depot_address: DEPOT.short, ...scheduleInfo };
}
