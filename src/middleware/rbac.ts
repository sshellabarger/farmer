import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../utils/jwt.js';
import type { UserRole } from '../types/schema.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  farmId: string | null;
  marketId: string | null;
}

/**
 * Authenticate a request by verifying the JWT and loading the user's
 * farm/market associations. Attaches `request.authUser` on success.
 * Returns a preHandler hook function bound to the given Fastify app.
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

    const user = await app.db
      .selectFrom('users')
      .select(['id', 'role'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();

    if (!user) {
      return reply.status(401).send({ error: 'User not found' });
    }

    const farm = await app.db
      .selectFrom('farms')
      .select(['id'])
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    const market = await app.db
      .selectFrom('markets')
      .select(['id'])
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    request.authUser = {
      id: user.id,
      role: user.role as UserRole,
      farmId: farm?.id ?? null,
      marketId: market?.id ?? null,
    };
  };
}

/**
 * Require the authenticated user to have one of the given roles.
 * Must be used after `authenticate`.
 */
export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    // Admin can do anything
    if (user.role === 'admin') return;
    // "both" role matches either farmer or market
    if (user.role === 'both' && (roles.includes('farmer') || roles.includes('market'))) return;
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}

/**
 * Require that the authenticated user owns the farm referenced
 * by :id in the route params. Admins are always allowed.
 */
export function requireFarmOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const farmId = (request.params as any).id;
    if (!farmId) return; // no :id param, skip

    // Check the farm is owned by this user
    const farm = await app.db
      .selectFrom('farms')
      .select(['user_id'])
      .where('id', '=', farmId)
      .executeTakeFirst();

    if (!farm) return reply.notFound('Farm not found');
    if (farm.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this farm' });
    }
  };
}

/**
 * Require that the authenticated user owns the market referenced
 * by :id in the route params. Admins are always allowed.
 */
export function requireMarketOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const marketId = (request.params as any).id;
    if (!marketId) return;

    const market = await app.db
      .selectFrom('markets')
      .select(['user_id'])
      .where('id', '=', marketId)
      .executeTakeFirst();

    if (!market) return reply.notFound('Market not found');
    if (market.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this market' });
    }
  };
}

/**
 * For inventory mutations (POST/PUT/DELETE): require that the authenticated
 * user owns the farm associated with the inventory item.
 * - POST: checks `farm_id` from request body
 * - PUT/DELETE: looks up the inventory record's farm_id from DB
 * Admins are always allowed.
 */
export function requireInventoryFarmOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    let farmId: string | undefined;

    if (request.method === 'POST') {
      // POST body contains farm_id
      farmId = (request.body as any)?.farm_id;
    } else {
      // PUT/DELETE: look up the inventory item's farm
      const invId = (request.params as any).id;
      if (invId) {
        const inv = await app.db
          .selectFrom('inventory')
          .select(['farm_id'])
          .where('id', '=', invId)
          .executeTakeFirst();

        if (!inv) return reply.notFound('Inventory not found');
        farmId = inv.farm_id;
      }
    }

    if (!farmId) {
      return reply.status(400).send({ error: 'Missing farm reference' });
    }

    // Verify the farm belongs to this user
    const farm = await app.db
      .selectFrom('farms')
      .select(['user_id'])
      .where('id', '=', farmId)
      .executeTakeFirst();

    if (!farm) return reply.notFound('Farm not found');
    if (farm.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this farm' });
    }
  };
}

/**
 * For order routes: require that the authenticated user is either:
 * - the farm party on the order (farmer)
 * - the market party on the order (market)
 * - an admin
 */
export function requireOrderParty(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const orderId = (request.params as any).id;
    if (!orderId) return; // list endpoint, handled by query filtering

    const order = await app.db
      .selectFrom('orders')
      .select(['farm_id', 'market_id'])
      .where('id', '=', orderId)
      .executeTakeFirst();

    if (!order) return reply.notFound('Order not found');

    const isOwner =
      (user.farmId && order.farm_id === user.farmId) ||
      (user.marketId && order.market_id === user.marketId);

    if (!isOwner) {
      return reply.status(403).send({ error: 'Forbidden: you are not a party to this order' });
    }
  };
}

/**
 * For POST /orders: require that the user is the market placing the order
 * or the farm fulfilling it (or admin).
 */
export function requireOrderCreateParty(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const body = request.body as any;
    const farmId = body?.farm_id;
    const marketId = body?.market_id;

    const isOwner =
      (user.farmId && farmId === user.farmId) ||
      (user.marketId && marketId === user.marketId);

    if (!isOwner) {
      return reply.status(403).send({ error: 'Forbidden: you are not a party to this order' });
    }
  };
}
