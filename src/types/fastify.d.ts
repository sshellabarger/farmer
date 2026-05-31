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
  }
}
