import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../utils/jwt.js';
import type { UserRole } from '../types/schema.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  phone: string | null;
  farmId: string | null;
  marketId: string | null;
}

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

    const farmSnap = await app.db.collection('farms').where('user_id', '==', payload.sub).limit(1).get();
    const marketSnap = await app.db.collection('markets').where('user_id', '==', payload.sub).limit(1).get();

    request.authUser = {
      id: userDoc.id,
      role: user.role as UserRole,
      phone: (user.phone as string) ?? null,
      farmId: farmSnap.empty ? null : farmSnap.docs[0].id,
      marketId: marketSnap.empty ? null : marketSnap.docs[0].id,
    };
  };
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;
    if (user.role === 'both' && (roles.includes('farmer') || roles.includes('market'))) return;
    if (!roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}

export function requireFarmOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const farmId = (request.params as any).id;
    if (!farmId) return;

    const farmDoc = await app.db.collection('farms').doc(farmId).get();
    if (!farmDoc.exists) return reply.notFound('Farm not found');
    if (farmDoc.data()!.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this farm' });
    }
  };
}

export function requireMarketOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const marketId = (request.params as any).id;
    if (!marketId) return;

    const marketDoc = await app.db.collection('markets').doc(marketId).get();
    if (!marketDoc.exists) return reply.notFound('Market not found');
    if (marketDoc.data()!.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this market' });
    }
  };
}

export function requireInventoryFarmOwner(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    let farmId: string | undefined;

    if (request.method === 'POST') {
      farmId = (request.body as any)?.farm_id;
    } else {
      const invId = (request.params as any).id;
      if (invId) {
        const invDoc = await app.db.collection('inventory').doc(invId).get();
        if (!invDoc.exists) return reply.notFound('Inventory not found');
        farmId = invDoc.data()!.farm_id;
      }
    }

    if (!farmId) return reply.status(400).send({ error: 'Missing farm reference' });

    const farmDoc = await app.db.collection('farms').doc(farmId).get();
    if (!farmDoc.exists) return reply.notFound('Farm not found');
    if (farmDoc.data()!.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden: you do not own this farm' });
    }
  };
}

export function requireOrderParty(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const orderId = (request.params as any).id;
    if (!orderId) return;

    const orderDoc = await app.db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return reply.notFound('Order not found');
    const order = orderDoc.data()!;

    const isOwner =
      (user.farmId && order.farm_id === user.farmId) ||
      (user.marketId && order.market_id === user.marketId);

    if (!isOwner) {
      return reply.status(403).send({ error: 'Forbidden: you are not a party to this order' });
    }
  };
}

export function requireOrderCreateParty(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (user.role === 'admin') return;

    const body = request.body as any;
    const isOwner =
      (user.farmId && body?.farm_id === user.farmId) ||
      (user.marketId && body?.market_id === user.marketId);

    if (!isOwner) {
      return reply.status(403).send({ error: 'Forbidden: you are not a party to this order' });
    }
  };
}
