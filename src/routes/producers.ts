import type { FastifyInstance } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { normalizeEmail, nameKey } from '../services/identity.js';
import { createMembership, createProducerSchema, findProducerByPhone, updateProducerSchema } from '../services/producers.js';
import { byStringAsc } from '../utils/sort.js';
import { toDate } from '../utils/dates.js';
import { z } from 'zod';
import type { FarmersMarket } from '../services/markets.js';
import { currentSeason, membershipFromData, normalizeFeePlan, type MembershipView } from '../services/seasons.js';
import { inviteDocId, inviteFromData, inviteProducer } from '../services/invites.js';
import { purposeTokenUrl } from '../services/purpose-tokens.js';

interface MembershipLite {
  market_id: string;
  status: string;
  season: string;
  fee_plan: string;
  spaces: number;
  electric: boolean;
}

/** One `producer_memberships` query (§1.1.4 one-equality-filter rule), grouped in memory. Season filtering is the caller's. */
async function loadMembershipsByProducer(db: Firestore, marketId?: string): Promise<Map<string, MembershipLite[]>> {
  let query: FirebaseFirestore.Query = db.collection('producer_memberships');
  if (marketId) query = query.where('market_id', '==', marketId);
  const snapshot = await query.get();
  const byProducer = new Map<string, MembershipLite[]>();
  for (const doc of snapshot.docs) {
    const m = membershipFromData(doc.id, doc.data() as Record<string, unknown>);
    const list = byProducer.get(m.producer_id) ?? [];
    list.push({ market_id: m.market_id, status: m.status, season: m.season, fee_plan: m.fee_plan, spaces: m.spaces, electric: m.electric });
    byProducer.set(m.producer_id, list);
  }
  return byProducer;
}

async function loadMarketDoc(db: Firestore, id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

/** The current season of a market, 'legacy' fallback included when the market document is missing. */
function seasonOf(market: FarmersMarket | null, now: Date): string {
  return currentSeason(market ?? { timezone: 'UTC' }, now);
}

export async function producerRoutes(app: FastifyInstance) {
  // GET /api/producers
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const query = request.query as { market_id?: string; status?: string; season?: string; q?: string; include_inactive?: string };

    if (scoped.role !== 'admin') {
      if (!query.market_id) return reply.status(400).send({ error: 'market_id is required' });
      if (!canAccessMarket(scoped, query.market_id)) {
        return reply.status(403).send({ error: 'Forbidden: market not assigned' });
      }
    }

    // D33: only the market's current season counts, unless a season is asked for by name.
    let season = query.season;
    if (!season && query.market_id) season = seasonOf(await loadMarketDoc(app.db, query.market_id), new Date());

    const allMemberships = await loadMembershipsByProducer(app.db, query.market_id);
    const membershipsByProducer = new Map<string, MembershipLite[]>();
    for (const [producerId, list] of allMemberships) {
      const kept = season ? list.filter((m) => m.season === season) : list;
      if (kept.length > 0 || !season) membershipsByProducer.set(producerId, kept);
    }

    let producerIds: Set<string> | null = null;
    if (query.market_id || query.status || query.season) {
      producerIds = new Set(
        [...membershipsByProducer.entries()]
          .filter(([, list]) => (query.status ? list.some((m) => m.status === query.status) : list.length > 0))
          .map(([producerId]) => producerId),
      );
    }

    const snapshot = await app.db.collection('producers').get();
    let docs = snapshot.docs;
    if (producerIds) {
      const ids = producerIds;
      docs = docs.filter((d) => ids.has(d.id));
    }
    if (query.include_inactive !== 'true') {
      docs = docs.filter((d) => d.data().active !== false);
    }
    if (query.q) {
      const needle = query.q.toLowerCase();
      docs = docs.filter((d) => {
        const data = d.data();
        const businessName = String(data.business_name ?? '').toLowerCase();
        const contactName = String(data.contact_name ?? '').toLowerCase();
        const aliases = ((data.aliases as string[] | undefined) ?? []).map((a) => a.toLowerCase());
        return businessName.includes(needle) || contactName.includes(needle) || aliases.some((a) => a.includes(needle));
      });
    }

    const isAdmin = scoped.role === 'admin';
    const producers = docs.map((d) => {
      const data = d.data();
      const result: Record<string, unknown> = { id: d.id, ...data, memberships: membershipsByProducer.get(d.id) ?? [] };
      if (!isAdmin) delete result.notes;
      return result;
    });

    return { producers: byStringAsc(producers, 'business_name') };
  });

  // GET /api/producers/:id
  app.get<{ Params: { id: string } }>('/:id', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const doc = await app.db.collection('producers').doc(request.params.id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'Producer not found' });

    const membershipsSnap = await app.db.collection('producer_memberships').where('producer_id', '==', doc.id).get();
    let memberships: MembershipView[] = membershipsSnap.docs.map((m) => membershipFromData(m.id, m.data() as Record<string, unknown>));

    if (scoped.role !== 'admin') {
      const accessible = memberships.some((m) => canAccessMarket(scoped, m.market_id));
      if (!accessible) return reply.status(404).send({ error: 'Producer not found' });
      memberships = memberships.filter((m) => canAccessMarket(scoped, m.market_id));
    }
    // Every season, newest first (D33: previous seasons stay visible as history).
    memberships.sort((a, b) => b.season.localeCompare(a.season) || b.created_at.getTime() - a.created_at.getTime());

    const now = new Date();
    const currentSeasonByMarket: Record<string, string> = {};
    for (const marketId of new Set(memberships.map((m) => m.market_id))) {
      currentSeasonByMarket[marketId] = seasonOf(await loadMarketDoc(app.db, marketId), now);
    }

    // The re-apply link is a no-login key to this producer's prefilled data: admins only.
    let invite: { token_url: string; sent_at: Date } | null = null;
    if (scoped.role === 'admin') {
      const inviteSnap = await app.db.collection('application_invites').where('producer_id', '==', doc.id).get();
      const current = inviteSnap.docs
        .map((d) => inviteFromData(d.data() as Record<string, unknown>))
        .filter((i) => currentSeasonByMarket[i.market_id] === i.season)
        .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())[0];
      if (current) {
        const latest = current.resends.length > 0 ? current.resends[current.resends.length - 1]!.at : current.sent_at;
        invite = { token_url: purposeTokenUrl(app.env.APP_URL, 'application', current.token), sent_at: latest };
      }
    }

    const checkinsSnap = await app.db.collection('checkins').where('producer_id', '==', doc.id).get();
    let count = 0;
    let last: Date | null = null;
    for (const c of checkinsSnap.docs) {
      count += 1;
      const t = toDate(c.data().submitted_at);
      if (t && (!last || t > last)) last = t;
    }

    const data = doc.data()!;
    const result: Record<string, unknown> = { id: doc.id, ...data };
    if (scoped.role !== 'admin') delete result.notes;

    return {
      producer: result,
      memberships,
      current_season_by_market: currentSeasonByMarket,
      invite,
      checkins_summary: { count, last_submitted_at: last },
    };
  });

  // POST /api/producers
  app.post('/', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const parsed = createProducerSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const input = parsed.data;
    const user = request.authUser!;

    const snapshot = await app.db.collection('producers').get();
    const email = input.email ? normalizeEmail(input.email) : null;
    if (email) {
      const dupe = snapshot.docs.find((d) => ((d.data().emails as string[] | undefined) ?? []).includes(email));
      if (dupe) return reply.status(409).send({ error: 'A producer with this email already exists', producer_id: dupe.id });
    }
    if (input.phone) {
      const dupePhone = snapshot.docs.find((d) => d.data().phone === input.phone);
      if (dupePhone) {
        return reply.status(409).send({ error: 'A producer with this phone already exists', producer_id: dupePhone.id });
      }
    }

    const id = uuid();
    const now = new Date();
    const emails = new Set<string>();
    for (const e of input.emails ?? []) {
      const n = normalizeEmail(e);
      if (n) emails.add(n);
    }
    if (email) emails.add(email);

    const producer = {
      business_name: input.business_name,
      name_key: nameKey(input.business_name),
      contact_name: input.contact_name ?? '',
      phone: input.phone ?? null,
      email: email ?? (emails.size > 0 ? [...emails][0] : null),
      emails: [...emails].sort(),
      aliases: [...new Set(input.aliases ?? [])].sort(),
      products: input.products ?? [],
      category: input.category ?? '',
      documents: [] as unknown[],
      sms_consent: { status: 'unknown' as const, at: null, source: 'admin' as const },
      sms_opt_out_at: null,
      user_id: null,
      legacy_farm_id: null,
      notes: input.notes ?? '',
      source: 'admin' as const,
      active: true,
      created_at: now,
      updated_at: now,
    };
    await app.db.collection('producers').doc(id).set(producer);
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'producer.create',
      target: { collection: 'producers', id },
      after: producer,
    });

    // Memberships belong to the market's current season (D33).
    const memberships: Record<string, unknown>[] = [];
    for (const m of input.memberships ?? []) {
      const season = seasonOf(await loadMarketDoc(app.db, m.market_id), now);
      const created = await createMembership(
        app.db,
        {
          producer_id: id,
          market_id: m.market_id,
          season,
          status: m.status,
          fee_plan: normalizeFeePlan(m.fee_plan),
          spaces: 1,
          electric: false,
          pay_in_full: false,
          booth_kind: 'stall',
          usual_booth_id: null,
          trial_period: false,
          approved_items: [],
          application_id: null,
          source: 'admin',
          actor: user.id,
          note: null,
        },
        now,
      );
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'membership.create',
        target: { collection: 'producer_memberships', id: created.id },
        after: created.doc,
      });
      memberships.push({ ...membershipFromData(created.id, created.doc) });
    }

    return reply.status(201).send({ producer: { id, ...producer }, memberships });
  });

  // PATCH /api/producers/:id
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const parsed = updateProducerSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const input = parsed.data;
    const user = request.authUser!;

    const ref = app.db.collection('producers').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Producer not found' });
    const before = doc.data()!;

    const updates: Record<string, unknown> = { updated_at: new Date() };

    if (input.business_name !== undefined && input.business_name !== before.business_name) {
      const oldName = ((before.business_name as string) ?? '').trim();
      const aliases = new Set<string>((before.aliases as string[] | undefined) ?? []);
      if (oldName && oldName !== input.business_name) aliases.add(oldName);
      aliases.delete(input.business_name);
      updates.business_name = input.business_name;
      updates.name_key = nameKey(input.business_name);
      updates.aliases = [...aliases].sort();
    }
    if (input.contact_name !== undefined) updates.contact_name = input.contact_name;
    if (input.phone !== undefined) {
      const holder = await findProducerByPhone(app.db, input.phone);
      if (holder && holder !== doc.id) {
        return reply.status(409).send({ error: 'A producer with this phone already exists', producer_id: holder });
      }
      updates.phone = input.phone;
    }

    const emailSet = new Set<string>(
      (updates.emails as string[] | undefined) ?? (before.emails as string[] | undefined) ?? [],
    );
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      updates.email = email;
      if (email) emailSet.add(email);
    }
    if (input.emails !== undefined) {
      for (const e of input.emails) {
        const n = normalizeEmail(e);
        if (n) emailSet.add(n);
      }
    }
    if (input.email !== undefined || input.emails !== undefined) {
      updates.emails = [...emailSet].sort();
    }

    if (input.aliases !== undefined) {
      const merged = new Set<string>([...((updates.aliases as string[] | undefined) ?? []), ...input.aliases]);
      updates.aliases = [...merged].sort();
    }
    if (input.products !== undefined) updates.products = input.products;
    if (input.category !== undefined) updates.category = input.category;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.active !== undefined) updates.active = input.active;
    // Phase 4 profile fields (contract §2.3).
    for (const key of [
      'website',
      'social',
      'address',
      'description_public',
      'years_in_operation',
      'outlets',
      'agricultural_practices',
      'categories',
      'payment_methods',
      'logo_upload_id',
    ] as const) {
      if (input[key] !== undefined) updates[key] = input[key];
    }

    await ref.update(updates);
    const after = { ...before, ...updates };
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'producer.update',
      target: { collection: 'producers', id: doc.id },
      before,
      after,
    });

    return { producer: { id: doc.id, ...after } };
  });

  // POST /api/producers/:id/invite?market_id=&force= — invite one returning vendor to re-apply (D30/D33)
  app.post<{ Params: { id: string } }>('/:id/invite', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const parsed = z.object({ market_id: z.string().min(1), force: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]!.message });
    const user = request.authUser!;

    const producerDoc = await app.db.collection('producers').doc(request.params.id).get();
    if (!producerDoc.exists) return reply.status(404).send({ error: 'Producer not found' });
    const market = await loadMarketDoc(app.db, parsed.data.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!market.season?.label) {
      return reply.status(409).send({ error: 'Applications are not open: set the season for this market first' });
    }

    const season = market.season.label;
    const result = await inviteProducer({
      db: app.db,
      env: app.env,
      market,
      season,
      producerId: producerDoc.id,
      producer: producerDoc.data() as Record<string, unknown>,
      actor: user.id,
      force: parsed.data.force === 'true',
      now: new Date(),
    });
    if (result.status === 'already') return reply.status(409).send({ error: 'Already invited', invite: result.invite });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'producer.invite_reapply',
      target: { collection: 'producers', id: producerDoc.id },
      after: {
        invite: inviteDocId(market.id, season, producerDoc.id),
        email_status: result.invite.email_status,
        sms_status: result.invite.sms_status,
        resent: result.resent,
      },
    });
    return { invite: result.invite, url: result.url };
  });
}
