import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { loadFeeRules, validateRule, type FeeRule } from '../services/fees.js';
import { checkTaxExempt } from '../services/tax-exempt.js';
import { buildWeeklyPayout } from '../services/payouts.js';
import { squareEnabled } from '../services/square.js';

/**
 * SJCA staff tools for wholesale (admin only): fee rules, buyer tax
 * certificates, and the weekly payout sold list.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const feeRuleSchema = z.object({
  name: z.string().min(1).max(60),
  code: z.string().min(1).max(40),
  percent: z.number().gt(0).lt(100).nullable(),
  flat_cents: z.number().int().positive().nullable(),
  payer: z.enum(['buyer', 'farmer']),
  applies_to: z.enum(['all', 'delivery']),
  per: z.enum(['order', 'buyer_delivery_day']),
  farm_id: z.string().nullable().optional(),
  buyer_id: z.string().nullable().optional(),
  effective_from: day,
  effective_to: day.nullable().optional(),
  active: z.boolean(),
});

const taxExemptSchema = z.object({
  status: z.enum(['exempt_resale', 'exempt_other', 'taxable']),
  certificate_type: z.enum(['ST-391', 'SST-F0003', 'out_of_state_permit']).nullable(),
  certificate_file: z.string().nullable().optional(),
  signed_date: day.nullable(),
  permit_number: z.string().max(40).nullable().optional(),
  legal_name: z.string().max(200).nullable().optional(),
  legal_address: z.string().max(300).nullable().optional(),
  /** true = staff checked name, address and permit number against the certificate. */
  verified: z.boolean(),
});

export async function wholesaleAdminRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const adminOnly = requireRole('admin');
  const pre = { preHandler: [auth, adminOnly] };

  // ─── Fee rules ───
  app.get('/fee-rules', pre, async () => ({ rules: await loadFeeRules(app.db) }));

  // Create or replace one rule. Leave percent and flat_cents null to keep a placeholder.
  app.put('/fee-rules/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = feeRuleSchema.parse(request.body);
    const rule: FeeRule = { id, ...body };
    const problems = validateRule(rule);
    if (problems.length) return reply.status(400).send({ error: 'invalid_rule', problems });
    await app.db.collection('fee_rules').doc(id).set({ ...body, updated_by: request.authUser!.id, updated_at: new Date() });
    return { success: true, rule };
  });

  // ─── Buyer tax-exempt certificates ───
  app.post('/buyers/:id/tax-exempt', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ref = app.db.collection('markets').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Buyer not found' });
    const { verified, ...body } = taxExemptSchema.parse(request.body);
    const prev = doc.data()?.tax_exempt ?? {};
    const profile = {
      ...body,
      last_order_at: prev.last_order_at ?? null,
      verified_by: verified ? request.authUser!.id : null,
      verified_at: verified ? new Date() : null,
    };
    await ref.update({ tax_exempt: profile });
    const check = checkTaxExempt(profile);
    return { success: true, can_order: check.ok, ...(check.ok ? { renew_soon: check.renew_soon } : { reason: check.reason }) };
  });

  // Buyers who cannot order, or whose certificate lapses within a month. The permit number is not listed.
  app.get('/buyers/tax-exempt', pre, async () => {
    const snap = await app.db.collection('markets').get();
    const now = new Date();
    const buyers = snap.docs
      .map((d) => ({ id: d.id, name: d.data().name as string, check: checkTaxExempt(d.data().tax_exempt, now) }))
      .filter((b) => !b.check.ok || b.check.renew_soon)
      .map((b) => ({ id: b.id, name: b.name, ...(b.check.ok ? { status: 'renew_soon' } : { status: b.check.reason }) }));
    return { buyers };
  });

  // ─── Weekly farmer payout ───
  // Build (or rebuild, while still a draft) the sold list for the week before the given day's Tuesday.
  app.post('/payouts/run', pre, async (request, reply) => {
    if (!squareEnabled(app.env)) return reply.status(400).send({ error: 'Square is not configured' });
    const { date } = z.object({ date: day.optional() }).parse(request.body ?? {});
    const run = await buildWeeklyPayout(app.db, app.env, date ? new Date(`${date}T18:00:00Z`) : new Date());
    return { success: true, run };
  });

  app.get('/payouts/:payDay', pre, async (request, reply) => {
    const { payDay } = request.params as { payDay: string };
    const doc = await app.db.collection('payout_runs').doc(payDay).get();
    if (!doc.exists) return reply.status(404).send({ error: 'No payout run for that day' });
    return { run: doc.data() };
  });

  // Mark a run reviewed or paid. Once off draft it is never rebuilt.
  app.put('/payouts/:payDay/status', pre, async (request, reply) => {
    const { payDay } = request.params as { payDay: string };
    const { status } = z.object({ status: z.enum(['draft', 'reviewed', 'paid']) }).parse(request.body);
    const ref = app.db.collection('payout_runs').doc(payDay);
    if (!(await ref.get()).exists) return reply.status(404).send({ error: 'No payout run for that day' });
    await ref.update({ status, status_by: request.authUser!.id, status_at: new Date() });
    return { success: true, status };
  });
}
