import type { FastifyInstance } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireMarketAccess, marketIdFromParams } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import {
  boothFromData,
  boothSlug,
  createBooth,
  createBoothSchema,
  listBooths,
  loadMarketDoc,
  reorderBoothsSchema,
  seedBooths,
  seedBoothsSchema,
  updateBoothSchema,
} from '../services/booths.js';
import type { BoothDoc } from '../services/booths.js';
import { listCurrentMemberships } from '../services/seasons.js';
import type { FarmersMarket } from '../services/markets.js';

/**
 * Booth setup (Phase 4 contract §3.4). Reads are staff-scoped to the market;
 * every write is admin-only and audited. A booth is never deleted — assignments
 * reference it — only retired (`active: false`).
 */

async function usualBoothInUse(db: Firestore, market: FarmersMarket, boothId: string, now: Date): Promise<boolean> {
  const { memberships } = await listCurrentMemberships(db, market, now);
  return memberships.some((m) => m.usual_booth_id === boothId);
}

export async function boothRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const marketStaff = [auth, requireMarketAccess(marketIdFromParams('id'))];
  const adminOnly = [auth, requireRole('admin')];

  // GET /api/markets/:id/booths
  app.get<{ Params: { id: string }; Querystring: { include_inactive?: string } }>('/:id/booths', { preHandler: marketStaff }, async (request, reply) => {
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    const booths = await listBooths(app.db, market.id, { includeInactive: request.query.include_inactive === 'true' });
    return { booths };
  });

  // POST /api/markets/:id/booths
  app.post<{ Params: { id: string } }>('/:id/booths', { preHandler: adminOnly }, async (request, reply) => {
    const user = request.authUser!;
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    const parsed = createBoothSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });

    const result = await createBooth(app.db, market.id, parsed.data, new Date());
    if (!result.created) return reply.status(409).send({ error: 'A booth with that label already exists in this market' });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'booth.create',
      target: { collection: 'booths', id: result.booth.id },
      after: { label: result.booth.label, row: result.booth.row, order: result.booth.order, kind: result.booth.kind, power: result.booth.power },
    });
    return reply.status(201).send({ booth: result.booth });
  });

  // POST /api/markets/:id/booths/seed
  app.post<{ Params: { id: string } }>('/:id/booths/seed', { preHandler: adminOnly }, async (request, reply) => {
    const user = request.authUser!;
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    const parsed = seedBoothsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });

    const { created, existing, booth_ids } = await seedBooths(app.db, market.id, parsed.data, new Date());
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'booth.seed',
      target: { collection: 'farmers_markets', id: market.id },
      after: { created, existing, booth_ids },
    });
    return { created, existing };
  });

  // PUT /api/markets/:id/booths/reorder
  app.put<{ Params: { id: string } }>('/:id/booths/reorder', { preHandler: adminOnly }, async (request, reply) => {
    const user = request.authUser!;
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    const parsed = reorderBoothsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });

    const all = await listBooths(app.db, market.id, { includeInactive: true });
    const known = new Set(all.map((b) => b.id));
    const seen = new Set<string>();
    for (const row of parsed.data.rows) {
      for (const id of row.booth_ids) {
        if (!known.has(id)) return reply.status(400).send({ error: `Unknown booth: ${id}` });
        if (seen.has(id)) return reply.status(400).send({ error: `Booth listed twice: ${id}` });
        seen.add(id);
      }
    }

    const now = new Date();
    const moved: { id: string; row: string; order: number }[] = [];
    for (const row of parsed.data.rows) {
      for (let i = 0; i < row.booth_ids.length; i++) {
        const id = row.booth_ids[i]!;
        await app.db.collection('booths').doc(id).update({ row: row.row, order: i + 1, updated_at: now });
        moved.push({ id, row: row.row, order: i + 1 });
      }
    }
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'booth.reorder',
      target: { collection: 'farmers_markets', id: market.id },
      after: { booths: moved },
    });
    return { booths: await listBooths(app.db, market.id) };
  });

  // PATCH /api/markets/:id/booths/:booth_id
  app.patch<{ Params: { id: string; booth_id: string } }>('/:id/booths/:booth_id', { preHandler: adminOnly }, async (request, reply) => {
    const user = request.authUser!;
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const ref = app.db.collection('booths').doc(request.params.booth_id);
    const doc = await ref.get();
    const before = doc.exists ? boothFromData(doc.id, doc.data() as Record<string, unknown>) : null;
    if (!before || before.market_id !== market.id) return reply.status(404).send({ error: 'Booth not found' });

    const parsed = updateBoothSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const input = parsed.data;
    const now = new Date();

    if (input.label !== undefined && boothSlug(input.label) !== boothSlug(before.label)) {
      const others = await listBooths(app.db, market.id, { includeInactive: true });
      if (others.some((b) => b.id !== before.id && boothSlug(b.label) === boothSlug(input.label!))) {
        return reply.status(409).send({ error: 'A booth with that label already exists in this market' });
      }
    }
    if (input.active === false && before.active && (await usualBoothInUse(app.db, market, before.id, now))) {
      return reply.status(409).send({ error: 'A vendor lists this booth as their usual booth; change theirs first' });
    }

    const update: Record<string, unknown> = { updated_at: now };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) update[k] = v;
    await ref.update(update);

    const after: BoothDoc = boothFromData(doc.id, { ...(doc.data() as Record<string, unknown>), ...update });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'booth.update',
      target: { collection: 'booths', id: before.id },
      before: { label: before.label, row: before.row, order: before.order, kind: before.kind, power: before.power, active: before.active },
      after: { label: after.label, row: after.row, order: after.order, kind: after.kind, power: after.power, active: after.active },
    });
    return { booth: after };
  });

  // DELETE /api/markets/:id/booths/:booth_id — retires, never deletes
  app.delete<{ Params: { id: string; booth_id: string } }>('/:id/booths/:booth_id', { preHandler: adminOnly }, async (request, reply) => {
    const user = request.authUser!;
    const market = await loadMarketDoc(app.db, request.params.id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const ref = app.db.collection('booths').doc(request.params.booth_id);
    const doc = await ref.get();
    const before = doc.exists ? boothFromData(doc.id, doc.data() as Record<string, unknown>) : null;
    if (!before || before.market_id !== market.id) return reply.status(404).send({ error: 'Booth not found' });

    const now = new Date();
    if (await usualBoothInUse(app.db, market, before.id, now)) {
      return reply.status(409).send({ error: 'A vendor lists this booth as their usual booth; change theirs first' });
    }
    await ref.update({ active: false, updated_at: now });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'booth.delete',
      target: { collection: 'booths', id: before.id },
      before: { label: before.label, active: before.active },
      after: { label: before.label, active: false },
    });
    return { booth: boothFromData(doc.id, { ...(doc.data() as Record<string, unknown>), active: false, updated_at: now }) };
  });
}
