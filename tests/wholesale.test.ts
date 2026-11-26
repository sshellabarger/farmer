// Wholesale updates (Nov 2026): fees, tax-exempt buyers, payout week and payout run.
// Fee amounts here are test values only; real amounts are SJCA settings.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { feeAmount, selectRules, serviceChargesFor, validateRule, type FeeRule } from '../src/services/fees.js';
import { checkTaxExempt } from '../src/services/tax-exempt.js';
import { centralDay, centralMidnight, payoutWeek } from '../src/utils/central-time.js';
import { buildWeeklyPayout, payoutForOrder } from '../src/services/payouts.js';
import type { Env } from '../src/config/env.js';

const rule = (over: Partial<FeeRule> = {}): FeeRule => ({
  id: 'r1', code: 'service', name: 'Service fee', percent: 7, flat_cents: null, payer: 'buyer',
  applies_to: 'all', per: 'order', effective_from: '2026-01-01', active: true, ...over,
});
const order = { farmId: 'f1', buyerId: 'b1', fulfillment: 'pickup' as const, day: '2026-11-26' };

describe('fee rules', () => {
  it('skips placeholders instead of charging them', () => {
    const r = selectRules([rule({ percent: null, flat_cents: null })], order);
    expect(r.apply).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'r1', reason: 'amount not set yet' }]);
  });

  it('lets a per-farm or per-buyer override win over the general rule', () => {
    const rules = [rule(), rule({ id: 'farm', farm_id: 'f1', percent: 5 }), rule({ id: 'buyer', buyer_id: 'b1', percent: 3 }), rule({ id: 'other', buyer_id: 'b9', percent: 1 })];
    expect(selectRules(rules, order).apply.map((f) => f.id)).toEqual(['buyer']);
    expect(selectRules(rules, { ...order, buyerId: 'b2' }).apply.map((f) => f.id)).toEqual(['farm']);
  });

  it('applies a rule only to orders placed inside its dates, and delivery fees only to deliveries', () => {
    expect(selectRules([rule({ effective_from: '2026-12-01' })], order).apply).toEqual([]);
    expect(selectRules([rule({ effective_to: '2026-11-25' })], order).apply).toEqual([]);
    const delivery = rule({ id: 'd', code: 'delivery', percent: null, flat_cents: 500, applies_to: 'delivery', per: 'buyer_delivery_day' });
    expect(selectRules([delivery], order).apply).toEqual([]);
    expect(selectRules([delivery], { ...order, fulfillment: 'delivery' }).apply.map((f) => f.id)).toEqual(['d']);
  });

  it('refuses rules that cannot work', () => {
    expect(validateRule(rule({ per: 'buyer_delivery_day', payer: 'farmer', applies_to: 'delivery' }))).toContain('only buyer-paid fees can be charged once per delivery day');
    expect(validateRule(rule({ percent: 150 }))).toContain('percent must be between 0 and 100');
    expect(validateRule(rule({ flat_cents: 2.5 }))).toContain('flat_cents must be a whole number of cents above 0');
  });

  it('works out percent plus flat, and splits it into two Square charges', () => {
    const both = { ...rule({ percent: 10, flat_cents: 1000 }) };
    expect(feeAmount(both, 10000)).toBe(2000);
    expect(feeAmount({ percent: 10, flat_cents: null }, 1005)).toBe(101);
    const charges = serviceChargesFor(both, []);
    expect(charges).toEqual([
      { calculation_phase: 'SUBTOTAL_PHASE', taxable: false, uid: 'fee-service-pct', name: 'Service fee', percentage: '10' },
      { calculation_phase: 'SUBTOTAL_PHASE', taxable: false, uid: 'fee-service-flat', name: 'Service fee', amount_money: { amount: 1000, currency: 'USD' } },
    ]);
    expect(serviceChargesFor(both, ['TAX1'])[0]).toMatchObject({ taxable: true, applied_taxes: [{ tax_uid: 'feetax-0' }] });
  });
});

describe('tax-exempt buyers', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const verified = { status: 'exempt_resale' as const, certificate_type: 'ST-391' as const, signed_date: '2026-01-10', verified_at: '2026-01-11' };

  it('blocks buyers with no certificate, an unverified one, or taxable status', () => {
    expect(checkTaxExempt(undefined, now)).toMatchObject({ ok: false, reason: 'missing' });
    expect(checkTaxExempt({ ...verified, verified_at: null }, now)).toMatchObject({ ok: false, reason: 'not_verified' });
    expect(checkTaxExempt({ status: 'taxable' }, now)).toMatchObject({ ok: false, reason: 'taxable' });
  });

  it('lapses 12 months after the last order and flags renewal at 11', () => {
    expect(checkTaxExempt({ ...verified, last_order_at: '2026-10-01' }, now)).toEqual({ ok: true, renew_soon: false, certificate_type: 'ST-391' });
    expect(checkTaxExempt({ ...verified, last_order_at: '2025-12-20' }, now)).toMatchObject({ ok: true, renew_soon: true });
    expect(checkTaxExempt({ ...verified, last_order_at: '2025-11-20' }, now)).toMatchObject({ ok: false, reason: 'lapsed' });
    // No order yet: counted from the signing date.
    expect(checkTaxExempt({ ...verified, signed_date: '2025-11-01' }, now)).toMatchObject({ ok: false, reason: 'lapsed' });
  });
});

describe('payout week', () => {
  it('pays on Tuesday for the Tuesday to Monday before, in Central time', () => {
    const w = payoutWeek(new Date('2026-12-01T14:00:00Z')); // Tue Dec 1, 8am CST
    expect(w).toMatchObject({ payDay: '2026-12-01', startDay: '2026-11-24', endDay: '2026-11-30' });
    expect(w.start.toISOString()).toBe('2026-11-24T06:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-12-01T06:00:00.000Z');
    // Run late on Monday night Central (already Tuesday in UTC): still the previous pay day.
    expect(payoutWeek(new Date('2026-12-01T04:30:00Z')).payDay).toBe('2026-11-24');
  });

  it('handles daylight saving time', () => {
    expect(centralMidnight('2026-07-14').toISOString()).toBe('2026-07-14T05:00:00.000Z');
    expect(centralMidnight('2026-03-08').toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(centralDay(new Date('2026-07-14T04:59:00Z'))).toBe('2026-07-13');
  });
});

const sqOrder = (over: Record<string, unknown> = {}) => ({
  id: 'O1', version: 1, state: 'COMPLETED', reference_id: 'ORD-1', closed_at: '2026-11-25T18:00:00Z',
  metadata: { farm_id: 'f1', buyer_id: 'b1' },
  line_items: [{ uid: 'l1', quantity: '5', base_price_money: { amount: 400 } }, { uid: 'l2', quantity: '2', base_price_money: { amount: 250 } }],
  service_charges: [{ name: 'Service fee', total_money: { amount: 175 } }],
  ...over,
});

describe('payout per order', () => {
  it('pays the farmer price less farmer-paid fees; buyer fees never reach the farmer', () => {
    const fees = [
      { ...rule({ id: 'a', code: 'commission', name: 'Commission', percent: 10, payer: 'farmer' }) },
      { ...rule({ id: 'b', code: 'handling', name: 'Handling', percent: null, flat_cents: 100, payer: 'farmer', applies_to: 'delivery' }) },
      { ...rule({ id: 'c', code: 'service', payer: 'buyer' }) },
    ];
    const pickup = payoutForOrder(sqOrder() as any, { fees, fulfillment: 'pickup' });
    expect(pickup).toMatchObject({ gross: 25, net: 22.5, fees: [{ name: 'Commission', amount: 2.5 }] });
    const delivery = payoutForOrder(sqOrder() as any, { fees, fulfillment: 'delivery' });
    expect(delivery).toMatchObject({ gross: 25, net: 21.5 });
    expect(payoutForOrder(sqOrder() as any, undefined)).toMatchObject({ gross: 25, net: 25, fees: [] });
  });
});

describe('weekly payout run', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('totals completed FarmLink orders per farm, lists refunds for review, and saves a draft', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['farms/f1', { name: 'Test Farm' }],
      ['wholesale_orders/O1', { fulfillment: 'pickup', fees: [rule({ code: 'commission', name: 'Commission', percent: 10, payer: 'farmer' })] }],
    ]);
    const db = { collection: (name: string) => ({ doc: (id: string) => ({
      get: async () => ({ exists: store.has(`${name}/${id}`), data: () => store.get(`${name}/${id}`) }),
      set: async (d: Record<string, unknown>) => { store.set(`${name}/${id}`, d); },
    }) }) } as unknown as FirebaseFirestore.Firestore;
    const searches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      searches.push(body.query.filter);
      const f = body.query.filter;
      let orders: unknown[] = [];
      if (f.date_time_filter?.closed_at) orders = [sqOrder(), sqOrder({ id: 'POS', metadata: undefined }), sqOrder({ id: 'O2', reference_id: 'ORD-2', metadata: { farm_id: 'f1', buyer_id: 'b2' } })];
      if (f.date_time_filter?.updated_at) orders = [sqOrder({ id: 'O3', reference_id: 'ORD-3', refunds: [
        { id: 'R1', status: 'APPROVED', created_at: '2026-11-27T15:00:00Z', amount_money: { amount: 800 }, reason: 'Bruised' },
        { id: 'R0', status: 'APPROVED', created_at: '2026-11-10T15:00:00Z', amount_money: { amount: 100 } },
      ] })];
      return { ok: true, status: 200, json: async () => ({ orders }) };
    }));
    const env = { NODE_ENV: 'test', SQUARE_ACCESS_TOKEN: 't', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_LOCATION_ID: 'WHOLESALE' } as Env;

    const run = await buildWeeklyPayout(db, env, new Date('2026-12-01T14:00:00Z'));
    expect(run).toMatchObject({ pay_day: '2026-12-01', week_start: '2026-11-24', week_end: '2026-11-30', status: 'draft' });
    expect(run.farms).toHaveLength(1);
    expect(run.farms[0]).toMatchObject({ farm_name: 'Test Farm', gross: 50, fees: 2.5, net: 47.5 });
    expect(run.orders_without_terms).toEqual(['ORD-2']);
    expect(run.refunds_for_review).toEqual([expect.objectContaining({ refund_id: 'R1', amount: 8, order_number: 'ORD-3', decision: 'pending' })]);
    expect(searches.find((f) => f.date_time_filter?.closed_at).date_time_filter.closed_at)
      .toEqual({ start_at: '2026-11-24T06:00:00.000Z', end_at: '2026-12-01T06:00:00.000Z' });
    expect(store.get('payout_runs/2026-12-01')).toMatchObject({ status: 'draft' });

    // A run staff marked as paid is never rebuilt.
    store.set('payout_runs/2026-12-01', { ...run, status: 'paid', farms: [] });
    expect((await buildWeeklyPayout(db, env, new Date('2026-12-01T14:00:00Z'))).farms).toEqual([]);
  });
});
