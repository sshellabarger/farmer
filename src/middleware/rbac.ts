import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../utils/jwt.js';
import type { UserRole } from '../types/schema.js';

export interface AuthUser {
  id: string;
  name: string | null;
  role: UserRole;
  phone: string | null;
}

/**
 * Bearer-JWT authentication. One Firestore read per request (the user doc);
 * the v1 farm/market lookups are gone (decision D3 defers the producers
 * migration, and nothing that survives needs them).
 */
export function authenticate(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const payload = verifyJwt(authHeader.slice(7), app.env.JWT_SECRET);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const userDoc = await app.db.collection('users').doc(payload.sub).get();
    if (!userDoc.exists) {
      return reply.status(401).send({ error: 'User not found' });
    }
    const user = userDoc.data()!;

    request.authUser = {
      id: userDoc.id,
      name: (user.name as string) ?? null,
      role: user.role as UserRole,
      phone: (user.phone as string) ?? null,
    };
  };
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;
    // v1 'both' users (farmer + buyer) still exist in `users` until the D3
    // migration; treat them as either legacy role.
    if (user.role === 'both' && (roles.includes('farmer') || roles.includes('market'))) return;
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}
