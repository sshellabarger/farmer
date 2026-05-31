import type { ToolContext } from './index.js';

export async function deliveryScheduleSet(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not found');

  const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
  if (farmSnap.empty) throw new Error('No farm found for this user');
  const farmRef = farmSnap.docs[0].ref;
  const farm = farmSnap.docs[0].data();

  const schedule = input.schedule as Array<{ day: string; time_window: string; areas?: string[] }>;
  if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('Please provide a delivery schedule with at least one day');
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
    areas: s.areas || [],
  }));

  await farmRef.update({ delivery_schedule: normalized });

  return {
    success: true,
    farm: farm.name,
    schedule: normalized,
    message: `Delivery schedule updated for ${farm.name}`,
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

  let query: FirebaseFirestore.Query = db.collection('orders')
    .where('status', 'in', ['confirmed', 'in_transit', 'pending']);

  if (farmId) query = query.where('farm_id', '==', farmId);
  else if (marketId) query = query.where('market_id', '==', marketId);
  else if (!farmId && userId) {
    const marketSnap = await db.collection('markets').where('user_id', '==', userId).limit(1).get();
    if (!marketSnap.empty) query = query.where('market_id', '==', marketSnap.docs[0].id);
  }

  const snapshot = await query.orderBy('order_date', 'desc').limit(20).get();

  const deliveries = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const order = doc.data();
      const fDoc = await db.collection('farms').doc(order.farm_id).get();
      const mDoc = await db.collection('markets').doc(order.market_id).get();
      return {
        id: doc.id,
        order_number: order.order_number,
        status: order.status,
        total: order.total,
        delivery_type: order.delivery_type,
        scheduled_delivery_at: order.scheduled_delivery_at,
        delivery_notes: order.delivery_notes,
        order_date: order.order_date,
        farm_name: fDoc.data()?.name || 'Unknown',
        farm_location: fDoc.data()?.location,
        market_name: mDoc.data()?.name || 'Unknown',
        market_location: mDoc.data()?.location,
      };
    }),
  );

  const scheduleInfo = farmData?.delivery_schedule
    ? { farm_delivery_schedule: farmData.delivery_schedule, farm_location: farmData.location }
    : null;

  return { count: deliveries.length, deliveries, ...scheduleInfo };
}
