import type { FastifyInstance } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { normalizeEmail, nameKey } from '../services/identity.js';
import { createProducerSchema, updateProducerSchema } from '../services/producers.js';
import { byStringAsc } from '../utils/sort.js';
import { toDate } from '../utils/dates.js';

interface MembershipLite {
  market_id: string;
  status: string;
}

/** One `producer_memberships` query (§1.1.4 one-equality-filter rule), grouped in memory. */
async function loadMembershipsByProducer(db: Firestore, marketId?: string): Promise<Map<string, MembershipLite[]>> {
  let query: FirebaseFirestore.Query = db.collection('producer_memberships');
  if (marketId) query = query.where('market_id', '==', marketId);
  const snapshot = await query.get();
  const byProducer = new Map<string, MembershipLite[]>();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const producerId = data.producer_id as string;
    const list = byProducer.get(producerId) ?? [];
    list.push({ market_id: data.market_id as string, status: data.status as string });
    byProducer.set(producerId, list);
  }
  return byProducer;
}

export async function producerRoutes(app: FastifyInstance) {
  // GET /api/producers
  app.get('/', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const query = request.query as { market_id?: string; status?: string; q?: string; include_inactive?: string };

    if (scoped.role !== 'admin') {
      if (!query.market_id) return reply.status(400).send({ error: 'market_id is required' });
      if (!canAccessMarket(scoped, query.market_id)) {
        return reply.status(403).send({ error: 'Forbidden: market not assigned' });
      }
    }

    const membershipsByProducer = await loadMembershipsByProducer(app.db, query.market_id);

    let producerIds: Set<string> | null = null;
    if (query.market_id || query.status) {
      producerIds = new Set(
        [...membershipsByProducer.entries()]
          .filter(([, list]) => (query.status ? list.some((m) => m.status === query.status) : true))
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
    const memberships = membershipsSnap.docs.map((m) => ({ id: m.id, ...m.data() }));

    if (scoped.role !== 'admin') {
      const accessible = memberships.some((m) => canAccessMarket(scoped, (m as Record<string, unknown>).market_id as string));
      if (!accessible) return reply.status(404).send({ error: 'Producer not found' });
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

    return { producer: result, memberships, checkins_summary: { count, last_submitted_at: last } };
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

    const memberships: Record<string, unknown>[] = [];
    for (const m of input.memberships ?? []) {
      const membershipId = `${id}_${m.market_id}`;
      const isSettled = m.status === 'approved' || m.status === 'active';
      const membership = {
        producer_id: id,
        market_id: m.market_id,
        status: m.status,
        usual_booth_id: null,
        fee_plan: m.fee_plan ?? 'weekly',
        approved_at: isSettled ? now : null,
        approved_by: isSettled ? user.id : null,
        history: [{ from: null, to: m.status, at: now, by: user.id, note: null }],
        source: 'admin' as const,
        created_at: now,
        updated_at: now,
      };
      await app.db.collection('producer_memberships').doc(membershipId).set(membership);
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'membership.create',
        target: { collection: 'producer_memberships', id: membershipId },
        after: membership,
      });
      memberships.push({ id: membershipId, ...membership });
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
    if (input.phone !== undefined) updates.phone = input.phone;

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
}
