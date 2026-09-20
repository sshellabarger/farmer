import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('inventory')
    .addColumn('image_url', 'text')
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema
    .alterTable('inventory')
    .dropColumn('image_url')
    .execute();
}
