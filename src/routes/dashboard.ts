import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/rbac.js';
import { requireStaff, accessibleMarketIds } from '../middleware/market-scope.js';
import type { FarmersMarket } from '../services/markets.js';
import type { MarketDateDoc } from '../services/market-dates.js';

async function marketDateDocs(db: FastifyInstance['db'], marketId: string): Promise<MarketDateDoc[]> {
  const snap = await db.collection('market_dates').where('market_id', '==', marketId).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as MarketDateDoc);
}

async function marketProgress(db: FastifyInstance['db'], marketId: string, marketDateId: string) {
  const membershipsSnap = await db.collection('producer_memberships').where('market_id', '==', marketId).get();
  const activeMemberships = membershipsSnap.docs.filter((d) => (d.data() as Record<string, unknown>).status === 'active').length;
  const checkinsSnap = await db.collection('checkins').where('market_date_id', '==', marketDateId).get();
  const checkins = checkinsSnap.docs.length;
  const percent = activeMemberships > 0 ? Math.round((checkins / activeMemberships) * 100) : 0;
  return { active_memberships: activeMemberships, checkins, percent };
}

/**
 * GET /api/dashboard — staff. Filtered by `accessibleMarketIds` (admins see
 * every market, market managers only their assigned ones).
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request) => {
    const user = request.authUser!;
    const accessible = accessibleMarketIds(user);
    const now = new Date();

    const snap = await app.db.collection('farmers_markets').get();
    let allMarkets = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as FarmersMarket);
    if (accessible !== null) allMarkets = allMarkets.filter((m) => accessible.includes(m.id));

    const cards = [];
    for (const market of allMarkets) {
      const dates = await marketDateDocs(app.db, market.id);
      const upcoming = dates.filter((d) => d.status !== 'cancelled' && d.start_at.getTime() >= now.getTime());
      upcoming.sort((a, b) => a.start_at.getTime() - b.start_at.getTime());
      const next_date = upcoming[0] ?? null;

      const collectingWindowMin = market.workflow.deadline_offset_min + 1440;
      const past = dates.filter(
        (d) =>
          d.status !== 'cancelled' &&
          d.end_at.getTime() <= now.getTime() &&
          now.getTime() - d.end_at.getTime() <= collectingWindowMin * 60_000,
      );
      past.sort((a, b) => b.end_at.getTime() - a.end_at.getTime());
      const collecting_date = past[0] ?? null;

      const progress = collecting_date ? await marketProgress(app.db, market.id, collecting_date.id) : null;

      cards.push({
        market: { id: market.id, name: market.name, timezone: market.timezone, active: market.active },
        next_date,
        collecting_date,
        progress,
        upcoming_count: upcoming.length,
      });
    }

    return { generated_at: now, markets: cards };
  });
}
