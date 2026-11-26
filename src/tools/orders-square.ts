import { v4 as uuid } from 'uuid';
import type { ToolContext } from './index.js';
import { DEPOT } from '../config/depot.js';
import { calculateNextDropoff } from '../services/order-notifications.js';
import { notifyOrder, orderStatus, paymentStatus, settleIfPaid, type Status } from '../services/order-notify.js';
import {
  cancelInvoice, committedQuantities, createAndPublishInvoice, createWholesaleOrder, getInvoice, getOrder, getStockCounts,
  listFarmItems, orderPaid, searchOrders, updateOrder, type FulfillmentState, type OrderAddress, type SquareInvoice, type SquareOrder,
} from '../services/square.js';
import { feeTaxes, loadFeeRules, selectRules, serviceChargesFor, splitIds, type FeeSnapshot, type Fulfillment } from '../services/fees.js';
import { checkTaxExempt } from '../services/tax-exempt.js';
import { centralDay } from '../utils/central-time.js';

export { orderStatus, paymentStatus };

/**
 * Square-backed order tools (handoff 04, build step 4; wholesale updates Nov 2026).
 * The order lives in Square: an Order at the wholesale Location with a PICKUP
 * or DELIVERY fulfillment, the buyer as Customer, one farm per order. The farm
 * and buyer ids ride on the order's metadata. The app DB keeps only what Square
 * can't: `wholesale_orders/{orderId}` holds the fee rules in force when the
 * order was placed and the buyer's tax status, for the weekly payout.
 *
 * Flow: placed (pending) → farm confirms (confirmed) → farmer drops off and
 * the order is checked in, short items fixed, invoice sent (in_transit) →
 * picked up or delivered (delivered) → paid → Square completes it.
 */


const TO_FULFILLMENT: Record<Status, FulfillmentState> = {
  pending: 'PROPOSED', confirmed: 'RESERVED', in_transit: 'PREPARED', delivered: 'COMPLETED', cancelled: 'CANCELED',
};

const dollars = (m?: { amount: number }) => (m ? m.amount / 100 : 0);

const fulfillmentOf = (order: SquareOrder): Fulfillment => (order.fulfillments?.[0]?.type === 'DELIVERY' ? 'delivery' : 'pickup');
const scheduledAt = (order: SquareOrder) => {
  const f = order.fulfillments?.[0];
  return f?.delivery_details?.deliver_at ?? f?.pickup_details?.pickup_at ?? null;
};

function summary(order: SquareOrder) {
  return {
    id: order.id,
    order_number: order.reference_id ?? order.id,
    status: orderStatus(order),
    payment: paymentStatus(order),
    total: dollars(order.total_money),
    order_date: order.created_at ?? null,
    fulfillment: fulfillmentOf(order),
    scheduled_at: scheduledAt(order),
    notes: order.fulfillments?.[0]?.pickup_details?.note ?? order.fulfillments?.[0]?.delivery_details?.note ?? null,
    items: (order.line_items ?? []).map((li) => ({ inventory_id: li.catalog_object_id ?? null, product_name: li.name ?? '', quantity: Number(li.quantity), line_total: dollars(li.total_money) })),
    fees: (order.service_charges ?? []).map((sc) => ({ name: sc.name ?? '', amount: dollars(sc.total_money ?? sc.applied_money) })),
  };
}

async function isAdmin(ctx: ToolContext): Promise<boolean> {
  if (!ctx.userId) return false;
  return (await ctx.db.collection('users').doc(ctx.userId).get()).data()?.role === 'admin';
}

function addressOf(buyer: FirebaseFirestore.DocumentData): OrderAddress | null {
  const a = buyer.physical_address;
  return a?.street && a?.city && a?.state && a?.zip ? { street: a.street, city: a.city, state: a.state, zip: a.zip } : null;
}

async function parties(ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { farmId: undefined, buyerId: undefined };
  const [farmSnap, buyerSnap] = await Promise.all([
    db.collection('farms').where('user_id', '==', userId).limit(1).get(),
    db.collection('markets').where('user_id', '==', userId).limit(1).get(),
  ]);
  return { farmId: farmSnap.empty ? undefined : farmSnap.docs[0].id, buyerId: buyerSnap.empty ? undefined : buyerSnap.docs[0].id };
}

export async function squareOrderCreate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;
  if (!userId) throw new Error('User not registered');
  const farmId = String(input.farm_id ?? '');
  const buyerId = String(input.market_id ?? '');
  const items = (input.items as Array<{ inventory_id: string; quantity: number }> | undefined) ?? [];
  if (!farmId || !buyerId || items.length === 0) return { error: 'invalid_input', message: 'A farm, a buyer and at least one item are required.' };

  // Only the buyer themself, or the farm entering an order for its buyer, may create it.
  const me = await parties(ctx);
  if (me.buyerId !== buyerId && me.farmId !== farmId) return { error: 'not_allowed', message: 'You can only place orders for your own account.' };

  const [farmDoc, buyerDoc] = await Promise.all([db.collection('farms').doc(farmId).get(), db.collection('markets').doc(buyerId).get()]);
  const farm = farmDoc.data();
  const buyer = buyerDoc.data();
  if (!farmDoc.exists || !farm?.square_vendor_id) return { error: 'farm_not_linked', message: 'That farm is not set up in Square yet.' };
  if (!buyerDoc.exists || !buyer?.square_customer_id) return { error: 'buyer_not_linked', message: 'That buyer is not set up as a customer in Square yet. An admin needs to link it.' };

  // Wholesale buyers are tax exempt: no order until a verified certificate is on file and current.
  const tax = checkTaxExempt(buyer.tax_exempt);
  if (!tax.ok) return { error: `tax_certificate_${tax.reason}`, message: tax.message };

  const requested = input.fulfillment ?? (buyer.delivery_pref === 'delivery' ? 'delivery' : 'pickup');
  if (requested !== 'pickup' && requested !== 'delivery') return { error: 'invalid_input', message: 'Fulfillment must be pickup or delivery.' };
  const fulfillment: Fulfillment = requested;
  const address = fulfillment === 'delivery' ? addressOf(buyer) : null;
  if (fulfillment === 'delivery' && !address) return { error: 'no_delivery_address', message: 'We need a delivery address on file for this buyer before we can deliver.' };

  // Every line must be one of this farm's items (vendor-checked), with enough uncommitted stock.
  const farmItems = new Map((await listFarmItems(env, { name: farm.name, vendorId: farm.square_vendor_id })).map((i) => [i.variation_id, i]));
  const wanted = new Map<string, number>();
  for (const it of items) {
    const qty = Number(it.quantity);
    if (!(qty > 0)) return { error: 'invalid_input', message: 'Quantities must be above zero.' };
    if (!farmItems.has(it.inventory_id)) return { error: 'item_not_found', message: `Item ${it.inventory_id} is not one of ${farm.name}'s listings. Use the id from inventory_query.` };
    wanted.set(it.inventory_id, (wanted.get(it.inventory_id) ?? 0) + qty);
  }
  const ids = [...wanted.keys()];
  const [counts, committed] = await Promise.all([getStockCounts(env, ids), committedQuantities(env)]);
  for (const [id, qty] of wanted) {
    const available = (counts.get(id) ?? 0) - (committed.get(id) ?? 0);
    if (available < qty) {
      return { error: 'insufficient_stock', product_name: farmItems.get(id)!.product_name, available: Math.max(0, available), message: `Only ${Math.max(0, available)} available.` };
    }
  }

  const slot = Array.isArray(farm.delivery_schedule) && farm.delivery_schedule.length > 0 ? calculateNextDropoff(farm.delivery_schedule) : null;
  // Square needs a pickup/delivery time; with no drop-off schedule use a 48h placeholder and report none.
  const at = slot?.date ?? new Date(Date.now() + 48 * 3600 * 1000);

  // Fees in force today, copied onto the order. Per-order buyer fees go on the
  // Square order now; once-per-delivery-day fees wait for check-in.
  const now = new Date();
  const fees = selectRules(await loadFeeRules(db), { farmId, buyerId, fulfillment, day: centralDay(now) });
  const feeTaxIds = splitIds(env.SQUARE_FEE_TAX_IDS);
  const perOrderBuyerFees = fees.apply.filter((f) => f.payer === 'buyer' && f.per === 'order');

  const key = ctx.messageId ? `${ctx.messageId}|${buyerId}|${farmId}` : uuid();
  const order = await createWholesaleOrder(env, {
    customerId: buyer.square_customer_id,
    buyerName: buyer.name,
    orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
    metadata: { farm_id: farmId, buyer_id: buyerId },
    lines: [...wanted].map(([variationId, quantity]) => ({ variationId, quantity })),
    at,
    note: input.notes ? String(input.notes) : undefined,
    key,
    fulfillment,
    ...(address ? { address } : {}),
    serviceCharges: perOrderBuyerFees.flatMap((f) => serviceChargesFor(f, feeTaxIds)),
    taxes: perOrderBuyerFees.length && feeTaxIds.length ? feeTaxes(feeTaxIds) : [],
    blockTaxIds: splitIds(env.SQUARE_EXEMPT_BLOCK_TAX_IDS),
  });

  // The order's terms, for check-in and the weekly payout. Keyed by the Square
  // order id, so a retried message rewrites the same row.
  await db.collection('wholesale_orders').doc(order.id).set({
    farm_id: farmId,
    buyer_id: buyerId,
    fulfillment,
    delivery_day: fulfillment === 'delivery' ? centralDay(at) : null,
    fees: fees.apply,
    fees_skipped: fees.skipped,
    tax: { status: buyer.tax_exempt.status, certificate_type: tax.certificate_type },
    created_at: now,
  });
  // The blanket certificate stays current while the buyer keeps ordering.
  await db.collection('markets').doc(buyerId).update({ 'tax_exempt.last_order_at': now })
    .catch((err: unknown) => console.error('[orders] could not record last order date:', err instanceof Error ? err.message : err));

  const s = summary(order);
  await notifyOrder(ctx, order, me.farmId === farmId && me.buyerId !== buyerId ? 'farm' : 'buyer');

  return {
    success: true,
    order_id: order.id,
    order_number: s.order_number,
    total: s.total,
    items_count: s.items.length,
    status: s.status,
    fulfillment,
    ...(fulfillment === 'pickup' ? { depot_address: DEPOT.short } : { delivery_address: `${address!.street}, ${address!.city}` }),
    scheduled_dropoff: slot?.date.toISOString() ?? null,
    dropoff_time_window: slot?.timeWindow ?? null,
    ...(fees.apply.some((f) => f.per === 'buyer_delivery_day')
      ? { delivery_fee_note: 'Delivery is charged once per delivery day, on the first order checked in that day.' }
      : {}),
    ...(tax.renew_soon ? { certificate_renewal_due: 'Your tax exemption certificate lapses soon. Please sign a new one with SJCA.' } : {}),
  };
}

const dueDateFor = (order: SquareOrder, netDays: number) => {
  const when = scheduledAt(order);
  const base = when ? new Date(when) : new Date();
  return new Date(base.getTime() + netDays * 86400000).toISOString().slice(0, 10);
};

/**
 * Make sure the order has a published invoice and remember its id on the order.
 * Returns the fresh order (invoicing bumps its version) and the invoice.
 */
async function ensureInvoice(ctx: ToolContext, order: SquareOrder): Promise<{ order: SquareOrder; invoice: SquareInvoice; created: boolean }> {
  const { env } = ctx;
  if (order.metadata?.invoice_id) return { order, invoice: await getInvoice(env, order.metadata.invoice_id), created: false };
  const invoice = await createAndPublishInvoice(env, {
    orderId: order.id,
    customerId: order.customer_id!,
    dueDate: dueDateFor(order, env.INVOICE_NET_DAYS),
    title: `FarmLink order ${order.reference_id ?? ''}`.trim(),
  });
  const fresh = await getOrder(env, order.id);
  const saved = await updateOrder(env, fresh, { metadata: { ...(fresh.metadata ?? {}), invoice_id: invoice.id } });
  return { order: saved, invoice, created: true };
}

/**
 * A once-per-delivery-day buyer fee goes on the first order of that buyer's
 * delivery day to be checked in. A Firestore row per buyer and day records
 * which order carries it; if that order was cancelled, the next one takes it.
 */
async function deliveryDayFees(ctx: ToolContext, order: SquareOrder, terms: FirebaseFirestore.DocumentData | undefined): Promise<FeeSnapshot[]> {
  const fees = ((terms?.fees ?? []) as FeeSnapshot[]).filter((f) => f.payer === 'buyer' && f.per === 'buyer_delivery_day');
  if (!fees.length || terms?.fulfillment !== 'delivery' || !terms.delivery_day || !order.customer_id) return [];
  const { db, env } = ctx;
  const ref = db.collection('delivery_day_fees').doc(`${order.customer_id}_${terms.delivery_day}`);
  const holder = (await ref.get()).data()?.order_id as string | undefined;
  let holderCancelled = false;
  if (holder && holder !== order.id) holderCancelled = (await getOrder(env, holder)).state === 'CANCELED';
  const mine = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data()?.order_id as string | undefined;
    if (current === order.id) return true;
    if (current && !(current === holder && holderCancelled)) return false;
    tx.set(ref, { order_id: order.id, buyer_id: terms.buyer_id, delivery_day: terms.delivery_day, claimed_at: new Date() });
    return true;
  });
  return mine ? fees : [];
}

/**
 * Check-in at the depot: fix quantities to what actually arrived, add any
 * delivery-day fee, then create and publish the invoice, so the bill matches
 * the produce. Nothing here runs twice: lines are fixed only before the
 * invoice exists, fees are added only if their uid is not already on the order.
 */
async function checkIn(
  ctx: ToolContext,
  order: SquareOrder,
  received: Array<{ inventory_id: string; quantity: number }> | undefined,
): Promise<{ order: SquareOrder; invoice?: SquareInvoice; error?: { error: string; message: string } }> {
  const { db, env } = ctx;
  if (received?.length) {
    if (order.metadata?.invoice_id) {
      return { order, error: { error: 'already_invoiced', message: 'This order is already invoiced. Cancel the invoice in Square and re-create the order to change quantities.' } };
    }
    const lines: Array<{ uid: string; quantity: number }> = [];
    for (const r of received) {
      const li = order.line_items?.find((l) => l.catalog_object_id === r.inventory_id);
      const qty = Number(r.quantity);
      if (!li) return { order, error: { error: 'item_not_on_order', message: `Item ${r.inventory_id} is not on this order.` } };
      if (!(qty >= 0) || qty > Number(li.quantity)) {
        return { order, error: { error: 'invalid_quantity', message: `Received quantity for ${li.name ?? r.inventory_id} must be between 0 and the ${li.quantity} ordered.` } };
      }
      if (qty !== Number(li.quantity)) lines.push({ uid: li.uid, quantity: qty });
    }
    const left = (order.line_items ?? []).filter((li) => {
      const change = lines.find((l) => l.uid === li.uid);
      return (change ? change.quantity : Number(li.quantity)) > 0;
    });
    if (!left.length) return { order, error: { error: 'nothing_received', message: 'Nothing on this order arrived. Cancel the order instead.' } };
    if (lines.length) order = await updateOrder(env, order, { lines });
  }

  const terms = (await db.collection('wholesale_orders').doc(order.id).get()).data();
  const dayFees = await deliveryDayFees(ctx, order, terms);
  if (dayFees.length && !order.metadata?.invoice_id) {
    const taxIds = splitIds(env.SQUARE_FEE_TAX_IDS);
    const have = new Set((order.service_charges ?? []).map((sc) => sc.uid));
    const charges = dayFees.flatMap((f) => serviceChargesFor(f, taxIds)).filter((c) => !have.has(c.uid as string));
    // The fee taxes may already be on the order from its per-order fees.
    const haveTaxes = (order.taxes ?? []).some((t) => t.uid?.startsWith('feetax-'));
    if (charges.length) order = await updateOrder(env, order, { addServiceCharges: charges, ...(taxIds.length && !haveTaxes ? { addTaxes: feeTaxes(taxIds) } : {}) });
  }

  if (orderPaid(order)) return { order };
  const res = await ensureInvoice(ctx, order);
  return { order: res.order, invoice: res.invoice };
}

export async function squareOrderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { env, userId } = ctx;
  let order = await getOrder(env, String(input.order_id));
  const farmId = order.metadata?.farm_id;
  const buyerId = order.metadata?.buyer_id;
  if (!farmId || !buyerId) return { error: 'not_a_farmlink_order', message: 'That order was not placed through FarmLink.' };

  const status = input.status as Status | undefined;
  const note = input.notes ? String(input.notes) : undefined;
  const received = input.received_items as Array<{ inventory_id: string; quantity: number }> | undefined;
  const current = orderStatus(order);
  let byFarm = true;
  if (userId) {
    const me = await parties(ctx);
    const admin = await isAdmin(ctx);
    byFarm = me.farmId === farmId || admin;
    if (!byFarm && me.buyerId !== buyerId) return { error: 'not_allowed', message: 'That is not your order.' };
    if (status && !byFarm && (current !== 'pending' || status !== 'cancelled')) {
      return { error: 'not_allowed', message: 'Buyers can only cancel an order that is still pending. After that the farm updates it.' };
    }
    if (received && !byFarm) return { error: 'not_allowed', message: 'Only SJCA staff or the farm can check an order in.' };
  }
  if (current === 'cancelled') return { error: 'order_closed', message: 'Order is already cancelled.' };
  if (current === 'delivered') {
    order = await settleIfPaid(env, order);
    return { error: 'order_closed', message: 'Order was already picked up or delivered.', order: summary(order) };
  }
  if (status === 'pending' && current !== 'pending') return { error: 'invalid_status', message: 'An order cannot go back to pending.' };
  if (received?.length && status !== 'in_transit') {
    return { error: 'invalid_input', message: 'Received quantities are entered at check-in (status in_transit).' };
  }
  if (received?.length && order.metadata?.invoice_id) {
    return { error: 'already_invoiced', message: 'This order is already invoiced. Cancel the invoice in Square and re-create the order to change quantities.' };
  }

  // Check-in happens when the order reaches the depot (in_transit) or, if that
  // step was skipped, when it is picked up or delivered.
  const checkInDue = (status === 'in_transit' || status === 'delivered') && !order.metadata?.invoice_id;
  const missingInvoice = !order.metadata?.invoice_id && current === 'in_transit';
  if ((!status || status === current) && !note && !missingInvoice) return { error: 'No fields to update' };

  let invoice: SquareInvoice | undefined;
  let invoiceError: string | undefined;

  if (status === 'cancelled') {
    if (orderPaid(order)) return { error: 'paid_needs_refund', message: 'This order is already paid. It has to be refunded in Square, not cancelled here.' };
    if (order.metadata?.invoice_id) {
      const inv = await getInvoice(env, order.metadata.invoice_id);
      if (!['DRAFT', 'UNPAID', 'SCHEDULED', 'CANCELED'].includes(inv.status)) {
        return { error: 'paid_needs_refund', message: 'A payment has been made on this invoice. It has to be handled in Square.' };
      }
      // An invoiced order can only be cancelled through its invoice, which cancels the order too.
      if (inv.status !== 'CANCELED') await cancelInvoice(env, inv);
      order = await getOrder(env, order.id);
    } else {
      order = await updateOrder(env, order, { state: 'CANCELED', note });
    }
  } else {
    // Fix quantities, add delivery-day fees and invoice before the status moves,
    // so the buyer's text carries the corrected invoice.
    if (checkInDue || missingInvoice) {
      try {
        const res = await checkIn(ctx, order, received);
        if (res.error) return res.error;
        ({ order, invoice } = res);
      } catch (err) {
        invoiceError = err instanceof Error ? err.message : String(err);
        console.error('[orders] check-in failed:', invoiceError);
        order = await getOrder(env, order.id);
      }
    }
    if (status === 'delivered') {
      order = await updateOrder(env, order, {
        state: orderPaid(order) ? 'COMPLETED' : order.fulfillments?.[0]?.state === 'PREPARED' ? undefined : 'PREPARED',
        note,
        // Square will not complete an unpaid pickup or delivery; the handover is recorded here.
        metadata: { ...(order.metadata ?? {}), picked_up_at: new Date().toISOString() },
      });
    } else if ((status && status !== current) || note) {
      order = await updateOrder(env, order, { state: status && status !== current ? TO_FULFILLMENT[status] : undefined, note });
    }
  }

  const s = summary(order);
  await notifyOrder(ctx, order, byFarm ? 'farm' : 'buyer');
  return {
    success: true,
    order: s,
    ...(invoice ? { invoice: { status: invoice.status, due_date: invoice.payment_requests?.[0]?.due_date ?? null, url: invoice.public_url ?? null } } : {}),
    ...(invoiceError ? { invoice_error: 'The order was updated but it could not be checked in and invoiced. Repeat the check-in to try again.' } : {}),
  };
}

export async function squareOrderQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env } = ctx;
  let farmId = input.farm_id ? String(input.farm_id) : undefined;
  let buyerId = input.market_id ? String(input.market_id) : undefined;

  // A signed-in user only ever sees their own orders, whatever ids were passed.
  if (ctx.userId) {
    const me = await parties(ctx);
    if (me.buyerId && buyerId === me.buyerId) farmId = undefined; // someone who is both, asking as a buyer
    else if (me.farmId) { farmId = me.farmId; buyerId = undefined; }
    else if (me.buyerId) { buyerId = me.buyerId; farmId = undefined; }
    else return { count: 0, orders: [] };
  }

  let customerId: string | undefined;
  if (buyerId) {
    customerId = (await db.collection('markets').doc(buyerId).get()).data()?.square_customer_id;
    if (!customerId) return { count: 0, orders: [] };
  }

  const names = new Map<string, string>();
  const nameOf = async (col: 'farms' | 'markets', id?: string) => {
    if (!id) return 'Unknown';
    const k = `${col}/${id}`;
    if (!names.has(k)) names.set(k, (await db.collection(col).doc(id).get()).data()?.name ?? 'Unknown');
    return names.get(k)!;
  };

  const orders = (await searchOrders(env, { customerId }))
    .filter((o) => o.metadata?.farm_id && o.metadata?.buyer_id) // FarmLink orders only
    .filter((o) => !farmId || o.metadata!.farm_id === farmId)
    .filter((o) => !input.status || orderStatus(o) === input.status)
    .filter((o) => !input.date || (o.created_at ?? '').startsWith(String(input.date)))
    .slice(0, 20);

  const results = [];
  for (const found of orders) {
    const o = await settleIfPaid(env, found);
    results.push({ ...summary(o), farm_name: await nameOf('farms', o.metadata!.farm_id), market_name: await nameOf('markets', o.metadata!.buyer_id) });
  }
  return { count: results.length, orders: results };
}
