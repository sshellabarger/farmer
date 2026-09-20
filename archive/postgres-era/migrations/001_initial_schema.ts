import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Enable extensions
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "postgis"`.execute(db);

  // ── Custom enum types ─────────────────────────────────────────
  await sql`CREATE TYPE user_role AS ENUM ('farmer', 'market', 'admin')`.execute(db);
  await sql`CREATE TYPE market_type AS ENUM ('grocery', 'restaurant', 'co-op', 'farmers_market')`.execute(db);
  await sql`CREATE TYPE delivery_pref AS ENUM ('pickup', 'delivery', 'either')`.execute(db);
  await sql`CREATE TYPE inventory_status AS ENUM ('available', 'partial', 'reserved', 'sold')`.execute(db);
  await sql`CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'in_transit', 'delivered', 'cancelled')`.execute(db);
  await sql`CREATE TYPE recurring_frequency AS ENUM ('daily', 'twice_weekly', 'weekly', 'biweekly', 'monthly')`.execute(db);
  await sql`CREATE TYPE delivery_type AS ENUM ('pickup', 'delivery')`.execute(db);
  await sql`CREATE TYPE delivery_status AS ENUM ('scheduled', 'in_transit', 'completed', 'failed')`.execute(db);
  await sql`CREATE TYPE conversation_context AS ENUM ('inventory', 'order', 'delivery', 'general')`.execute(db);
  await sql`CREATE TYPE message_direction AS ENUM ('inbound', 'outbound')`.execute(db);
  await sql`CREATE TYPE message_source AS ENUM ('sms', 'web', 'system')`.execute(db);
  await sql`CREATE TYPE notification_type AS ENUM ('new_inventory', 'price_change', 'order_update', 'reminder')`.execute(db);
  await sql`CREATE TYPE notification_channel AS ENUM ('sms', 'email', 'push')`.execute(db);
  await sql`CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'delivered', 'failed')`.execute(db);

  // ── 1. users ──────────────────────────────────────────────────
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('phone', 'varchar(20)', (col) => col.notNull().unique())
    .addColumn('email', 'varchar(255)')
    .addColumn('role', sql`user_role`, (col) => col.notNull())
    .addColumn('preferences', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // ── 2. farms ──────────────────────────────────────────────────
  await db.schema
    .createTable('farms')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('location', 'varchar(255)', (col) => col.notNull())
    .addColumn('coordinates', sql`geometry(Point, 4326)`)
    .addColumn('specialty', 'varchar(255)')
    .addColumn('timezone', 'varchar(50)', (col) => col.notNull().defaultTo('America/Chicago'))
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_farms_user_id').on('farms').column('user_id').execute();

  // ── 3. markets ────────────────────────────────────────────────
  await db.schema
    .createTable('markets')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('location', 'varchar(255)', (col) => col.notNull())
    .addColumn('coordinates', sql`geometry(Point, 4326)`)
    .addColumn('type', sql`market_type`, (col) => col.notNull())
    .addColumn('delivery_pref', sql`delivery_pref`, (col) => col.notNull().defaultTo('either'))
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_markets_user_id').on('markets').column('user_id').execute();

  // ── 4. products ───────────────────────────────────────────────
  await db.schema
    .createTable('products')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('farm_id', 'uuid', (col) => col.notNull().references('farms.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('category', 'varchar(100)', (col) => col.notNull())
    .addColumn('unit', 'varchar(50)', (col) => col.notNull())
    .addColumn('default_price', sql`decimal(10,2)`)
    .addColumn('seasonal', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_products_farm_id').on('products').column('farm_id').execute();
  await db.schema.createIndex('idx_products_category').on('products').column('category').execute();

  // ── 5. inventory ──────────────────────────────────────────────
  await db.schema
    .createTable('inventory')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('farm_id', 'uuid', (col) => col.notNull().references('farms.id').onDelete('cascade'))
    .addColumn('product_id', 'uuid', (col) => col.notNull().references('products.id').onDelete('cascade'))
    .addColumn('quantity', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('remaining', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('price', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('harvest_date', 'date')
    .addColumn('status', sql`inventory_status`, (col) => col.notNull().defaultTo('available'))
    .addColumn('listed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz')
    .execute();

  await db.schema.createIndex('idx_inventory_farm_id').on('inventory').column('farm_id').execute();
  await db.schema.createIndex('idx_inventory_product_id').on('inventory').column('product_id').execute();
  await db.schema.createIndex('idx_inventory_status').on('inventory').column('status').execute();

  // ── 6. farm_market_rels (the priority junction table) ─────────
  await db.schema
    .createTable('farm_market_rels')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('farm_id', 'uuid', (col) => col.notNull().references('farms.id').onDelete('cascade'))
    .addColumn('market_id', 'uuid', (col) => col.notNull().references('markets.id').onDelete('cascade'))
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(99))
    .addColumn('notification_delay_min', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('delivery_preferences', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_fmr_farm_market')
    .on('farm_market_rels')
    .columns(['farm_id', 'market_id'])
    .unique()
    .execute();

  await db.schema.createIndex('idx_fmr_priority').on('farm_market_rels').columns(['farm_id', 'priority']).execute();

  // ── 7. orders ─────────────────────────────────────────────────
  // Sequence for human-readable order numbers
  await sql`CREATE SEQUENCE order_number_seq START 1000`.execute(db);

  await db.schema
    .createTable('orders')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('farm_id', 'uuid', (col) => col.notNull().references('farms.id').onDelete('cascade'))
    .addColumn('market_id', 'uuid', (col) => col.notNull().references('markets.id').onDelete('cascade'))
    .addColumn('order_number', 'varchar(20)', (col) =>
      col.notNull().unique().defaultTo(sql`'FL-' || nextval('order_number_seq')::text`)
    )
    .addColumn('status', sql`order_status`, (col) => col.notNull().defaultTo('pending'))
    .addColumn('total', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('order_date', 'date', (col) => col.notNull().defaultTo(sql`CURRENT_DATE`))
    .addColumn('notes', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_orders_farm_id').on('orders').column('farm_id').execute();
  await db.schema.createIndex('idx_orders_market_id').on('orders').column('market_id').execute();
  await db.schema.createIndex('idx_orders_status').on('orders').column('status').execute();
  await db.schema.createIndex('idx_orders_date').on('orders').column('order_date').execute();

  // ── 8. order_items ────────────────────────────────────────────
  await db.schema
    .createTable('order_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('order_id', 'uuid', (col) => col.notNull().references('orders.id').onDelete('cascade'))
    .addColumn('inventory_id', 'uuid', (col) => col.notNull().references('inventory.id'))
    .addColumn('product_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('quantity', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('unit', 'varchar(50)', (col) => col.notNull())
    .addColumn('unit_price', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('line_total', sql`decimal(10,2)`, (col) => col.notNull())
    .execute();

  await db.schema.createIndex('idx_order_items_order').on('order_items').column('order_id').execute();

  // ── 9. recurring_orders ───────────────────────────────────────
  await db.schema
    .createTable('recurring_orders')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('farm_id', 'uuid', (col) => col.notNull().references('farms.id').onDelete('cascade'))
    .addColumn('market_id', 'uuid', (col) => col.notNull().references('markets.id').onDelete('cascade'))
    .addColumn('frequency', sql`recurring_frequency`, (col) => col.notNull())
    .addColumn('schedule_days', 'varchar(100)', (col) => col.notNull())
    .addColumn('next_delivery', 'date', (col) => col.notNull())
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // ── 10. recurring_order_items ─────────────────────────────────
  await db.schema
    .createTable('recurring_order_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('recurring_order_id', 'uuid', (col) =>
      col.notNull().references('recurring_orders.id').onDelete('cascade')
    )
    .addColumn('product_id', 'uuid', (col) => col.notNull().references('products.id'))
    .addColumn('quantity', sql`decimal(10,2)`, (col) => col.notNull())
    .addColumn('unit', 'varchar(50)', (col) => col.notNull())
    .execute();

  // ── 11. deliveries ────────────────────────────────────────────
  await db.schema
    .createTable('deliveries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('order_id', 'uuid', (col) => col.notNull().references('orders.id').onDelete('cascade').unique())
    .addColumn('type', sql`delivery_type`, (col) => col.notNull())
    .addColumn('scheduled_at', 'timestamptz', (col) => col.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('status', sql`delivery_status`, (col) => col.notNull().defaultTo('scheduled'))
    .addColumn('notes', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // ── 12. conversations ─────────────────────────────────────────
  await db.schema
    .createTable('conversations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('phone_number', 'varchar(20)', (col) => col.notNull())
    .addColumn('context', sql`conversation_context`, (col) => col.notNull().defaultTo('general'))
    .addColumn('state', 'jsonb')
    .addColumn('last_message_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_conversations_user').on('conversations').column('user_id').execute();
  await db.schema.createIndex('idx_conversations_phone').on('conversations').column('phone_number').execute();

  // ── 13. messages ──────────────────────────────────────────────
  await db.schema
    .createTable('messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade')
    )
    .addColumn('direction', sql`message_direction`, (col) => col.notNull())
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('source', sql`message_source`, (col) => col.notNull())
    .addColumn('ai_metadata', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_messages_conversation').on('messages').column('conversation_id').execute();

  // ── 14. notifications ─────────────────────────────────────────
  await db.schema
    .createTable('notifications')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('market_id', 'uuid', (col) => col.notNull().references('markets.id').onDelete('cascade'))
    .addColumn('inventory_id', 'uuid', (col) => col.references('inventory.id').onDelete('set null'))
    .addColumn('order_id', 'uuid', (col) => col.references('orders.id').onDelete('set null'))
    .addColumn('type', sql`notification_type`, (col) => col.notNull())
    .addColumn('channel', sql`notification_channel`, (col) => col.notNull().defaultTo('sms'))
    .addColumn('status', sql`notification_status`, (col) => col.notNull().defaultTo('pending'))
    .addColumn('scheduled_for', 'timestamptz', (col) => col.notNull())
    .addColumn('sent_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_notifications_market').on('notifications').column('market_id').execute();
  await db.schema
    .createIndex('idx_notifications_scheduled')
    .on('notifications')
    .columns(['status', 'scheduled_for'])
    .execute();

  // ── updated_at trigger ────────────────────────────────────────
  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  for (const table of ['users', 'farms', 'markets', 'orders']) {
    await sql
      .raw(
        `CREATE TRIGGER trg_${table}_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION update_updated_at()`
      )
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop tables in reverse dependency order
  const tables = [
    'notifications',
    'messages',
    'conversations',
    'deliveries',
    'recurring_order_items',
    'recurring_orders',
    'order_items',
    'orders',
    'farm_market_rels',
    'inventory',
    'products',
    'markets',
    'farms',
    'users',
  ];

  for (const table of tables) {
    await db.schema.dropTable(table).ifExists().cascade().execute();
  }

  await sql`DROP SEQUENCE IF EXISTS order_number_seq`.execute(db);

  // Drop enum types
  const enums = [
    'notification_status',
    'notification_channel',
    'notification_type',
    'message_source',
    'message_direction',
    'conversation_context',
    'delivery_status',
    'delivery_type',
    'recurring_frequency',
    'order_status',
    'inventory_status',
    'delivery_pref',
    'market_type',
    'user_role',
  ];

  for (const e of enums) {
    await sql.raw(`DROP TYPE IF EXISTS ${e}`).execute(db);
  }

  await sql`DROP FUNCTION IF EXISTS update_updated_at() CASCADE`.execute(db);
}
