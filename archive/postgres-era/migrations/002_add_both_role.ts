import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'both'`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // PostgreSQL does not support removing enum values.
  // This is a no-op — 'both' will remain in the enum even after rollback.
}
