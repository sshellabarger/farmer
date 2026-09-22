import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { canTransition, type MembershipStatus } from '../services/producers.js';

const MEMBERSHIP_STATUSES = ['applied', 'under_review', 'approved', 'active', 'inactive'] as const;

const createMembershipSchema = z.object({
  producer_id: z.string().min(1),
  market_id: z.string().min(1),
  status: z.enum(MEMBERSHIP_STATUSES).default('approved'),
  fee_plan: z.enum(['weekly', 'season', 'both']).optional(),
  usual_booth_id: z.string().nullable().optional(),
});

const updateMembershipSchema = z.object({
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  fee_plan: z.enum(['weekly', 'season', 'both']).optional(),
  usual_booth_id: z.string().nullable().optional(),
  note: z.string().optional(),
});

export async function membershipRoutes(app: FastifyInstance) {
  // GET /api/memberships?market_id= | ?producer_id=
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const query = request.query as { market_id?: string; producer_id?: string };

    const hasMarket = !!query.market_id;
    const hasProducer = !!query.producer_id;
    if (hasMarket === hasProducer) {
      return reply.status(400).send({ error: 'Provide exactly one of market_id or producer_id' });
    }

    if (hasMarket && !canAccessMarket(scoped, query.market_id!)) {
      return reply.status(403).send({ error: 'Forbidden: market not assigned' });
    }

    let query_: FirebaseFirestore.Query = app.db.collection('producer_memberships');
    query_ = hasMarket
      ? query_.where('market_id', '==', query.market_id)
      : query_.where('producer_id', '==', query.producer_id);
    const snapshot = await query_.get();

    let docs = snapshot.docs;
    if (hasProducer && scoped.role !== 'admin') {
      docs = docs.filter((d) => canAccessMarket(scoped, d.data().market_id as string));
    }

    const memberships = await Promise.all(
      docs.map(async (d) => {
        const data = d.data();
        const producerDoc = await app.db.collection('producers').doc(data.producer_id as string).get();
        const producerData = producerDoc.data();
        return {
          id: d.id,
          ...data,
          producer: { id: data.producer_id, business_name: producerData?.business_name ?? '' },
        };
      }),
    );

    return { memberships };
  });

  // POST /api/memberships
  app.post('/', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const parsed = createMembershipSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const input = parsed.data;
    const user = request.authUser!;

    const producerDoc = await app.db.collection('producers').doc(input.producer_id).get();
    if (!producerDoc.exists) return reply.status(404).send({ error: 'Producer not found' });
    const marketDoc = await app.db.collection('farmers_markets').doc(input.market_id).get();
    if (!marketDoc.exists) return reply.status(404).send({ error: 'Market not found' });

    const id = `${input.producer_id}_${input.market_id}`;
    const existing = await app.db.collection('producer_memberships').doc(id).get();
    if (existing.exists) return reply.status(409).send({ error: 'Membership already exists' });

    const now = new Date();
    const isSettled = input.status === 'approved' || input.status === 'active';
    const membership = {
      producer_id: input.producer_id,
      market_id: input.market_id,
      status: input.status,
      usual_booth_id: input.usual_booth_id ?? null,
      fee_plan: input.fee_plan ?? 'weekly',
      approved_at: isSettled ? now : null,
      approved_by: isSettled ? user.id : null,
      history: [{ from: null, to: input.status, at: now, by: user.id, note: null }],
      source: 'admin' as const,
      created_at: now,
      updated_at: now,
    };
    await app.db.collection('producer_memberships').doc(id).set(membership);
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'membership.create',
      target: { collection: 'producer_memberships', id },
      after: membership,
    });

    return reply.status(201).send({ membership: { id, ...membership } });
  });

  // PATCH /api/memberships/:id
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;

    const ref = app.db.collection('producer_memberships').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Membership not found' });
    const before = doc.data()!;

    if (!canAccessMarket(scoped, before.market_id as string)) {
      return reply.status(403).send({ error: 'Forbidden: market not assigned' });
    }

    const parsed = updateMembershipSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const input = parsed.data;

    const now = new Date();
    const updates: Record<string, unknown> = { updated_at: now };
    let action = 'membership.update';

    if (input.status !== undefined && input.status !== before.status) {
      const from = before.status as MembershipStatus;
      const to = input.status;
      if (!canTransition(from, to)) {
        return reply.status(409).send({ error: `Cannot transition membership from '${from}' to '${to}'`, from, to });
      }
      updates.status = to;
      const history = [...((before.history as unknown[] | undefined) ?? [])];
      history.push({ from, to, at: now, by: user.id, note: input.note ?? null });
      updates.history = history;
      if ((to === 'approved' || to === 'active') && !before.approved_at) {
        updates.approved_at = now;
        updates.approved_by = user.id;
      }
      action = 'membership.transition';
    }
    if (input.fee_plan !== undefined) updates.fee_plan = input.fee_plan;
    if (input.usual_booth_id !== undefined) updates.usual_booth_id = input.usual_booth_id;

    await ref.update(updates);
    const after = { ...before, ...updates };
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action,
      target: { collection: 'producer_memberships', id: doc.id },
      before: { status: before.status },
      after: { status: after.status },
    });

    return { membership: { id: doc.id, ...after } };
  });
}
