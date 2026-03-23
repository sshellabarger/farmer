import type { Kysely } from 'kysely';
import type { DB } from './schema.js';
import type { Env } from '../config/env.js';
import type { AuthUser } from '../middleware/rbac.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<DB>;
    env: Env;
  }

  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
