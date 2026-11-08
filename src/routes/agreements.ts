import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../services/audit.js';
import { TOKEN_RE } from '../services/link-tokens.js';
import { markPurposeTokenUsed, resolvePurposeToken } from '../services/purpose-tokens.js';
import { buildAgreementView, loadAgreementContext, signAgreement } from '../services/agreements.js';

/**
 * The public Hold Harmless e-sign (Phase 4 contract §3.1). No login, never mints
 * a JWT, sends no text and no email. A link that is not an agreement link
 * (unknown, a check-in token, an application token) answers 404, so the page never
 * tells a stranger which kind of link it was.
 */

const signSchema = z.object({
  signature_name: z.string().trim().min(2).max(120),
  agree: z.literal(true, { errorMap: () => ({ message: 'You must agree to sign' }) }),
});

export async function agreementRoutes(app: FastifyInstance) {
  // GET /api/agreements/:token
  app.get('/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    reply.header('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) return reply.status(404).send({ error: 'Unknown link' });

    const resolved = await resolvePurposeToken(app.db, token, 'agreement', new Date());
    if (resolved.status === 'unknown') return reply.status(404).send({ error: 'Unknown link' });
    if (resolved.status === 'expired') {
      if (resolved.reason === 'wrong_purpose') return reply.status(404).send({ error: 'Unknown link' });
      return reply.status(410).send({ error: 'This link has expired' });
    }

    const ctx = await loadAgreementContext(app.db, resolved.token.membership_id);
    if (!ctx) return reply.status(404).send({ error: 'Unknown link' });
    return buildAgreementView(ctx, resolved.token);
  });

  // POST /api/agreements/:token
  app.post('/:token', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    reply.header('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token)) return reply.status(404).send({ error: 'Unknown link' });

    const now = new Date();
    const resolved = await resolvePurposeToken(app.db, token, 'agreement', now);
    if (resolved.status === 'unknown') return reply.status(404).send({ error: 'Unknown link' });
    if (resolved.status === 'expired') {
      if (resolved.reason === 'wrong_purpose') return reply.status(404).send({ error: 'Unknown link' });
      return reply.status(410).send({ error: 'This link has expired' });
    }

    const parsed = signSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });

    // 'used' is not itself a refusal: the signature on the membership is the truth
    // (signAgreement answers 409 when it exists), so a token spent by a signing that
    // never reached the membership does not lock the producer out.
    const ctx = await loadAgreementContext(app.db, resolved.token.membership_id);
    if (!ctx) return reply.status(404).send({ error: 'Unknown link' });

    const result = await signAgreement(app.db, ctx, resolved.token, { name: parsed.data.signature_name, ip: request.ip, now });
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    await markPurposeTokenUsed(app.db, token, now);
    await writeAudit(app.db, {
      actor_id: `producer:${ctx.membership.producer_id}`,
      actor_role: 'producer',
      action: 'membership.agreement.signed',
      target: { collection: 'producer_memberships', id: ctx.membership.id },
      before: { status: ctx.membership.status, signed: false },
      after: { status: result.membership_status, signed: true },
    });

    return { ok: true, signed: { name: result.signed.name, signed_at: result.signed.signed_at }, membership_status: result.membership_status };
  });
}
