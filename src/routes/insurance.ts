import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { issueAgreementLink, loadAgreementContext } from '../services/agreements.js';
import { insuranceStatusAt, membershipFromData } from '../services/seasons.js';
import type { MembershipView } from '../services/seasons.js';
import { quietUntil } from '../services/markets.js';
import { addDays, localToUtc, parseDate } from '../utils/tz.js';

/**
 * Insurance tracking and the agreement re-send (Phase 4 contract §3.4). Both live
 * under /api/memberships/:id/…, are staff-only and scoped to the membership's
 * market, and audit every write.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const insuranceSchema = z.object({
  status: z.enum(['missing', 'on_file', 'expired', 'waived']),
  expires_at: z
    .string()
    .regex(DATE, 'expected YYYY-MM-DD')
    .refine((v) => {
      try {
        parseDate(v);
        return true;
      } catch {
        return false;
      }
    }, 'not a calendar date')
    .nullable()
    .default(null),
  upload_id: z.string().uuid().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});

const agreementLinkSchema = z.object({ send: z.boolean().default(true) });

/** The membership as staff see it: dates as Dates, with insurance resolved against `now` (an on-file certificate past its expiry reads `expired`). */
function staffView(membership: MembershipView, now: Date) {
  return { ...membership, insurance: { ...membership.insurance, status: insuranceStatusAt(membership.insurance, now) } };
}

export async function insuranceRoutes(app: FastifyInstance) {
  const staffOnly = [authenticate(app), requireStaff()];

  // PATCH /api/memberships/:id/insurance
  app.patch<{ Params: { id: string } }>('/:id/insurance', { preHandler: staffOnly }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;

    const ref = app.db.collection('producer_memberships').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Membership not found' });
    const before = membershipFromData(doc.id, doc.data() as Record<string, unknown>);
    if (!canAccessMarket(scoped, before.market_id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = insuranceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const input = parsed.data;

    // `upload_id` keeps its stored value when the request does not mention it (the schema's
    // default of null would otherwise detach a certificate on every status change).
    const body = (request.body ?? {}) as Record<string, unknown>;
    const uploadId = 'upload_id' in body ? input.upload_id : before.insurance.upload_id;
    if (uploadId && uploadId !== before.insurance.upload_id) {
      const upload = await app.db.collection('application_uploads').doc(uploadId).get();
      if (!upload.exists) return reply.status(400).send({ error: 'Unknown upload' });
    }

    const now = new Date();
    const verified = input.status === 'on_file' || input.status === 'waived';
    // "Expires on D" means valid through D: the stored instant is local midnight at the start of D + 1.
    let expiresAt: Date | null = null;
    if (input.expires_at) {
      const marketDoc = await app.db.collection('farmers_markets').doc(before.market_id).get();
      const tz = (marketDoc.data()?.timezone as string | undefined) || 'UTC';
      expiresAt = localToUtc(addDays(input.expires_at, 1), '00:00', tz);
    }
    const insurance = {
      status: input.status,
      expires_at: expiresAt,
      upload_id: uploadId,
      verified_by: verified ? user.id : null,
      verified_at: verified ? now : null,
      note: input.note,
    };
    await ref.update({ insurance, updated_at: now });

    const afterDoc = await ref.get();
    const after = membershipFromData(afterDoc.id, afterDoc.data() as Record<string, unknown>);
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'membership.insurance',
      target: { collection: 'producer_memberships', id: doc.id },
      before: { status: before.insurance.status, expires_at: before.insurance.expires_at },
      after: { status: after.insurance.status, expires_at: after.insurance.expires_at },
    });

    return { membership: staffView(after, now) };
  });

  // POST /api/memberships/:id/agreement-link
  app.post<{ Params: { id: string } }>('/:id/agreement-link', { preHandler: staffOnly }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;

    const ctx = await loadAgreementContext(app.db, request.params.id);
    if (!ctx) return reply.status(404).send({ error: 'Membership not found' });
    if (!canAccessMarket(scoped, ctx.membership.market_id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = agreementLinkSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });

    if (ctx.membership.hold_harmless) return reply.status(409).send({ error: 'The agreement is already signed' });
    if (ctx.membership.status !== 'approved' && ctx.membership.status !== 'active') {
      return reply.status(409).send({ error: 'The membership must be approved before an agreement link can be sent' });
    }

    const now = new Date();
    // Staff-triggered texts wait for the market's quiet hours to end (fix X5). Refused before a
    // token is minted; the link itself can still be created without sending.
    const quiet = parsed.data.send ? quietUntil(ctx.market, now) : null;
    if (quiet) {
      return reply.status(409).send({
        error: 'It is quiet hours at this market, so the text was not sent. Send it after quiet hours end, or create the link without sending.',
        code: 'quiet_hours',
        quiet_until: quiet,
      });
    }
    const issued = await issueAgreementLink(app.db, app.env, ctx, { user_id: user.id, now, send: parsed.data.send });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'membership.agreement_link',
      target: { collection: 'producer_memberships', id: ctx.membership.id },
      after: { sms: issued.sms, expires_at: issued.expires_at },
    });

    return { url: issued.url, expires_at: issued.expires_at, sms: issued.sms };
  });
}
