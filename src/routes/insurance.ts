import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { issueAgreementLink, loadAgreementContext } from '../services/agreements.js';
import { insuranceExpiresOn, insuranceExpiryInstant, insuranceStatusAt, membershipFromData, membershipViewFor } from '../services/seasons.js';
import type { MembershipView } from '../services/seasons.js';
import { quietUntil } from '../services/markets.js';
import { parseDate } from '../utils/tz.js';

/**
 * Insurance tracking and the agreement re-send (Phase 4 contract §3.4). Both live
 * under /api/memberships/:id/…, are staff-only and scoped to the membership's
 * market, and audit every write.
 *
 * The expiry of a certificate is a CALENDAR DATE (fix X11): `expires_on`,
 * 'YYYY-MM-DD', the last day it is valid in the market's own calendar. That
 * is what the API accepts, stores and returns. `expires_at` (the instant the
 * certificate stops being valid: market-local midnight at the start of the
 * next day) is derived from it on every write and exists only so expiry can be
 * compared against a clock. The request no longer takes `expires_at`: a client
 * that showed the instant as a date and sent it back moved the date forward by
 * one day per save, so such a request is refused instead of guessed at.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const insuranceSchema = z.object({
  status: z.enum(['missing', 'on_file', 'expired', 'waived']),
  expires_on: z
    .string()
    .regex(DATE, 'expires_on: expected YYYY-MM-DD')
    .refine((v) => {
      try {
        parseDate(v);
        return true;
      } catch {
        return false;
      }
    }, 'expires_on: not a calendar date')
    .nullable()
    .default(null),
  upload_id: z.string().uuid().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});

const agreementLinkSchema = z.object({ send: z.boolean().default(true) });

/**
 * The membership as this staff user sees it (`membershipViewFor`: no signature
 * IP or token for a market manager, the insurance date as a calendar day),
 * with insurance resolved against `now` (an on-file certificate past its
 * expiry reads `expired`).
 */
function staffView(viewer: { role: string }, membership: MembershipView, timezone: string, now: Date) {
  const view = membershipViewFor(viewer, membership, { timezone });
  return { ...view, insurance: { ...view.insurance, status: insuranceStatusAt(membership.insurance, now) } };
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

    const body = (request.body ?? {}) as Record<string, unknown>;
    // The date travels as `expires_on` only. An `expires_at` in the request comes from a page
    // that predates the fix and would carry the wrong day: refuse it, never reinterpret it.
    if (body.expires_at !== undefined && body.expires_at !== null) {
      return reply.status(400).send({
        error: 'Send the last valid day as expires_on (YYYY-MM-DD); expires_at is no longer accepted. Reload the page and try again.',
        code: 'expires_on_required',
      });
    }
    const parsed = insuranceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const input = parsed.data;

    // `upload_id` keeps its stored value when the request does not mention it (the schema's
    // default of null would otherwise detach a certificate on every status change).
    const uploadId = 'upload_id' in body ? input.upload_id : before.insurance.upload_id;
    if (uploadId && uploadId !== before.insurance.upload_id) {
      const upload = await app.db.collection('application_uploads').doc(uploadId).get();
      if (!upload.exists) return reply.status(400).send({ error: 'Unknown upload' });
    }

    const now = new Date();
    const verified = input.status === 'on_file' || input.status === 'waived';
    const marketDoc = await app.db.collection('farmers_markets').doc(before.market_id).get();
    const tz = (marketDoc.data()?.timezone as string | undefined) || 'UTC';
    // "Valid through D": D is stored as it was typed; the instant is market-local midnight at the start of D + 1.
    const insurance = {
      status: input.status,
      expires_on: input.expires_on,
      expires_at: input.expires_on ? insuranceExpiryInstant(input.expires_on, tz) : null,
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
      before: { status: before.insurance.status, expires_on: insuranceExpiresOn(before.insurance, tz), expires_at: before.insurance.expires_at },
      after: { status: after.insurance.status, expires_on: after.insurance.expires_on, expires_at: after.insurance.expires_at },
    });

    return { membership: staffView(scoped, after, tz, now) };
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
