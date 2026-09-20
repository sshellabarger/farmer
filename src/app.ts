import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from './config/env.js';
import { serializeTimestamps } from './utils/serialize.js';
import { createErrorHandler } from './utils/http-error-handler.js';
import { smsRoutes } from './routes/sms.js';
import { authRoutes } from './routes/auth.js';
import { uploadRoutes } from './routes/uploads.js';
import { profileRoutes } from './routes/profile.js';
import { feedbackRoutes } from './routes/feedback.js';
import { inviteRoutes } from './routes/invite.js';
import { pushRoutes } from './routes/push.js';
import { errorRoutes } from './routes/errors.js';
import { reminderRoutes } from './routes/reminders.js';
import { adminRoutes } from './routes/admin.js';

export interface BuildAppOptions {
  db: Firestore;
  env: Env;
  /** Pino log level. Defaults to 'info'. */
  logLevel?: string;
  /**
   * Whether 5xx errors page the alert channels. The Cloud Functions entrypoint
   * always notifies; the local dev runner only does so in production.
   */
  notifyOnError?: boolean;
}

/**
 * Builds the Fastify application shared by the Cloud Functions entrypoint
 * (`src/functions.ts`) and the local dev runner (`src/server.ts`), so the
 * plugin setup, hooks and route list can never drift between the two.
 *
 * The returned instance is NOT yet `ready()`; callers await that (or
 * `listen()`) themselves.
 */
export async function buildApp({ db, env, logLevel = 'info', notifyOnError = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: logLevel } });

  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.ip,
  });

  app.decorate('db', db);
  app.decorate('env', env);

  // Convert Firestore Timestamps to ISO strings in all JSON responses.
  app.addHook('preSerialization', async (_req: FastifyRequest, _reply: FastifyReply, payload: unknown) => serializeTimestamps(payload));

  // Global error handler — any unhandled route error gets logged, alerted
  // (text + email with AI-researched fix), and returned as a clean 500.
  // Zod validation failures come back as 400s without alerting.
  // Must be set BEFORE the route registrations below: each awaited register()
  // boots immediately and its routes keep whatever error handler existed at
  // that moment, so a handler set afterwards never applies to them.
  app.setErrorHandler(createErrorHandler({ env, notify: notifyOnError }));

  // Health check. Registered at both paths because the Firebase Hosting
  // rewrite only forwards /api/** to the function; /health alone is only
  // reachable on the raw function URL or the local dev server.
  const health = async () => ({ status: 'ok', timestamp: new Date().toISOString() });
  app.get('/health', health);
  app.get('/api/health', health);

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(smsRoutes, { prefix: '/api/sms' });
  await app.register(uploadRoutes, { prefix: '/api/uploads' });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(feedbackRoutes, { prefix: '/api/feedback' });
  await app.register(inviteRoutes, { prefix: '/api/invite' });
  await app.register(pushRoutes, { prefix: '/api/push' });
  await app.register(errorRoutes, { prefix: '/api/errors' });
  await app.register(reminderRoutes, { prefix: '/api/reminders' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Short view-link redirect: /api/view/:token → dashboard with a signed JWT
  app.get('/api/view/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    if (!token) return reply.status(404).send('Not found.');
    const doc = await db.collection('view_links').doc(token).get();
    if (!doc.exists) return reply.status(410).send('Link expired or invalid.');

    const data = doc.data()!;
    const expiresAt = data.expires_at?.toDate?.() || new Date(data.expires_at);
    if (expiresAt < new Date()) return reply.status(410).send('Link expired.');

    const { signJwt } = await import('./utils/jwt.js');
    const jwt = signJwt({ sub: data.userId, role: data.role }, env.JWT_SECRET);
    const page = data.role === 'market' ? 'market' : 'farmer';
    return reply.redirect(`/${page}?token=${jwt}&tab=${data.tab}`);
  });

  return app;
}
