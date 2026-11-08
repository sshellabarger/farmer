import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { canTransition, createMembership, feePlanInputSchema, isActiveBooth, type MembershipStatus } from '../services/producers.js';
import { currentSeason, findMembership, membershipFromData, normalizeFeePlan, SEASON_LABEL_RE } from '../services/seasons.js';
import type { FarmersMarket } from '../services/markets.js';

const MEMBERSHIP_STATUSES = ['applied', 'under_review', 'approved', 'active', 'inactive'] as const;

const spaces = z.union([z.literal(1), z.literal(2)]);

const createMembershipSchema = z.object({
  producer_id: z.string().min(1),
  market_id: z.string().min(1),
  season: z.string().regex(SEASON_LABEL_RE).optional(),
  status: z.enum(MEMBERSHIP_STATUSES).default('approved'),
  fee_plan: feePlanInputSchema.optional(),
  spaces: spaces.optional(),
  electric: z.boolean().optional(),
  pay_in_full: z.boolean().optional(),
  booth_kind: z.enum(['stall', 'food_truck']).optional(),
  usual_booth_id: z.string().nullable().optional(),
});

const updateMembershipSchema = z.object({
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  fee_plan: feePlanInputSchema.optional(),
  spaces: spaces.optional(),
  electric: z.boolean().optional(),
  pay_in_full: z.boolean().optional(),
  booth_kind: z.enum(['stall', 'food_truck']).optional(),
  usual_booth_id: z.string().nullable().optional(),
  trial_period: z.boolean().optional(),
  note: z.string().max(2000).optional(),
});

const itemsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('decline'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('add'), items: z.array(z.string().trim().min(1).max(80)).min(1).max(100) }),
]);

async function loadMarket(db: FastifyInstance['db'], id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

/** Append `items` to a list, skipping case-insensitive duplicates. */
function mergeItems(existing: string[], items: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((i) => i.toLowerCase()));
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export async function membershipRoutes(app: FastifyInstance) {
  // GET /api/memberships?market_id= | ?producer_id=  (&season=; a market's list defaults to its current season, a producer's to every season)
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const query = request.query as { market_id?: string; producer_id?: string; season?: string };

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

    let season = query.season;
    if (!season && hasMarket) {
      const market = await loadMarket(app.db, query.market_id!);
      season = currentSeason(market ?? { timezone: 'UTC' }, new Date());
    }

    let views = snapshot.docs.map((d) => membershipFromData(d.id, d.data() as Record<string, unknown>));
    if (hasProducer && scoped.role !== 'admin') views = views.filter((m) => canAccessMarket(scoped, m.market_id));
    if (season && season !== 'all') views = views.filter((m) => m.season === season);

    const memberships = await Promise.all(
      views.map(async (m) => {
        const producerDoc = await app.db.collection('producers').doc(m.producer_id).get();
        const producerData = producerDoc.data();
        return { ...m, producer: { id: m.producer_id, business_name: producerData?.business_name ?? '' } };
      }),
    );

    return { memberships };
  });

  // POST /api/memberships
  app.post('/', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const parsed = createMembershipSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]!.message });
    const input = parsed.data;
    const user = request.authUser!;

    const producerDoc = await app.db.collection('producers').doc(input.producer_id).get();
    if (!producerDoc.exists) return reply.status(404).send({ error: 'Producer not found' });
    const market = await loadMarket(app.db, input.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const now = new Date();
    const season = input.season ?? currentSeason(market, now);
    if (input.usual_booth_id && !(await isActiveBooth(app.db, market.id, input.usual_booth_id))) {
      return reply.status(400).send({ error: 'usual_booth_id must be an active booth of this market' });
    }

    const existing = await findMembership(app.db, input.producer_id, input.market_id, season);
    if (existing) return reply.status(409).send({ error: `Membership already exists for ${season}`, membership_id: existing.id });

    const created = await createMembership(
      app.db,
      {
        producer_id: input.producer_id,
        market_id: input.market_id,
        season,
        status: input.status,
        fee_plan: normalizeFeePlan(input.fee_plan),
        spaces: input.spaces ?? 1,
        electric: input.electric ?? false,
        pay_in_full: input.pay_in_full ?? false,
        booth_kind: input.booth_kind ?? 'stall',
        usual_booth_id: input.usual_booth_id ?? null,
        trial_period: false,
        approved_items: [],
        application_id: null,
        source: 'admin',
        actor: user.id,
        note: null,
      },
      now,
    );
    if (!created.created) return reply.status(409).send({ error: `Membership already exists for ${season}`, membership_id: created.id });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'membership.create',
      target: { collection: 'producer_memberships', id: created.id },
      after: created.doc,
    });

    return reply.status(201).send({ membership: membershipFromData(created.id, created.doc) });
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
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]!.message });
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
    if (input.fee_plan !== undefined) updates.fee_plan = normalizeFeePlan(input.fee_plan);
    if (input.spaces !== undefined) updates.spaces = input.spaces;
    if (input.electric !== undefined) updates.electric = input.electric;
    if (input.pay_in_full !== undefined) updates.pay_in_full = input.pay_in_full;
    if (input.booth_kind !== undefined) updates.booth_kind = input.booth_kind;
    if (input.trial_period !== undefined) updates.trial_period = input.trial_period;
    if (input.usual_booth_id !== undefined) {
      if (input.usual_booth_id !== null && !(await isActiveBooth(app.db, before.market_id as string, input.usual_booth_id))) {
        return reply.status(400).send({ error: 'usual_booth_id must be an active booth of this market' });
      }
      updates.usual_booth_id = input.usual_booth_id;
    }

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

    return { membership: membershipFromData(doc.id, after as Record<string, unknown>) };
  });

  // POST /api/memberships/:id/items — approve / decline a vendor's request to add products, or add items directly
  app.post<{ Params: { id: string } }>('/:id/items', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;

    const ref = app.db.collection('producer_memberships').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Membership not found' });
    const stored = doc.data() as Record<string, unknown>;
    if (!canAccessMarket(scoped, String(stored.market_id))) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = itemsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]!.message });
    const input = parsed.data;
    const view = membershipFromData(doc.id, stored);
    const now = new Date();

    let addedItems: string[] = [];
    let requests = view.item_requests;
    if (input.action === 'add') {
      addedItems = input.items;
    } else {
      const target = requests.find((r) => r.id === input.request_id);
      if (!target) return reply.status(404).send({ error: 'Item request not found' });
      if (target.status !== 'pending') return reply.status(409).send({ error: `Item request already ${target.status}` });
      requests = requests.map((r) =>
        r.id === target.id
          ? { ...r, status: input.action === 'approve' ? ('approved' as const) : ('declined' as const), decided_by: user.id, decided_at: now }
          : r,
      );
      if (input.action === 'approve') addedItems = target.items;
    }

    const approvedItems = mergeItems(view.approved_items, addedItems);
    await ref.update({ approved_items: approvedItems, item_requests: requests, updated_at: now });

    // The producer's own product list follows the approved items (type 'other' when no listed type fits).
    if (addedItems.length > 0) {
      const producerRef = app.db.collection('producers').doc(view.producer_id);
      const producerDoc = await producerRef.get();
      if (producerDoc.exists) {
        const raw = (producerDoc.data() as Record<string, unknown>).products;
        const entries: Record<string, unknown>[] = [];
        for (const p of Array.isArray(raw) ? raw : []) {
          if (typeof p === 'string') {
            entries.push({ type: 'produce', items: [p], practices: [], description: '', details: {} });
          } else if (p && typeof p === 'object') entries.push(p as Record<string, unknown>);
        }
        const other = entries.find((e) => e.type === 'other');
        if (other) other.items = mergeItems(Array.isArray(other.items) ? (other.items as unknown[]).map(String) : [], addedItems);
        else entries.push({ type: 'other', items: mergeItems([], addedItems), practices: [], description: '', details: {} });
        await producerRef.update({ products: entries, updated_at: now });
      }
    }

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'application.items.approve',
      target: { collection: 'producer_memberships', id: doc.id },
      after: { action: input.action, request_id: input.action === 'add' ? null : input.request_id, items: addedItems },
    });

    const after = (await ref.get()).data() as Record<string, unknown>;
    return { membership: membershipFromData(doc.id, after) };
  });
}
