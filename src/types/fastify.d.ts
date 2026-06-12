import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import type { AuthUser } from '../middleware/rbac.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Firestore;
    env: Env;
  }

  interface FastifyRequest {
    authUser?: AuthUser;
    // Exact request bytes, captured by the webhook routes' preParsing hook so
    // signatures can be verified against what the provider actually signed.
    rawBody?: Buffer;
  }
}
