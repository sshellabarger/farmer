import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Market scoping for staff users (SPEC §6.9): admins see every market,
 * market managers only their `assigned_market_ids`.
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte. It deliberately reads `role` as a plain string and
 * `assigned_market_ids` structurally so it compiles both before and after
 * rbac.ts adds the `market_manager` role and the new AuthUser field.
 */

export interface ScopedUser {
  role: string;
  assigned_market_ids?: string[] | null;
}

export function isStaff(user: ScopedUser | null | undefined): boolean {
  return !!user && (user.role === 'admin' || user.role === 'market_manager');
}

export function canAccessMarket(user: ScopedUser | null | undefined, marketId: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'market_manager') return false;
  return Array.isArray(user.assigned_market_ids) && user.assigned_market_ids.includes(marketId);
}

/** Markets the user may read; `null` means "all" (admin). */
export function accessibleMarketIds(user: ScopedUser | null | undefined): string[] | null {
  if (!user) return [];
  if (user.role === 'admin') return null;
  if (user.role !== 'market_manager') return [];
  return Array.isArray(user.assigned_market_ids) ? [...user.assigned_market_ids] : [];
}

export type MarketIdResolver = (request: FastifyRequest) => string | undefined | Promise<string | undefined>;

export const marketIdFromParams = (key = 'id'): MarketIdResolver =>
  (request) => (request.params as Record<string, string | undefined>)[key];

export const marketIdFromQuery = (key = 'market_id'): MarketIdResolver =>
  (request) => (request.query as Record<string, string | undefined>)[key];

/** preHandler: 401 unauthenticated, 403 unless admin or market_manager. */
export function requireStaff() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser as ScopedUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isStaff(user)) return reply.status(403).send({ error: 'Forbidden: staff only' });
  };
}

/**
 * preHandler: 401 unauthenticated, 403 for non-staff, 400 when the resolver
 * finds no market id, 403 when the market is not assigned to the manager.
 * Admins always pass once a market id is present.
 */
export function requireMarketAccess(resolve: MarketIdResolver) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser as ScopedUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isStaff(user)) return reply.status(403).send({ error: 'Forbidden: staff only' });
    const marketId = await resolve(request);
    if (!marketId) return reply.status(400).send({ error: 'market_id is required' });
    if (!canAccessMarket(user, marketId)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });
  };
}
