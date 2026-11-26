import type { Firestore } from 'firebase-admin/firestore';

/**
 * Configurable wholesale fees (LFPP design, Nov 2026).
 *
 * A fee is a percent of the farmer's subtotal, a flat amount, or both. Each fee
 * is paid either by the buyer (a Square service charge on the order, so it
 * shows on the invoice) or by the farmer (taken off the weekly payout).
 *
 * Rules live in the `fee_rules` collection so SJCA can change them without a
 * deploy. FarmLink ships with NO amounts: a rule whose percent and flat amount
 * are both unset is a placeholder and is skipped. The rules in force when an
 * order is placed are copied onto the order (`wholesale_orders/{orderId}`), so
 * a later change never rewrites an old order or its payout.
 */

export type FeePayer = 'buyer' | 'farmer';
/** `delivery` rules apply only to delivery orders. */
export type FeeAppliesTo = 'all' | 'delivery';
/**
 * `order`: charged on every order.
 * `buyer_delivery_day`: charged once per buyer per delivery day, on the first
 * order checked in that day. FarmLink keeps one farm per Square order, so a
 * buyer ordering from three farms would otherwise pay three delivery fees.
 * Only buyer-paid rules can use it.
 */
export type FeePer = 'order' | 'buyer_delivery_day';

export interface FeeRule {
  id: string;
  /** Shown to the buyer on the invoice, and on the farmer's sold list. */
  name: string;
  /** Percent of the farmer's subtotal, e.g. 10 for 10%. Null = no percent part. */
  percent: number | null;
  /** Flat amount in cents. Null = no flat part. */
  flat_cents: number | null;
  payer: FeePayer;
  applies_to: FeeAppliesTo;
  per: FeePer;
  /** Optional override scope: the most specific rule with the same `code` wins. */
  farm_id?: string | null;
  buyer_id?: string | null;
  /** Rules sharing a code are versions of one fee (global vs per-farm/buyer override). */
  code: string;
  /** YYYY-MM-DD. The rule applies to orders placed on or after this day. */
  effective_from: string;
  /** YYYY-MM-DD, optional last day. */
  effective_to?: string | null;
  active: boolean;
}

/** The copy of a rule saved on an order. */
export type FeeSnapshot = Pick<FeeRule, 'id' | 'code' | 'name' | 'percent' | 'flat_cents' | 'payer' | 'applies_to' | 'per'>;

export type Fulfillment = 'pickup' | 'delivery';

export function isPlaceholder(rule: Pick<FeeRule, 'percent' | 'flat_cents'>): boolean {
  return (rule.percent === null || rule.percent === undefined) && (rule.flat_cents === null || rule.flat_cents === undefined);
}

/** Problems that make a rule unusable; empty when it is fine. */
export function validateRule(rule: FeeRule): string[] {
  const out: string[] = [];
  if (!rule.name?.trim()) out.push('name is required');
  if (!rule.code?.trim()) out.push('code is required');
  if (rule.percent !== null && rule.percent !== undefined && !(rule.percent > 0 && rule.percent < 100)) out.push('percent must be between 0 and 100');
  if (rule.flat_cents !== null && rule.flat_cents !== undefined && !(Number.isInteger(rule.flat_cents) && rule.flat_cents > 0)) out.push('flat_cents must be a whole number of cents above 0');
  if (rule.per === 'buyer_delivery_day' && rule.payer !== 'buyer') out.push('only buyer-paid fees can be charged once per delivery day');
  if (rule.per === 'buyer_delivery_day' && rule.applies_to !== 'delivery') out.push('a once-per-delivery-day fee must apply to delivery orders only');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.effective_from ?? '')) out.push('effective_from must be YYYY-MM-DD');
  if (rule.effective_to && !/^\d{4}-\d{2}-\d{2}$/.test(rule.effective_to)) out.push('effective_to must be YYYY-MM-DD');
  return out;
}

const specificity = (r: FeeRule) => (r.farm_id ? 1 : 0) + (r.buyer_id ? 2 : 0);

/**
 * The rules that apply to one order, one per code (most specific scope wins).
 * `day` is the order date in Central time, YYYY-MM-DD. Placeholder and invalid
 * rules are returned separately so callers can warn instead of charging.
 */
export function selectRules(
  rules: FeeRule[],
  order: { farmId: string; buyerId: string; fulfillment: Fulfillment; day: string },
): { apply: FeeSnapshot[]; skipped: Array<{ id: string; reason: string }> } {
  const inScope = rules.filter((r) =>
    r.active &&
    (!r.farm_id || r.farm_id === order.farmId) &&
    (!r.buyer_id || r.buyer_id === order.buyerId) &&
    r.effective_from <= order.day &&
    (!r.effective_to || order.day <= r.effective_to),
  );
  const byCode = new Map<string, FeeRule>();
  for (const r of inScope) {
    const prev = byCode.get(r.code);
    if (!prev || specificity(r) > specificity(prev) || (specificity(r) === specificity(prev) && r.effective_from > prev.effective_from)) byCode.set(r.code, r);
  }
  const apply: FeeSnapshot[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const r of byCode.values()) {
    if (r.applies_to === 'delivery' && order.fulfillment !== 'delivery') continue;
    if (isPlaceholder(r)) { skipped.push({ id: r.id, reason: 'amount not set yet' }); continue; }
    const problems = validateRule(r);
    if (problems.length) { skipped.push({ id: r.id, reason: problems.join('; ') }); continue; }
    apply.push({ id: r.id, code: r.code, name: r.name, percent: r.percent ?? null, flat_cents: r.flat_cents ?? null, payer: r.payer, applies_to: r.applies_to, per: r.per });
  }
  apply.sort((a, b) => a.code.localeCompare(b.code));
  return { apply, skipped };
}

/** Cents a fee comes to on a farmer subtotal (percent rounded to the cent, plus flat). */
export function feeAmount(fee: Pick<FeeSnapshot, 'percent' | 'flat_cents'>, subtotalCents: number): number {
  const pct = fee.percent ? Math.round((subtotalCents * fee.percent) / 100) : 0;
  return pct + (fee.flat_cents ?? 0);
}

export async function loadFeeRules(db: Firestore): Promise<FeeRule[]> {
  const snap = await db.collection('fee_rules').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FeeRule, 'id'>) }));
}

/**
 * Square service charges for a buyer-paid fee. Square takes a percentage or an
 * amount per charge, not both, so a rule with both becomes two charges. The
 * uid marks the rule, so a charge is never added twice.
 */
export function serviceChargesFor(fee: FeeSnapshot, taxIds: string[]): Array<Record<string, unknown>> {
  const taxed = taxIds.length > 0;
  const base = {
    calculation_phase: 'SUBTOTAL_PHASE',
    taxable: taxed,
    ...(taxed ? { applied_taxes: taxIds.map((_, i) => ({ tax_uid: `feetax-${i}` })) } : {}),
  };
  const out: Array<Record<string, unknown>> = [];
  if (fee.percent) out.push({ ...base, uid: feeUid(fee, 'pct'), name: fee.name, percentage: String(fee.percent) });
  if (fee.flat_cents) out.push({ ...base, uid: feeUid(fee, 'flat'), name: fee.name, amount_money: { amount: fee.flat_cents, currency: 'USD' } });
  return out;
}

export function feeUid(fee: Pick<FeeSnapshot, 'code'>, part: 'pct' | 'flat'): string {
  return `fee-${fee.code}-${part}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
}

/** Order-level taxes that buyer fees reference (LINE_ITEM scope: they touch only what names them). */
export function feeTaxes(taxIds: string[]): Array<Record<string, unknown>> {
  return taxIds.map((id, i) => ({ uid: `feetax-${i}`, catalog_object_id: id, scope: 'LINE_ITEM' }));
}

export const splitIds = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
