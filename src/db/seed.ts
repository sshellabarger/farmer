import dotenv from 'dotenv';
dotenv.config({ override: true });
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../types/schema.js';

const { Pool } = pg;

async function seed() {
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });

  console.log('🌱 Seeding database...');

  // ── Users ─────────────────────────────────────────────────────
  const [farmer1] = await db
    .insertInto('users')
    .values({ name: 'Sarah Mitchell', phone: '+15015550201', role: 'farmer' })
    .returningAll()
    .execute();

  const [farmer2] = await db
    .insertInto('users')
    .values({ name: 'Jake Rivera', phone: '+15015550202', role: 'farmer' })
    .returningAll()
    .execute();

  const [farmer3] = await db
    .insertInto('users')
    .values({ name: 'Maria Chen', phone: '+15015550203', role: 'farmer' })
    .returningAll()
    .execute();

  const [market1User] = await db
    .insertInto('users')
    .values({ name: 'Tom at ABC', phone: '+15015550101', role: 'market' })
    .returningAll()
    .execute();

  const [market2User] = await db
    .insertInto('users')
    .values({ name: 'Lisa at River Market', phone: '+15015550102', role: 'market' })
    .returningAll()
    .execute();

  const [market3User] = await db
    .insertInto('users')
    .values({ name: 'Hillcrest Co-op', phone: '+15015550103', role: 'market' })
    .returningAll()
    .execute();

  // "Both" role user — farmer + market buyer
  const [bothUser] = await db
    .insertInto('users')
    .values({ name: 'Scott Shellabarger', phone: '+15015550300', role: 'both' as any })
    .returningAll()
    .execute();

  // ── Farms ─────────────────────────────────────────────────────
  const [farm1] = await db
    .insertInto('farms')
    .values({
      user_id: farmer1.id,
      name: 'Green Acres Farm',
      location: 'Scott, AR',
      specialty: 'Heirloom Vegetables',
      timezone: 'America/Chicago',
    })
    .returningAll()
    .execute();

  const [farm2] = await db
    .insertInto('farms')
    .values({
      user_id: farmer2.id,
      name: 'Riverside Berries',
      location: 'Cabot, AR',
      specialty: 'Berries & Stone Fruit',
      timezone: 'America/Chicago',
    })
    .returningAll()
    .execute();

  const [farm3] = await db
    .insertInto('farms')
    .values({
      user_id: farmer3.id,
      name: 'Ozark Greens Co-op',
      location: 'Conway, AR',
      specialty: 'Greens & Herbs',
      timezone: 'America/Chicago',
    })
    .returningAll()
    .execute();

  const [farm4] = await db
    .insertInto('farms')
    .values({
      user_id: bothUser.id,
      name: 'Shellabarger Family Farm',
      location: 'Little Rock, AR',
      specialty: 'Organic Heirloom Produce',
      timezone: 'America/Chicago',
    })
    .returningAll()
    .execute();

  // ── Markets ───────────────────────────────────────────────────
  const [mkt1] = await db
    .insertInto('markets')
    .values({
      user_id: market1User.id,
      name: 'ABC Market',
      location: 'Little Rock, AR',
      type: 'grocery',
      delivery_pref: 'pickup',
    })
    .returningAll()
    .execute();

  const [mkt2] = await db
    .insertInto('markets')
    .values({
      user_id: market2User.id,
      name: 'River Market',
      location: 'Little Rock, AR',
      type: 'farmers_market',
      delivery_pref: 'delivery',
    })
    .returningAll()
    .execute();

  const [mkt3] = await db
    .insertInto('markets')
    .values({
      user_id: market3User.id,
      name: 'Hillcrest Co-op',
      location: 'Little Rock, AR',
      type: 'co-op',
      delivery_pref: 'delivery',
    })
    .returningAll()
    .execute();

  const [mkt4] = await db
    .insertInto('markets')
    .values({
      user_id: bothUser.id,
      name: 'The Farm Stand',
      location: 'Little Rock, AR',
      type: 'farmers_market',
      delivery_pref: 'either',
    })
    .returningAll()
    .execute();

  // ── Farm-Market Relationships (with priority system) ──────────
  await db
    .insertInto('farm_market_rels')
    .values([
      { farm_id: farm1.id, market_id: mkt1.id, priority: 1, notification_delay_min: 0 },
      { farm_id: farm1.id, market_id: mkt2.id, priority: 2, notification_delay_min: 30 },
      { farm_id: farm1.id, market_id: mkt3.id, priority: 3, notification_delay_min: 60 },
      { farm_id: farm2.id, market_id: mkt2.id, priority: 1, notification_delay_min: 0 },
      { farm_id: farm2.id, market_id: mkt1.id, priority: 2, notification_delay_min: 30 },
      { farm_id: farm3.id, market_id: mkt3.id, priority: 1, notification_delay_min: 0 },
      { farm_id: farm3.id, market_id: mkt1.id, priority: 2, notification_delay_min: 30 },
      // Scott's farm sells to all 3 markets + his own stand buys from other farms
      { farm_id: farm4.id, market_id: mkt1.id, priority: 1, notification_delay_min: 0 },
      { farm_id: farm4.id, market_id: mkt2.id, priority: 2, notification_delay_min: 15 },
      { farm_id: farm4.id, market_id: mkt4.id, priority: 1, notification_delay_min: 0 },
      { farm_id: farm1.id, market_id: mkt4.id, priority: 2, notification_delay_min: 15 },
      { farm_id: farm2.id, market_id: mkt4.id, priority: 3, notification_delay_min: 30 },
    ])
    .execute();

  // ── Products ──────────────────────────────────────────────────
  const [tomatoes] = await db
    .insertInto('products')
    .values({ farm_id: farm1.id, name: 'Cherokee Purple Tomatoes', category: 'Vegetables', unit: 'lb', default_price: 2.99 })
    .returningAll()
    .execute();

  const [peppers] = await db
    .insertInto('products')
    .values({ farm_id: farm1.id, name: 'Mixed Sweet Peppers', category: 'Vegetables', unit: 'lb', default_price: 3.49 })
    .returningAll()
    .execute();

  const [basil] = await db
    .insertInto('products')
    .values({ farm_id: farm1.id, name: 'Fresh Basil', category: 'Herbs', unit: 'bunch', default_price: 2.50 })
    .returningAll()
    .execute();

  const [blueberries] = await db
    .insertInto('products')
    .values({ farm_id: farm2.id, name: 'Organic Blueberries', category: 'Fruits', unit: 'pint', default_price: 5.99 })
    .returningAll()
    .execute();

  const [kale] = await db
    .insertInto('products')
    .values({ farm_id: farm3.id, name: 'Lacinato Kale', category: 'Greens', unit: 'bunch', default_price: 3.00 })
    .returningAll()
    .execute();

  // Scott's products
  const [heirloomTomatoes] = await db
    .insertInto('products')
    .values({ farm_id: farm4.id, name: 'Heirloom Tomato Mix', category: 'Vegetables', unit: 'lb', default_price: 4.50 })
    .returningAll()
    .execute();

  const [sweetCorn] = await db
    .insertInto('products')
    .values({ farm_id: farm4.id, name: 'Sweet Corn', category: 'Vegetables', unit: 'dozen', default_price: 6.00 })
    .returningAll()
    .execute();

  const [honeycomb] = await db
    .insertInto('products')
    .values({ farm_id: farm4.id, name: 'Raw Honeycomb', category: 'Honey', unit: 'lb', default_price: 12.00 })
    .returningAll()
    .execute();

  // ── Inventory ─────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];

  await db
    .insertInto('inventory')
    .values([
      { farm_id: farm1.id, product_id: tomatoes.id, quantity: 100, remaining: 60, price: 2.99, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm1.id, product_id: peppers.id, quantity: 75, remaining: 75, price: 3.49, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm1.id, product_id: basil.id, quantity: 40, remaining: 40, price: 2.50, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm2.id, product_id: blueberries.id, quantity: 200, remaining: 145, price: 5.99, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm3.id, product_id: kale.id, quantity: 60, remaining: 60, price: 3.00, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm4.id, product_id: heirloomTomatoes.id, quantity: 80, remaining: 65, price: 4.50, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm4.id, product_id: sweetCorn.id, quantity: 30, remaining: 30, price: 6.00, harvest_date: new Date(today), status: 'available' },
      { farm_id: farm4.id, product_id: honeycomb.id, quantity: 15, remaining: 12, price: 12.00, harvest_date: new Date(today), status: 'available' },
    ])
    .execute();

  console.log('✅ Seed complete!');
  console.log(`   4 farms (incl. 1 "both"), 4 markets, 12 relationships, 8 products, 8 inventory listings`);
  await db.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
