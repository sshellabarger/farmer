import { v4 as uuid } from 'uuid';
import type { ToolContext } from './index.js';
import { DEPOT } from '../config/depot.js';
import { calculateNextDropoff } from '../services/order-notifications.js';
import { notifyOrder, orderStatus, paymentStatus, settleIfPaid, type Status } from '../services/order-notify.js';
import {
  cancelInvoice, committedQuantities, createAndPublishInvoice, createPickupOrder, getInvoice, getOrder, getStockCounts,
  listFarmItems, orderPaid, searchOrders, updateOrder, type FulfillmentState, type SquareInvoice, type SquareOrder,
} from '../services/square.js';

export { orderStatus, paymentStatus };

/**
 * Square-backed order tools (handoff 04, build step 4).
 * The order lives in Square: an Order at the depot Location with a PICKUP
 * fulfillment, the buyer as Customer. The app DB keeps nothing about it; the
 * farm and buyer ids ride on the order's metadata.
 */


const TO_FULFILLMENT: Record<Status, FulfillmentState> = {
  pending: 'PROPOSED', confirmed: 'RESERVED', in_transit: 'PREPARED', delivered: 'COMPLETED', cancelled: 'CANCELED',
};

const dollars = (m?: { amount: number }) => (m ? m.amount / 100 : 0);

function summary(order: SquareOrder) {
  return {
    id: order.id,
    order_number: order.reference_id ?? order.id,
    status: orderStatus(order),
    payment: paymentStatus(order),
    total: dollars(order.total_money),
    order_date: order.created_at ?? null,
    pickup_at: order.fulfillments?.[0]?.pickup_details?.pickup_at ?? null,
    notes: order.fulfillments?.[0]?.pickup_details?.note ?? null,
    items: (order.line_items ?? []).map((li) => ({ product_name: li.name ?? '', quantity: Number(li.quantity), line_total: dollars(li.total_money) })),
  };
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
  // Square needs a pickup time; with no drop-off schedule use a 48h placeholder and report none.
  const pickupAt = slot?.date ?? new Date(Date.now() + 48 * 3600 * 1000);

  const key = ctx.messageId ? `${ctx.messageId}|${buyerId}|${farmId}` : uuid();
  const order = await createPickupOrder(env, {
    customerId: buyer.square_customer_id,
    buyerName: buyer.name,
    orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
    metadata: { farm_id: farmId, buyer_id: buyerId },
    lines: [...wanted].map(([variationId, quantity]) => ({ variationId, quantity })),
    pickupAt,
    note: input.notes ? String(input.notes) : undefined,
    key,
  });

  const s = summary(order);
  await notifyOrder(ctx, order, me.farmId === farmId && me.buyerId !== buyerId ? 'farm' : 'buyer');

  return {
    success: true,
    order_id: order.id,
    order_number: s.order_number,
    total: s.total,
    items_count: s.items.length,
    status: s.status,
    depot_address: DEPOT.short,
    scheduled_dropoff: slot?.date.toISOString() ?? null,
    dropoff_time_window: slot?.timeWindow ?? null,
  };
}

const dueDateFor = (order: SquareOrder, netDays: number) => {
  const pickup = order.fulfillments?.[0]?.pickup_details?.pickup_at;
  const base = pickup ? new Date(pickup) : new Date();
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

export async function squareOrderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;
  let order = await getOrder(env, String(input.order_id));
  const farmId = order.metadata?.farm_id;
  const buyerId = order.metadata?.buyer_id;
  if (!farmId || !buyerId) return { error: 'not_a_farmlink_order', message: 'That order was not placed through FarmLink.' };

  const status = input.status as Status | undefined;
  const note = input.notes ? String(input.notes) : undefined;
  const current = orderStatus(order);
  let byFarm = true;
  if (userId) {
    const me = await parties(ctx);
    byFarm = me.farmId === farmId;
    if (!byFarm && me.buyerId !== buyerId) return { error: 'not_allowed', message: 'That is not your order.' };
    if (status && !byFarm && (current !== 'pending' || status !== 'cancelled')) {
      return { error: 'not_allowed', message: 'Buyers can only cancel an order that is still pending. After that the farm updates it.' };
    }
  }
  if (current === 'cancelled') return { error: 'order_closed', message: 'Order is already cancelled.' };
  if (current === 'delivered') {
    order = await settleIfPaid(env, order);
    return { error: 'order_closed', message: 'Order was already picked up.', order: summary(order) };
  }
  if (status === 'pending' && current !== 'pending') return { error: 'invalid_status', message: 'An order cannot go back to pending.' };

  const missingInvoice = !order.metadata?.invoice_id && (status === 'confirmed' || status === 'in_transit');
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
    if (status === 'delivered') {
      order = await updateOrder(env, order, {
        state: orderPaid(order) ? 'COMPLETED' : order.fulfillments?.[0]?.state === 'PREPARED' ? undefined : 'PREPARED',
        note,
        metadata: { ...(order.metadata ?? {}), picked_up_at: new Date().toISOString() },
      });
    } else if ((status && status !== current) || note) {
      order = await updateOrder(env, order, { state: status && status !== current ? TO_FULFILLMENT[status] : undefined, note });
    }
    // From confirmation on, the buyer owes money: make sure the invoice exists.
    if (status && status !== 'pending' && !orderPaid(order)) {
      try {
        ({ order, invoice } = await ensureInvoice(ctx, order));
      } catch (err) {
        invoiceError = err instanceof Error ? err.message : String(err);
        console.error('[orders] invoice failed:', invoiceError);
      }
    }
  }

  const s = summary(order);
  await notifyOrder(ctx, order, byFarm ? 'farm' : 'buyer');
  return {
    success: true,
    order: s,
    ...(invoice ? { invoice: { status: invoice.status, due_date: invoice.payment_requests?.[0]?.due_date ?? null, url: invoice.public_url ?? null } } : {}),
    ...(invoiceError ? { invoice_error: 'The order was updated but its invoice could not be created. Repeat the update to try again.' } : {}),
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
