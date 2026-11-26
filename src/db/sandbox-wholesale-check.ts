/**
 * Square SANDBOX check for the wholesale updates (Nov 2026).
 *
 *   npm run emulators            # terminal 1
 *   npm run seed                 # once, links the test farm and buyer to Square sandbox
 *   npm run sandbox:wholesale    # this check
 *
 * Runs the real order code against the Square sandbox and the local Firestore
 * emulator, and prints PASS or FAIL for each step:
 *   1. a buyer with no tax certificate is blocked
 *   2. a delivery order goes in with no tax, auto-tax off, blocked taxes and the per-order fee
 *   3. confirming does not invoice
 *   4. check-in with one item short and one item missing fixes the lines,
 *      adds the once-per-day delivery fee, and creates the invoice
 *   5. a second delivery order the same day gets no second delivery fee
 *   6. the weekly payout search runs against Square
 * Then it cancels both orders (which cancels their invoices) and removes or
 * restores everything it set up in the emulator.
 *
 * It refuses to run unless SQUARE_ENVIRONMENT=sandbox and NODE_ENV is not
 * production, so it can never touch the live Square account. Texts are
 * simulated by the send guard. Fee amounts and prices here are TEST VALUES
 * only; SJCA's real fees stay unset until SJCA decides them.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getEnv } from '../config/env.js';
import { getDb } from './firestore.js';
import { squareOrderCreate, squareOrderUpdate } from '../tools/orders-square.js';
import type { ToolContext } from '../tools/index.js';
import {
  createFarmItem, findFarmItem, getInvoice, getOrder, receiveStock, resolveUnitId, squareEnabled, squareRequest, type SquareOrder,
} from '../services/square.js';
import { splitIds } from '../services/fees.js';
import { buildWeeklyPayout } from '../services/payouts.js';
import { payoutWeek } from '../utils/central-time.js';

const FARM_ID = 'farm-panama';
const FARM_USER = 'user-panama';
const BUYER_ID = 'buyer-test';
const BUYER_USER = 'user-buyer';
const FEE_SERVICE = 'sandbox-check-service';
const FEE_DELIVERY = 'sandbox-check-delivery';
// Test values only.
const SERVICE_PERCENT = 5;
const DELIVERY_CENTS = 500;
const ITEM_A = { name: 'Sandbox Check Tomatoes', price: 4 };
const ITEM_B = { name: 'Sandbox Check Squash', price: 2.5 };

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`);
}

/** The full order as Square returns it, including fields FarmLink does not type. */
async function rawOrder(env: ReturnType<typeof getEnv>, id: string): Promise<Record<string, any>> {
  return (await squareRequest<{ order: Record<string, any> }>(env, 'GET', `/v2/orders/${encodeURIComponent(id)}`)).order;
}

async function assertEmulatorUp(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return; // getDb() reports this case
  try {
    await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`The Firestore emulator is not running at ${host}. Start it with \`npm run emulators\` in another terminal.`);
  }
}

async function main() {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production.');
  if (env.SQUARE_ENVIRONMENT !== 'sandbox') throw new Error('Refusing to run: SQUARE_ENVIRONMENT must be sandbox.');
  if (!squareEnabled(env)) throw new Error('SQUARE_ACCESS_TOKEN is blank. Put your Square sandbox token in .env.');
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID is blank. Put a sandbox location id in .env.');
  await assertEmulatorUp();
  const db = getDb();

  const [farmDoc, buyerDoc] = await Promise.all([db.collection('farms').doc(FARM_ID).get(), db.collection('markets').doc(BUYER_ID).get()]);
  const farm = farmDoc.data();
  const buyerBefore = buyerDoc.data();
  if (!farm?.square_vendor_id || !buyerBefore?.square_customer_id) {
    throw new Error('The test farm or buyer is not linked to Square. Run `npm run seed` first (with the sandbox token in .env).');
  }

  const runId = `sandbox-check-${Date.now()}`;
  const ctx = (userId: string, step: string): ToolContext => ({ db, env, userId, phone: '+15015550100', messageId: `${runId}-${step}` });
  const orderIds: string[] = [];
  const payoutDay = payoutWeek(new Date()).payDay;
  const payoutExisted = (await db.collection('payout_runs').doc(payoutDay).get()).exists;
  const blockIds = splitIds(env.SQUARE_EXEMPT_BLOCK_TAX_IDS);

  console.log(`Square sandbox check ${runId}\n`);
  try {
    // ── Setup: two test items with stock, two test fee rules ──
    const unitId = await resolveUnitId(env, 'lb');
    const items = [];
    for (const it of [ITEM_A, ITEM_B]) {
      const found = await findFarmItem(env, { name: farm.name, vendorId: farm.square_vendor_id }, it.name);
      const item = found ?? await createFarmItem(env, { farmName: farm.name, vendorId: farm.square_vendor_id, productName: it.name, price: it.price, unitId, key: `sandbox-check|${it.name}` });
      await receiveStock(env, item.variation_id, 5, `${runId}|${it.name}`);
      items.push(item);
    }
    const [a, b] = items;
    const rule = { payer: 'buyer', buyer_id: BUYER_ID, farm_id: null, effective_from: '2020-01-01', effective_to: null, active: true };
    await db.collection('fee_rules').doc(FEE_SERVICE).set({ ...rule, name: 'Service fee (test)', code: FEE_SERVICE, percent: SERVICE_PERCENT, flat_cents: null, applies_to: 'all', per: 'order' });
    await db.collection('fee_rules').doc(FEE_DELIVERY).set({ ...rule, name: 'Delivery fee (test)', code: FEE_DELIVERY, percent: null, flat_cents: DELIVERY_CENTS, applies_to: 'delivery', per: 'buyer_delivery_day' });

    // ── 1. No certificate: blocked ──
    await db.collection('markets').doc(BUYER_ID).update({ tax_exempt: FieldValue.delete() });
    const blocked = await squareOrderCreate({ farm_id: FARM_ID, market_id: BUYER_ID, items: [{ inventory_id: a.variation_id, quantity: 1 }] }, ctx(BUYER_USER, 'blocked')) as Record<string, any>;
    check(blocked.error === 'tax_certificate_missing', '1. Buyer with no tax certificate cannot order', blocked);

    // Give the test buyer a verified certificate and a (fictional) delivery address.
    const today = new Date().toISOString().slice(0, 10);
    await db.collection('markets').doc(BUYER_ID).update({
      tax_exempt: { status: 'exempt_resale', certificate_type: 'ST-391', signed_date: today, verified_at: new Date(), verified_by: 'sandbox-check', last_order_at: null },
      physical_address: { street: '100 Test St', city: 'Little Rock', state: 'AR', zip: '72201' },
    });

    // ── 2. Delivery order ──
    const created = await squareOrderCreate({
      farm_id: FARM_ID, market_id: BUYER_ID, fulfillment: 'delivery',
      items: [{ inventory_id: a.variation_id, quantity: 3 }, { inventory_id: b.variation_id, quantity: 2 }],
      notes: 'FarmLink sandbox check',
    }, ctx(BUYER_USER, 'order1')) as Record<string, any>;
    check(created.success === true, '2. Delivery order created', created);
    if (!created.success) return;
    orderIds.push(created.order_id);
    let o1 = await rawOrder(env, created.order_id);
    check(o1.fulfillments?.[0]?.type === 'DELIVERY', '2a. Square order is a DELIVERY', o1.fulfillments?.[0]?.type);
    check(o1.fulfillments?.[0]?.delivery_details?.recipient?.address?.postal_code === '72201', '2b. Delivery address is on the order', o1.fulfillments?.[0]?.delivery_details?.recipient?.address);
    check(o1.pricing_options?.auto_apply_taxes === false, '2c. Auto-apply taxes is off', o1.pricing_options);
    check((o1.total_tax_money?.amount ?? 0) === 0, '2d. No tax on the order', o1.total_tax_money);
    if (blockIds.length) {
      const allBlocked = (o1.line_items ?? []).every((li: any) => blockIds.every((id) => (li.pricing_blocklists?.blocked_taxes ?? []).some((t: any) => t.tax_catalog_object_id === id)));
      check(allBlocked, '2e. Every line blocks the seller taxes', (o1.line_items ?? []).map((li: any) => li.pricing_blocklists));
    } else {
      console.log('SKIP  2e. Blocked taxes (SQUARE_EXEMPT_BLOCK_TAX_IDS is blank in .env)');
    }
    const serviceUid = `fee-${FEE_SERVICE}-pct`;
    check((o1.service_charges ?? []).some((sc: any) => sc.uid === serviceUid), '2f. Per-order service fee is on the order', o1.service_charges);
    check(!(o1.service_charges ?? []).some((sc: any) => sc.uid === `fee-${FEE_DELIVERY}-flat`), '2g. Delivery fee waits for check-in', o1.service_charges);
    const terms = (await db.collection('wholesale_orders').doc(created.order_id).get()).data();
    const termIds = (terms?.fees ?? []).map((f: any) => f.id);
    check(terms?.fulfillment === 'delivery' && termIds.includes(FEE_SERVICE) && termIds.includes(FEE_DELIVERY), '2h. Order terms saved for the payout', terms);

    // ── 3. Confirm: no invoice yet ──
    const confirmed = await squareOrderUpdate({ order_id: created.order_id, status: 'confirmed' }, ctx(FARM_USER, 'confirm1')) as Record<string, any>;
    o1 = await rawOrder(env, created.order_id);
    check(confirmed.success === true && !confirmed.invoice && !o1.metadata?.invoice_id, '3. Confirming does not invoice', confirmed);

    // ── 4. Check-in: tomatoes 3 → 2, squash 2 → 0 ──
    const checkedIn = await squareOrderUpdate({
      order_id: created.order_id, status: 'in_transit',
      received_items: [{ inventory_id: a.variation_id, quantity: 2 }, { inventory_id: b.variation_id, quantity: 0 }],
    }, ctx(FARM_USER, 'checkin1')) as Record<string, any>;
    check(checkedIn.success === true && !checkedIn.invoice_error, '4. Check-in succeeded', checkedIn);
    o1 = await rawOrder(env, created.order_id);
    const lines = o1.line_items ?? [];
    check(lines.length === 1 && lines[0].catalog_object_id === a.variation_id && lines[0].quantity === '2', '4a. Short item fixed and missing item removed', lines.map((l: any) => [l.name, l.quantity]));
    const deliveryUid = `fee-${FEE_DELIVERY}-flat`;
    const deliveryFee = (o1.service_charges ?? []).find((sc: any) => sc.uid === deliveryUid);
    check(deliveryFee?.amount_money?.amount === DELIVERY_CENTS, '4b. Delivery fee added at check-in', o1.service_charges);
    const subtotal = Math.round(ITEM_A.price * 100) * 2;
    const serviceFee = (o1.service_charges ?? []).find((sc: any) => sc.uid === serviceUid);
    check((serviceFee?.total_money ?? serviceFee?.applied_money)?.amount === Math.round(subtotal * SERVICE_PERCENT / 100), '4c. Service fee is figured on the received quantity', serviceFee);
    check((o1.total_tax_money?.amount ?? 0) === 0, '4d. Still no tax, fees included', o1.total_tax_money);
    const expectedTotal = subtotal + Math.round(subtotal * SERVICE_PERCENT / 100) + DELIVERY_CENTS;
    check(o1.total_money?.amount === expectedTotal, `4e. Order total is $${(expectedTotal / 100).toFixed(2)}`, o1.total_money);
    const invoiceId = o1.metadata?.invoice_id;
    const invoice = invoiceId ? await getInvoice(env, invoiceId) : undefined;
    check(invoice?.status === 'UNPAID', '4f. Invoice created and published at check-in', invoice ?? o1.metadata);

    // ── 5. Second order, same buyer and delivery day: no second delivery fee ──
    const second = await squareOrderCreate({ farm_id: FARM_ID, market_id: BUYER_ID, fulfillment: 'delivery', items: [{ inventory_id: a.variation_id, quantity: 1 }] }, ctx(BUYER_USER, 'order2')) as Record<string, any>;
    check(second.success === true, '5. Second delivery order created', second);
    if (second.success) {
      orderIds.push(second.order_id);
      const sameDay = (await db.collection('wholesale_orders').doc(second.order_id).get()).data()?.delivery_day === terms?.delivery_day;
      if (!sameDay) console.log('NOTE  5. The two orders landed on different delivery days (run near midnight), so 5a does not apply.');
      await squareOrderUpdate({ order_id: second.order_id, status: 'confirmed' }, ctx(FARM_USER, 'confirm2'));
      await squareOrderUpdate({ order_id: second.order_id, status: 'in_transit' }, ctx(FARM_USER, 'checkin2'));
      const o2 = await rawOrder(env, second.order_id);
      if (sameDay) check(!(o2.service_charges ?? []).some((sc: any) => sc.uid === deliveryUid), '5a. No second delivery fee the same day', o2.service_charges);
      check(!!o2.metadata?.invoice_id, '5b. Second order invoiced at check-in', o2.metadata);
    }

    // ── 6. Weekly payout search ──
    try {
      const run = await buildWeeklyPayout(db, env, new Date());
      check(typeof run.pay_day === 'string' && Array.isArray(run.farms), `6. Weekly payout search runs (week ${run.week_start} to ${run.week_end}, ${run.farms.length} farm(s))`);
    } catch (err) {
      check(false, '6. Weekly payout search runs', err instanceof Error ? err.message : err);
    }
  } finally {
    // ── Cleanup ──
    for (const id of orderIds) {
      try {
        const res = await squareOrderUpdate({ order_id: id, status: 'cancelled' }, ctx(FARM_USER, `cancel-${id}`)) as Record<string, any>;
        const o: SquareOrder = await getOrder(env, id);
        console.log(`${o.state === 'CANCELED' ? 'done' : 'WARN'}  Cleanup: order ${o.reference_id ?? id} ${o.state === 'CANCELED' ? 'cancelled' : `not cancelled (${res.error ?? o.state})`}`);
      } catch (err) {
        console.log(`WARN  Cleanup: could not cancel order ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await Promise.all([FEE_SERVICE, FEE_DELIVERY].map((id) => db.collection('fee_rules').doc(id).delete()));
    const dayFees = await db.collection('delivery_day_fees').where('buyer_id', '==', BUYER_ID).get();
    await Promise.all(dayFees.docs.filter((d) => orderIds.includes(d.data().order_id)).map((d) => d.ref.delete()));
    if (!payoutExisted) await db.collection('payout_runs').doc(payoutDay).delete();
    await db.collection('markets').doc(BUYER_ID).update({
      tax_exempt: buyerBefore.tax_exempt ?? FieldValue.delete(),
      physical_address: buyerBefore.physical_address ?? FieldValue.delete(),
    });
    console.log('done  Cleanup: test fee rules removed, test buyer restored');
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
}

main().then(() => process.exit(failures ? 1 : 0)).catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
