import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../types/schema.js';

const { Pool } = pg;

let db: Kysely<DB> | null = null;

export function getDb(databaseUrl: string): Kysely<DB> {
  if (!db) {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: databaseUrl }),
      }),
    });
  }
  return db;
}
