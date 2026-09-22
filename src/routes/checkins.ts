import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { byDateDesc } from '../utils/sort.js';

/** Check-in reads only in Phase 2 — the check-in form ships in Phase 3. */
export async function checkinRoutes(app: FastifyInstance) {
  // GET /api/checkins?market_date_id= | ?producer_id=
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const query = request.query as { market_date_id?: string; producer_id?: string };

    const hasDate = !!query.market_date_id;
    const hasProducer = !!query.producer_id;
    if (hasDate === hasProducer) {
      return reply.status(400).send({ error: 'Provide exactly one of market_date_id or producer_id' });
    }

    let dbQuery: FirebaseFirestore.Query = app.db.collection('checkins');
    dbQuery = hasDate
      ? dbQuery.where('market_date_id', '==', query.market_date_id)
      : dbQuery.where('producer_id', '==', query.producer_id);
    const snapshot = await dbQuery.get();

    const isAdmin = scoped.role === 'admin';
    let docs = snapshot.docs;
    if (!isAdmin) {
      docs = docs.filter((d) => canAccessMarket(scoped, d.data().market_id as string));
    }

    const checkins = docs.map((d) => {
      const data = d.data();
      const result: Record<string, unknown> = { id: d.id, ...data };
      if (!isAdmin) {
        delete result.estimated_sales;
        delete result.raw_import;
      }
      return result;
    });

    return { checkins: byDateDesc(checkins, 'submitted_at') };
  });
}
