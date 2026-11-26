import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { feeAmount, type FeeSnapshot } from './fees.js';
import { isFarmLinkOrder, settleIfPaid } from './order-notify.js';
import { orderPaid, searchOrders, searchOrdersByTime, type SquareOrder } from './square.js';
import { payoutWeek } from '../utils/central-time.js';

/**
 * Weekly farmer payout (LFPP design, Nov 2026).
 *
 * Every Tuesday, each farm is paid for its orders COMPLETED in Square during
 * the Tuesday-to-Monday week before (Central time). Completed means paid in
 * full AND picked up or delivered, so an order picked up on net terms rolls
 * into the week the buyer pays.
 *
 * FarmLink keeps one farm per Square order, so a farm's gross is the sum of its
 * orders' item lines at the farmer's price. Farmer-paid fees saved on each
 * order are taken off; buyer-paid fees are SJCA's and never reach the payout.
 *
 * This builds the sold list only. It moves no money and sends no texts: staff
 * review the run, then enter bills in QuickBooks and pay.
 *
 * Refunds issued during the week are listed for staff to decide (deduct from
 * the farm, or SJCA absorbs it). Nothing is deducted for them automatically.
 */

export interface PayoutFee { name: string; amount: number }
export interface PayoutOrder {
  order_id: string;
  order_number: string;
  buyer_id: string;
  closed_at: string | null;
  gross: number;
  fees: PayoutFee[];
  net: number;
}
export interface FarmPayout {
  farm_id: string;
  farm_name: string;
  orders: PayoutOrder[];
  gross: number;
  fees: number;
  net: number;
}
export interface RefundForReview {
  farm_id: string;
  order_id: string;
  order_number: string;
  refund_id: string;
  amount: number;
  created_at: string | null;
  reason: string | null;
  decision: 'pending';
}
export interface PayoutRun {
  pay_day: string;
  week_start: string;
  week_end: string;
  farms: FarmPayout[];
  refunds_for_review: RefundForReview[];
  /** Orders whose terms row is missing: paid out with no farmer fees, flagged for a look. */
  orders_without_terms: string[];
  /** FarmLink only writes drafts. Staff mark a run reviewed or paid; it is then never rebuilt. */
  status: 'draft' | 'reviewed' | 'paid';
  generated_at: Date;
}

const cents = (n: number) => Math.round(n);
const dollars = (c: number) => Math.round(c) / 100;

/** The farmer's subtotal for an order: item lines at the farmer's price (fees and tax excluded). */
export function farmerSubtotalCents(order: SquareOrder): number {
  return (order.line_items ?? []).reduce((sum, li) => {
    const gross = li.gross_sales_money?.amount ?? (li.base_price_money?.amount ?? 0) * Number(li.quantity);
    return sum + cents(gross);
  }, 0);
}

/** One order's payout line, from its saved terms. */
export function payoutForOrder(order: SquareOrder, terms: { fees?: FeeSnapshot[]; fulfillment?: string } | undefined): PayoutOrder {
  const gross = farmerSubtotalCents(order);
  const fees = (terms?.fees ?? [])
    .filter((f) => f.payer === 'farmer' && f.per === 'order' && (f.applies_to === 'all' || terms?.fulfillment === 'delivery'))
    .map((f) => ({ name: f.name, cents: feeAmount(f, gross) }));
  const feeTotal = fees.reduce((s, f) => s + f.cents, 0);
  return {
    order_id: order.id,
    order_number: order.reference_id ?? order.id,
    buyer_id: order.metadata?.buyer_id ?? '',
    closed_at: order.closed_at ?? null,
    gross: dollars(gross),
    fees: fees.map((f) => ({ name: f.name, amount: dollars(f.cents) })),
    net: dollars(gross - feeTotal),
  };
}

/**
 * Build (or rebuild) the payout run for the week before `run`'s Tuesday and
 * save it to `payout_runs/{pay_day}`. Rebuilding gives the same result for a
 * closed week, so a repeat run is harmless.
 */
export async function buildWeeklyPayout(db: Firestore, env: Env, run: Date = new Date()): Promise<PayoutRun> {
  const week = payoutWeek(run);
  const ref = db.collection('payout_runs').doc(week.payDay);
  const existing = (await ref.get()).data() as PayoutRun | undefined;
  if (existing && existing.status !== 'draft') return existing;

  // Paid orders that were already picked up but never closed in Square (a
  // missed webhook) are closed first, so they land in a week.
  for (const open of await searchOrders(env, { states: ['OPEN'] })) {
    if (isFarmLinkOrder(open) && orderPaid(open) && open.metadata?.picked_up_at) await settleIfPaid(env, open);
  }

  const completed = (await searchOrdersByTime(env, 'closed_at', week.start, week.end)).filter(isFarmLinkOrder);
  const byFarm = new Map<string, PayoutOrder[]>();
  const missingTerms: string[] = [];
  for (const order of completed) {
    const termsDoc = await db.collection('wholesale_orders').doc(order.id).get();
    if (!termsDoc.exists) missingTerms.push(order.reference_id ?? order.id);
    const line = payoutForOrder(order, termsDoc.data() as { fees?: FeeSnapshot[]; fulfillment?: string } | undefined);
    const farmId = order.metadata!.farm_id;
    byFarm.set(farmId, [...(byFarm.get(farmId) ?? []), line]);
  }

  const farms: FarmPayout[] = [];
  for (const [farmId, orders] of byFarm) {
    const farmName = (await db.collection('farms').doc(farmId).get()).data()?.name ?? 'Unknown farm';
    const gross = orders.reduce((s, o) => s + Math.round(o.gross * 100), 0);
    const fees = orders.reduce((s, o) => s + o.fees.reduce((t, f) => t + Math.round(f.amount * 100), 0), 0);
    farms.push({ farm_id: farmId, farm_name: farmName, orders, gross: dollars(gross), fees: dollars(fees), net: dollars(gross - fees) });
  }
  farms.sort((a, b) => a.farm_name.localeCompare(b.farm_name));

  // Refunds made this week on FarmLink orders, whenever the order closed.
  const refunds: RefundForReview[] = [];
  for (const order of (await searchOrdersByTime(env, 'updated_at', week.start, week.end)).filter(isFarmLinkOrder)) {
    for (const r of order.refunds ?? []) {
      const when = r.created_at ? new Date(r.created_at) : null;
      if (!when || when < week.start || when >= week.end) continue;
      if (r.status === 'REJECTED' || r.status === 'FAILED') continue;
      refunds.push({
        farm_id: order.metadata!.farm_id,
        order_id: order.id,
        order_number: order.reference_id ?? order.id,
        refund_id: r.id,
        amount: dollars(r.amount_money?.amount ?? 0),
        created_at: r.created_at ?? null,
        reason: r.reason ?? null,
        decision: 'pending',
      });
    }
  }

  const result: PayoutRun = {
    pay_day: week.payDay,
    week_start: week.startDay,
    week_end: week.endDay,
    farms,
    refunds_for_review: refunds,
    orders_without_terms: missingTerms,
    status: 'draft',
    generated_at: new Date(),
  };
  await ref.set(result);
  return result;
}
