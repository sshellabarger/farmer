import type { ToolContext } from './index.js';

/**
 * Set up or update a farm's delivery schedule.
 */
export async function deliveryScheduleSet(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  if (!userId) throw new Error('User not found');

  const farm = await db
    .selectFrom('farms')
    .select(['id', 'name', 'delivery_schedule'])
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!farm) throw new Error('No farm found for this user');

  const schedule = input.schedule as Array<{ day: string; time_window: string; areas?: string[] }>;
  if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('Please provide a delivery schedule with at least one day');
  }

  // Validate days
  const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const slot of schedule) {
    if (!validDays.includes(slot.day.toLowerCase())) {
      throw new Error(`Invalid day: ${slot.day}. Use: ${validDays.join(', ')}`);
    }
  }

  // Normalize days to lowercase
  const normalized = schedule.map((s) => ({
    day: s.day.toLowerCase(),
    time_window: s.time_window,
    areas: s.areas || [],
  }));

  await db
    .updateTable('farms')
    .set({ delivery_schedule: JSON.stringify(normalized) as any })
    .where('id', '=', farm.id)
    .execute();

  return {
    success: true,
    farm: farm.name,
    schedule: normalized,
    message: `Delivery schedule updated for ${farm.name}`,
  };
}

/**
 * Query deliveries for a specific date or range.
 */
export async function deliveryQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  // Get user's farm and/or market
  const farm = userId
    ? await db.selectFrom('farms').select(['id', 'name', 'delivery_schedule', 'location']).where('user_id', '=', userId).executeTakeFirst()
    : null;
  const market = userId
    ? await db.selectFrom('markets').select(['id', 'name', 'location']).where('user_id', '=', userId).executeTakeFirst()
    : null;

  const date = input.date as string | undefined;

  let query = db
    .selectFrom('orders')
    .innerJoin('farms', 'farms.id', 'orders.farm_id')
    .innerJoin('markets', 'markets.id', 'orders.market_id')
    .select([
      'orders.id',
      'orders.order_number',
      'orders.status',
      'orders.total',
      'orders.delivery_type',
      'orders.scheduled_delivery_at',
      'orders.delivery_notes',
      'orders.order_date',
      'farms.name as farm_name',
      'farms.location as farm_location',
      'markets.name as market_name',
      'markets.location as market_location',
    ])
    .where('orders.status', 'in', ['confirmed', 'in_transit', 'pending']);

  // Scope to user
  if (input.farm_id) {
    query = query.where('orders.farm_id', '=', input.farm_id as string);
  } else if (input.market_id) {
    query = query.where('orders.market_id', '=', input.market_id as string);
  } else if (farm) {
    query = query.where('orders.farm_id', '=', farm.id);
  } else if (market) {
    query = query.where('orders.market_id', '=', market.id);
  }

  // Filter by date
  if (date) {
    query = query.where('orders.order_date', '=', date as any);
  }

  const orders = await query.orderBy('orders.scheduled_delivery_at', 'asc').limit(20).execute();

  // Also return the farm's delivery schedule if applicable
  const scheduleInfo = farm?.delivery_schedule
    ? { farm_delivery_schedule: farm.delivery_schedule, farm_location: farm.location }
    : null;

  return {
    count: orders.length,
    deliveries: orders,
    ...scheduleInfo,
  };
}
