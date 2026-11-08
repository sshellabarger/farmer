import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import type { AuthUser } from '../middleware/rbac.js';
import type { StoragePort } from '../services/storage-port.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Firestore;
    env: Env;
    /** Phase 4: object storage for application uploads (real bucket by default, fake in tests). */
    storage: StoragePort;
  }

  interface FastifyRequest {
    authUser?: AuthUser;
    // Exact request bytes, captured by the webhook routes' preParsing hook so
    // signatures can be verified against what the provider actually signed.
    rawBody?: Buffer;
  }
}
