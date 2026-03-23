import type { ToolContext } from './index.js';

export async function marketQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;

  // If farm_id provided: return connected markets with priority info
  if (input.farm_id) {
    const markets = await db
      .selectFrom('farm_market_rels')
      .innerJoin('markets', 'markets.id', 'farm_market_rels.market_id')
      .select([
        'markets.id',
        'markets.name',
        'markets.type',
        'markets.location',
        'farm_market_rels.priority',
        'farm_market_rels.notification_delay_min',
        'farm_market_rels.active',
      ])
      .where('farm_market_rels.farm_id', '=', input.farm_id as string)
      .where('farm_market_rels.active', '=', true)
      .orderBy('farm_market_rels.priority', 'asc')
      .execute();

    return { count: markets.length, markets };
  }

  // If market_id provided: return available inventory across connected farms
  if (input.market_id) {
    const inventory = await db
      .selectFrom('inventory')
      .innerJoin('products', 'products.id', 'inventory.product_id')
      .innerJoin('farms', 'farms.id', 'inventory.farm_id')
      .innerJoin('farm_market_rels', (join) =>
        join
          .onRef('farm_market_rels.farm_id', '=', 'farms.id')
          .on('farm_market_rels.market_id', '=', input.market_id as string)
      )
      .select([
        'inventory.id',
        'products.name as product_name',
        'products.category',
        'farms.name as farm_name',
        'inventory.remaining',
        'products.unit',
        'inventory.price',
        'inventory.harvest_date',
      ])
      .where('inventory.status', 'in', ['available', 'partial'])
      .where('inventory.remaining', '>', 0)
      .where('farm_market_rels.active', '=', true)
      .orderBy('products.category')
      .orderBy('inventory.harvest_date', 'desc')
      .execute();

    return { count: inventory.length, available_inventory: inventory };
  }

  return { error: 'Provide either farm_id or market_id' };
}
