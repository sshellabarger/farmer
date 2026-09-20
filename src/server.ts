// Local development runner. Production runs the same app inside the `api`
// Cloud Function (src/functions.ts); both build it with buildApp() so the
// plugin/route setup cannot drift.
import { getEnv } from './config/env.js';
import { getDb } from './db/firestore.js';
import { buildApp } from './app.js';

async function start() {
  const env = getEnv();
  const db = getDb();

  const app = await buildApp({
    db,
    env,
    logLevel: env.NODE_ENV === 'production' ? 'info' : 'debug',
    // Alerts stay off outside production so local dev errors don't text/email
    // the alert channels.
    notifyOnError: env.NODE_ENV === 'production',
  });

  await app.listen({ port: env.LOCAL_PORT, host: env.HOST });
  console.log(`FarmLink API running on ${env.HOST}:${env.LOCAL_PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
