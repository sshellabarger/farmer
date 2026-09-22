import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, requireMarketAccess, marketIdFromParams, accessibleMarketIds } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { generateMarketDates } from '../services/market-dates.js';
import type { MarketDateDoc } from '../services/market-dates.js';
import {
  createMarketSchema,
  updateMarketSchema,
  scheduleVersionSchema,
  skippedDatesSchema,
  specialDatesSchema,
  extraQuestionSchema,
  DEFAULT_WORKFLOW,
  DEFAULT_QUIET_HOURS,
} from '../services/markets.js';
import type { FarmersMarket, ScheduleVersion } from '../services/markets.js';
import { byStringAsc } from '../utils/sort.js';

async function loadMarket(db: FastifyInstance['db'], id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

/** mailchimp/website are Phase 6; never exposed to a market_manager. */
function toMarketDTO(market: FarmersMarket, isAdmin: boolean): Partial<FarmersMarket> & { id: string } {
  if (isAdmin) return market;
  const { mailchimp: _mailchimp, website: _website, ...rest } = market;
  return rest;
}

async function marketDateDocs(db: FastifyInstance['db'], marketId: string): Promise<MarketDateDoc[]> {
  const snap = await db.collection('market_dates').where('market_id', '==', marketId).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as MarketDateDoc);
}

async function nextUpcomingDate(db: FastifyInstance['db'], marketId: string, now: Date) {
  const dates = await marketDateDocs(db, marketId);
  const upcoming = dates
    .filter((d) => d.status !== 'cancelled' && d.start_at.getTime() >= now.getTime())
    .sort((a, b) => a.start_at.getTime() - b.start_at.getTime());
  const next = upcoming[0];
  if (!next) return null;
  return { date: next.date, start_time: next.start_time, end_time: next.end_time };
}

const patchDateSchema = z
  .object({
    status: z.enum(['cancelled', 'collecting']).optional(),
    cancellation_reason: z.string().min(1).optional(),
    note: z.string().optional(),
    extra_questions: z.array(extraQuestionSchema).optional(),
    sponsor_id: z.string().nullable().optional(),
  })
  .refine((v) => v.status !== 'cancelled' || !!v.cancellation_reason, {
    message: 'cancellation_reason is required when cancelling',
    path: ['cancellation_reason'],
  })
  .refine((v) => !v.extra_questions || new Set(v.extra_questions.map((q) => q.key)).size === v.extra_questions.length, {
    message: 'duplicate extra_questions key',
    path: ['extra_questions'],
  });

export async function marketRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const adminOnly = [auth, requireRole('admin')];
  const staffOnly = [auth, requireStaff()];

  // ─── GET /api/markets/public ───
  app.get('/public', async () => {
    const snap = await app.db.collection('farmers_markets').where('active', '==', true).get();
    const now = new Date();
    const markets = [];
    for (const doc of snap.docs) {
      const market = { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
      const next = await nextUpcomingDate(app.db, market.id, now);
      markets.push({ id: market.id, name: market.name, location: market.location, timezone: market.timezone, active: market.active, next });
    }
    return { markets };
  });

  // ─── GET /api/markets ───
  app.get('/', { preHandler: staffOnly }, async (request) => {
    const user = request.authUser!;
    const accessible = accessibleMarketIds(user);
    const snap = await app.db.collection('farmers_markets').get();
    let markets = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as FarmersMarket);
    if (accessible !== null) markets = markets.filter((m) => accessible.includes(m.id));
    markets = byStringAsc(markets, 'name');
    return { markets: markets.map((m) => toMarketDTO(m, user.role === 'admin')) };
  });

  // ─── POST /api/markets ───
  app.post('/', { preHandler: adminOnly }, async (request, reply) => {
    const input = createMarketSchema.parse(request.body);
    const user = request.authUser!;

    const existing = await app.db.collection('farmers_markets').doc(input.slug).get();
    if (existing.exists) return reply.status(409).send({ error: `Market '${input.slug}' already exists` });

    const now = new Date();
    const versions: ScheduleVersion[] = input.schedule.versions.map((v) => ({
      ...v,
      id: uuid(),
      created_at: now,
      created_by: user.id,
    }));

    const market: Omit<FarmersMarket, 'id'> = {
      name: input.name,
      slug: input.slug,
      location: { name: input.location.name, address: input.location.address ?? '' },
      timezone: input.timezone,
      schedule: {
        versions,
        skipped_dates: input.schedule.skipped_dates,
        special_dates: input.schedule.special_dates,
      },
      workflow: { ...DEFAULT_WORKFLOW, ...input.workflow },
      quiet_hours: input.quiet_hours ?? DEFAULT_QUIET_HOURS,
      website: input.website ?? null,
      mailchimp: input.mailchimp ?? null,
      active: input.active,
      created_by: user.id,
      created_at: now,
      updated_at: now,
    };

    await app.db.collection('farmers_markets').doc(input.slug).set(market as Record<string, unknown>);
    const full: FarmersMarket = { id: input.slug, ...market };
    const generation = await generateMarketDates(app.db, full, { scope: 'window', actor: user.id });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.create',
      target: { collection: 'farmers_markets', id: input.slug },
      after: market,
    });

    return reply.status(201).send({ market: full, generation });
  });

  // ─── GET /api/markets/:id ───
  app.get('/:id', { preHandler: [auth, requireMarketAccess(marketIdFromParams('id'))] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    return { market: toMarketDTO(market, request.authUser!.role === 'admin') };
  });

  // ─── PATCH /api/markets/:id ───
  app.patch('/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const input = updateMarketSchema.parse(request.body);
    const now = new Date();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const update: Record<string, unknown> = { updated_at: now };

    if (input.name !== undefined) {
      before.name = market.name;
      after.name = input.name;
      update.name = input.name;
    }
    if (input.location !== undefined) {
      before.location = market.location;
      after.location = input.location;
      update.location = { name: input.location.name, address: input.location.address ?? '' };
    }
    if (input.timezone !== undefined) {
      before.timezone = market.timezone;
      after.timezone = input.timezone;
      update.timezone = input.timezone;
    }
    if (input.workflow !== undefined) {
      before.workflow = market.workflow;
      after.workflow = { ...market.workflow, ...input.workflow };
      update.workflow = after.workflow;
    }
    if (input.quiet_hours !== undefined) {
      before.quiet_hours = market.quiet_hours;
      after.quiet_hours = input.quiet_hours;
      update.quiet_hours = input.quiet_hours;
    }
    if (input.website !== undefined) update.website = input.website;
    if (input.mailchimp !== undefined) update.mailchimp = input.mailchimp;
    if (input.active !== undefined) {
      before.active = market.active;
      after.active = input.active;
      update.active = input.active;
    }

    await app.db.collection('farmers_markets').doc(id).update(update);
    const updated: FarmersMarket = { ...market, ...(update as Partial<FarmersMarket>) };

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.update',
      target: { collection: 'farmers_markets', id },
      before,
      after,
    });

    const needsRegen = input.timezone !== undefined || input.workflow?.deadline_offset_min !== undefined;
    let generation;
    if (needsRegen) {
      generation = await generateMarketDates(app.db, updated, { scope: 'window', actor: user.id });
    }

    return { market: toMarketDTO(updated, true), generation };
  });

  // ─── POST /api/markets/:id/schedule/versions ───
  app.post('/:id/schedule/versions', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const input = scheduleVersionSchema.parse(request.body);
    if (market.schedule.versions.some((v) => v.effective_from === input.effective_from)) {
      return reply.status(409).send({ error: `A schedule version already starts ${input.effective_from}` });
    }

    const now = new Date();
    const version: ScheduleVersion = { ...input, id: uuid(), created_at: now, created_by: user.id };
    const versions = [...market.schedule.versions, version];
    await app.db.collection('farmers_markets').doc(id).update({ 'schedule': { ...market.schedule, versions }, updated_at: now });
    const updated: FarmersMarket = { ...market, schedule: { ...market.schedule, versions }, updated_at: now };

    const generation = await generateMarketDates(app.db, updated, { scope: 'window', actor: user.id });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.schedule_version.add',
      target: { collection: 'farmers_markets', id },
      after: version,
    });

    return reply.status(201).send({ market: toMarketDTO(updated, true), generation });
  });

  // ─── DELETE /api/markets/:id/schedule/versions/:version_id ───
  app.delete('/:id/schedule/versions/:version_id', { preHandler: adminOnly }, async (request, reply) => {
    const { id, version_id } = request.params as { id: string; version_id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    if (market.schedule.versions.length <= 1) {
      return reply.status(409).send({ error: 'Cannot delete the only schedule version' });
    }
    const deleted = market.schedule.versions.find((v) => v.id === version_id);
    if (!deleted) return reply.status(404).send({ error: 'Schedule version not found' });

    const now = new Date();
    const versions = market.schedule.versions.filter((v) => v.id !== version_id);
    await app.db.collection('farmers_markets').doc(id).update({ schedule: { ...market.schedule, versions }, updated_at: now });
    const updated: FarmersMarket = { ...market, schedule: { ...market.schedule, versions }, updated_at: now };

    const generation = await generateMarketDates(app.db, updated, { scope: 'window', actor: user.id });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.schedule_version.delete',
      target: { collection: 'farmers_markets', id },
      before: deleted,
    });

    return { market: toMarketDTO(updated, true), generation };
  });

  // ─── PUT /api/markets/:id/schedule/skipped ───
  app.put('/:id/schedule/skipped', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const { skipped_dates } = skippedDatesSchema.parse(request.body);
    if (skipped_dates.some((s) => market.schedule.special_dates.some((sp) => sp.date === s.date))) {
      return reply.status(409).send({ error: 'A date cannot be both skipped and special' });
    }

    const now = new Date();
    const before = market.schedule.skipped_dates;
    await app.db.collection('farmers_markets').doc(id).update({ schedule: { ...market.schedule, skipped_dates }, updated_at: now });
    const updated: FarmersMarket = { ...market, schedule: { ...market.schedule, skipped_dates }, updated_at: now };

    const generation = await generateMarketDates(app.db, updated, { scope: 'window', actor: user.id });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.skipped_dates.set',
      target: { collection: 'farmers_markets', id },
      before,
      after: skipped_dates,
    });

    return { market: toMarketDTO(updated, true), generation };
  });

  // ─── PUT /api/markets/:id/schedule/special ───
  app.put('/:id/schedule/special', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const { special_dates } = specialDatesSchema.parse(request.body);
    if (special_dates.some((s) => market.schedule.skipped_dates.some((sk) => sk.date === s.date))) {
      return reply.status(409).send({ error: 'A date cannot be both skipped and special' });
    }

    const now = new Date();
    const before = market.schedule.special_dates;
    await app.db.collection('farmers_markets').doc(id).update({ schedule: { ...market.schedule, special_dates }, updated_at: now });
    const updated: FarmersMarket = { ...market, schedule: { ...market.schedule, special_dates }, updated_at: now };

    const generation = await generateMarketDates(app.db, updated, { scope: 'window', actor: user.id });
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.special_dates.set',
      target: { collection: 'farmers_markets', id },
      before,
      after: special_dates,
    });

    return { market: toMarketDTO(updated, true), generation };
  });

  // ─── POST /api/markets/:id/dates/generate ───
  app.post('/:id/dates/generate', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const { scope } = z.object({ scope: z.enum(['window', 'season']).default('window') }).parse(request.body ?? {});
    const generation = await generateMarketDates(app.db, market, { scope, actor: user.id });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market.dates.generate',
      target: { collection: 'farmers_markets', id },
      after: generation,
    });

    return { generation };
  });

  // ─── GET /api/markets/:id/dates ───
  app.get('/:id/dates', { preHandler: [auth, requireMarketAccess(marketIdFromParams('id'))] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const market = await loadMarket(app.db, id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const query = z
      .object({ from: z.string().optional(), to: z.string().optional(), status: z.enum(['collecting', 'lineup_final', 'published', 'cancelled']).optional() })
      .parse(request.query ?? {});

    let dates = await marketDateDocs(app.db, id);
    if (query.from) dates = dates.filter((d) => d.date >= query.from!);
    if (query.to) dates = dates.filter((d) => d.date <= query.to!);
    if (query.status) dates = dates.filter((d) => d.status === query.status);
    dates = byStringAsc(dates, 'date');

    return { dates };
  });

  // ─── PATCH /api/markets/:id/dates/:date_id ───
  app.patch('/:id/dates/:date_id', { preHandler: [auth, requireMarketAccess(marketIdFromParams('id'))] }, async (request, reply) => {
    const { id, date_id } = request.params as { id: string; date_id: string };
    const user = request.authUser!;
    const doc = await app.db.collection('market_dates').doc(date_id).get();
    if (!doc.exists || (doc.data() as Record<string, unknown>).market_id !== id) {
      return reply.status(404).send({ error: 'Market date not found' });
    }
    const existing = { id: doc.id, ...(doc.data() as Record<string, unknown>) } as MarketDateDoc;
    const input = patchDateSchema.parse(request.body);
    const now = new Date();

    let update: Record<string, unknown> = { updated_at: now };
    let action = 'market_date.update';
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.status === 'cancelled') {
      if (existing.status === 'cancelled') return reply.status(409).send({ error: 'Date is already cancelled' });
      update = {
        ...update,
        status: 'cancelled',
        cancellation_reason: input.cancellation_reason,
        cancelled_at: now,
        cancelled_by: user.id,
      };
      action = 'market_date.cancel';
      before.status = existing.status;
      after.status = 'cancelled';
    } else if (input.status === 'collecting') {
      if (existing.status !== 'cancelled') return reply.status(409).send({ error: 'Date is not cancelled' });
      const decided = existing.actions.checkin_sent_at || existing.actions.deadline_processed_at || existing.actions.drafts_generated_at ||
        existing.actions.approved_at || existing.actions.booth_texts_sent_at || existing.actions.reminders_sent.length > 0;
      if (decided || existing.end_at.getTime() < now.getTime()) {
        return reply.status(409).send({ error: 'Cannot un-cancel a decided or past date' });
      }
      update = { ...update, status: 'collecting', cancellation_reason: null, cancelled_at: null, cancelled_by: null };
      action = 'market_date.uncancel';
      before.status = existing.status;
      after.status = 'collecting';
    }

    if (input.note !== undefined) update.note = input.note;
    if (input.extra_questions !== undefined) update.extra_questions = input.extra_questions;
    if (input.sponsor_id !== undefined) update.sponsor_id = input.sponsor_id;

    await app.db.collection('market_dates').doc(date_id).update(update);
    const updated: MarketDateDoc = { ...existing, ...(update as Partial<MarketDateDoc>) };

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action,
      target: { collection: 'market_dates', id: date_id },
      before,
      after,
    });

    return { date: updated };
  });
}
