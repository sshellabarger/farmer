import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  // Add delivery schedule to farms (e.g., [{ day: "monday", time_window: "6am-10am", areas: ["Scott", "Little Rock"] }])
  await db.schema
    .alterTable('farms')
    .addColumn('delivery_schedule', 'jsonb', (col) => col.defaultTo(sql`'[]'::jsonb`))
    .execute();

  // Add delivery preference fields to orders
  await db.schema
    .alterTable('orders')
    .addColumn('delivery_type', sql`delivery_type`)
    .addColumn('scheduled_delivery_at', 'timestamptz')
    .addColumn('delivery_notes', 'text')
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('farms').dropColumn('delivery_schedule').execute();
  await db.schema
    .alterTable('orders')
    .dropColumn('delivery_type')
    .dropColumn('scheduled_delivery_at')
    .dropColumn('delivery_notes')
    .execute();
}
