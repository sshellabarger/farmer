import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  // Add profile fields to users
  await db.schema
    .alterTable('users')
    .addColumn('logo_url', 'text')
    .execute();

  // Add profile fields to farms
  await db.schema
    .alterTable('farms')
    .addColumn('phone', 'text')
    .addColumn('email', 'text')
    .addColumn('logo_url', 'text')
    .addColumn('description', 'text')
    .addColumn('physical_address', 'jsonb')
    .addColumn('billing_address', 'jsonb')
    .addColumn('contacts', 'jsonb', (col) => col.defaultTo(sql`'[]'::jsonb`))
    .execute();

  // Add profile fields to markets
  await db.schema
    .alterTable('markets')
    .addColumn('phone', 'text')
    .addColumn('email', 'text')
    .addColumn('logo_url', 'text')
    .addColumn('description', 'text')
    .addColumn('physical_address', 'jsonb')
    .addColumn('billing_address', 'jsonb')
    .addColumn('contacts', 'jsonb', (col) => col.defaultTo(sql`'[]'::jsonb`))
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('users').dropColumn('logo_url').execute();

  for (const table of ['farms', 'markets']) {
    await db.schema
      .alterTable(table)
      .dropColumn('phone')
      .dropColumn('email')
      .dropColumn('logo_url')
      .dropColumn('description')
      .dropColumn('physical_address')
      .dropColumn('billing_address')
      .dropColumn('contacts')
      .execute();
  }
}
