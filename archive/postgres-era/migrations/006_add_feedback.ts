import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  // Create enum types
  await sql`CREATE TYPE feedback_type AS ENUM ('feature_request', 'bug_report')`.execute(db);
  await sql`CREATE TYPE feedback_status AS ENUM ('open', 'under_review', 'planned', 'in_progress', 'resolved', 'closed')`.execute(db);
  await sql`CREATE TYPE feedback_priority AS ENUM ('low', 'medium', 'high', 'critical')`.execute(db);

  await db.schema
    .createTable('feedback')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('type', sql`feedback_type`, (col) => col.notNull())
    .addColumn('status', sql`feedback_status`, (col) => col.notNull().defaultTo('open'))
    .addColumn('priority', sql`feedback_priority`, (col) => col.defaultTo('medium'))
    .addColumn('title', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('admin_notes', 'text')
    .addColumn('source', sql`message_source`, (col) => col.notNull().defaultTo('web'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Index for listing by user
  await db.schema
    .createIndex('idx_feedback_user_id')
    .on('feedback')
    .column('user_id')
    .execute();

  // Index for admin filtering by status
  await db.schema
    .createIndex('idx_feedback_status')
    .on('feedback')
    .column('status')
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('feedback').execute();
  await sql`DROP TYPE IF EXISTS feedback_priority`.execute(db);
  await sql`DROP TYPE IF EXISTS feedback_status`.execute(db);
  await sql`DROP TYPE IF EXISTS feedback_type`.execute(db);
}
