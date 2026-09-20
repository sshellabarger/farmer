import dotenv from 'dotenv';
dotenv.config({ override: true });
import pg from 'pg';
import { Kysely, PostgresDialect, Migrator, FileMigrationProvider } from 'kysely';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  const direction = process.argv[2];

  if (direction === 'down') {
    const { error, results } = await migrator.migrateDown();
    results?.forEach((r) => {
      console.log(`⬇ ${r.migrationName}: ${r.status}`);
    });
    if (error) {
      console.error('Migration down failed:', error);
      process.exit(1);
    }
  } else {
    const { error, results } = await migrator.migrateToLatest();
    results?.forEach((r) => {
      console.log(`⬆ ${r.migrationName}: ${r.status}`);
    });
    if (error) {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  }

  await db.destroy();
  console.log('Done.');
}

run();
