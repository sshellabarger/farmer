import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.js';
import { applicationSchema, canTransition, upsertProducerByEmail, type MembershipStatus } from '../services/producers.js';
import { normalizeEmail } from '../services/identity.js';
import { normalizePhone } from './sms.js';
import { byDateDesc } from '../utils/sort.js';

const applicationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review') }),
  z.object({ action: z.literal('decline'), note: z.string().optional() }),
  z.object({ action: z.literal('approve'), market_ids: z.array(z.string()).min(1), note: z.string().optional() }),
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export async function applicationRoutes(app: FastifyInstance) {
  // POST /api/applications (public)
  app.post(
    '/',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = applicationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const input = parsed.data;

      const email = normalizeEmail(input.email);
      if (!email) return reply.status(400).send({ error: 'Invalid email' });
      const phone = normalizePhone(input.phone);

      for (const marketId of input.markets_applied) {
        const marketDoc = await app.db.collection('farmers_markets').doc(marketId).get();
        if (!marketDoc.exists || marketDoc.data()?.active !== true) {
          return reply.status(400).send({ error: `Market '${marketId}' is not accepting applications` });
        }
      }

      const snapshot = await app.db.collection('applications').get();
      const now = new Date();
      const recentDuplicate = snapshot.docs.find((d) => {
        const data = d.data();
        if (data.status !== 'new') return false;
        if (normalizeEmail(data.email as string) !== email) return false;
        const submitted = data.submitted_at instanceof Date ? data.submitted_at : new Date(data.submitted_at as string);
        return now.getTime() - submitted.getTime() < DAY_MS;
      });
      if (recentDuplicate) {
        return reply.status(409).send({ error: 'We already have a recent application for this email' });
      }

      const id = uuid();
      const application = {
        email,
        business_name: input.business_name,
        contact_person: input.contact_person,
        phone,
        markets_applied: input.markets_applied,
        extra: input.extra,
        status: 'new' as const,
        reviewed_by: null,
        reviewed_at: null,
        decision_note: null,
        producer_id: null,
        membership_ids: [] as string[],
        submitted_at: now,
        source: 'web' as const,
        created_at: now,
        updated_at: now,
      };
      await app.db.collection('applications').doc(id).set(application);

      return reply.status(201).send({ id, status: 'new' as const });
    },
  );

  // GET /api/applications
  app.get('/', { preHandler: [authenticate(app), requireRole('admin')] }, async (request) => {
    const { status } = request.query as { status?: string };
    const snapshot = status
      ? await app.db.collection('applications').where('status', '==', status).get()
      : await app.db.collection('applications').get();
    const applications = byDateDesc(
      snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
      'submitted_at',
    );
    return { applications };
  });

  // GET /api/applications/:id
  app.get<{ Params: { id: string } }>('/:id', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const doc = await app.db.collection('applications').doc(request.params.id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'Application not found' });
    return { application: { id: doc.id, ...doc.data() } };
  });

  // PATCH /api/applications/:id
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const ref = app.db.collection('applications').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Application not found' });
    const before = doc.data()!;
    const user = request.authUser!;

    const parsed = applicationActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const input = parsed.data;

    if (before.status === 'approved' || before.status === 'declined') {
      return reply.status(409).send({ error: `Application already ${before.status as string}` });
    }

    const now = new Date();

    if (input.action === 'review') {
      const updates = { status: 'under_review' as const, updated_at: now };
      await ref.update(updates);
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.review',
        target: { collection: 'applications', id: doc.id },
        before: { status: before.status },
        after: { status: updates.status },
      });
      return { application: { id: doc.id, ...before, ...updates } };
    }

    if (input.action === 'decline') {
      const updates = {
        status: 'declined' as const,
        reviewed_by: user.id,
        reviewed_at: now,
        decision_note: input.note ?? null,
        updated_at: now,
      };
      await ref.update(updates);
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.decline',
        target: { collection: 'applications', id: doc.id },
        before: { status: before.status },
        after: { status: updates.status },
        note: input.note ?? null,
      });
      return { application: { id: doc.id, ...before, ...updates } };
    }

    // action === 'approve'
    const marketsApplied = new Set((before.markets_applied as string[] | undefined) ?? []);
    const outside = input.market_ids.filter((m) => !marketsApplied.has(m));
    if (outside.length > 0) {
      return reply.status(400).send({ error: `market_ids must be a subset of markets_applied: ${outside.join(', ')}` });
    }

    // Approve = upsert BY EMAIL, never by name (SPEC §7.9).
    const { producer_id, created } = await upsertProducerByEmail(app.db, {
      email: before.email as string,
      business_name: before.business_name as string,
      contact_name: before.contact_person as string,
      phone: before.phone as string,
      source: 'application',
    });
    const producerDoc = await app.db.collection('producers').doc(producer_id).get();
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: created ? 'producer.create' : 'producer.update',
      target: { collection: 'producers', id: producer_id },
      after: producerDoc.data(),
    });

    const membershipIds: string[] = [];
    for (const marketId of input.market_ids) {
      const membershipId = `${producer_id}_${marketId}`;
      const membershipRef = app.db.collection('producer_memberships').doc(membershipId);
      const existing = await membershipRef.get();

      if (!existing.exists) {
        const membership = {
          producer_id,
          market_id: marketId,
          status: 'approved' as const,
          usual_booth_id: null,
          fee_plan: 'weekly' as const,
          approved_at: now,
          approved_by: user.id,
          history: [{ from: null, to: 'approved', at: now, by: user.id, note: input.note ?? null }],
          source: 'application' as const,
          created_at: now,
          updated_at: now,
        };
        await membershipRef.set(membership);
        await writeAudit(app.db, {
          actor_id: user.id,
          actor_role: user.role,
          action: 'membership.create',
          target: { collection: 'producer_memberships', id: membershipId },
          after: membership,
        });
      } else {
        const existingData = existing.data()!;
        const from = existingData.status as MembershipStatus;
        if (canTransition(from, 'approved')) {
          const history = [...((existingData.history as unknown[] | undefined) ?? [])];
          history.push({ from, to: 'approved', at: now, by: user.id, note: input.note ?? null });
          const updates: Record<string, unknown> = { status: 'approved', history, updated_at: now };
          if (!existingData.approved_at) {
            updates.approved_at = now;
            updates.approved_by = user.id;
          }
          await membershipRef.update(updates);
          await writeAudit(app.db, {
            actor_id: user.id,
            actor_role: user.role,
            action: 'membership.transition',
            target: { collection: 'producer_memberships', id: membershipId },
            before: { status: from },
            after: { status: 'approved' },
          });
        }
        // approved|active memberships are left alone.
      }
      membershipIds.push(membershipId);
    }

    const updates = {
      status: 'approved' as const,
      reviewed_by: user.id,
      reviewed_at: now,
      decision_note: input.note ?? null,
      producer_id,
      membership_ids: membershipIds,
      updated_at: now,
    };
    await ref.update(updates);
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'application.approve',
      target: { collection: 'applications', id: doc.id },
      before: { status: before.status },
      after: { status: updates.status, producer_id, membership_ids: membershipIds },
    });

    const membershipDocs = await Promise.all(membershipIds.map((mid) => app.db.collection('producer_memberships').doc(mid).get()));

    return {
      application: { id: doc.id, ...before, ...updates },
      producer: { id: producer_id, ...producerDoc.data() },
      memberships: membershipDocs.map((d) => ({ id: d.id, ...d.data() })),
    };
  });
}
