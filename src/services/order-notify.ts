import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { DEPOT } from '../config/depot.js';
import { sendSms } from './sms.js';
import { getInvoice, orderPaid, updateOrder, type SquareOrder } from './square.js';

/**
 * The one place order texts are decided (handoff 04: "webhooks keep texts in step").
 * Both the AI tools and the Square webhook call `notifyOrder` after a change.
 * A small cursor per order in the app DB (`order_notifications/{orderId}`)
 * records what has already been announced, inside a transaction, so whichever
 * caller gets there first sends and the other stays silent: a change made in
 * FarmLink is not texted twice when Square's webhook for it arrives, and a
 * change made at the Square Dashboard or register still reaches both sides.
 */

export type Status = 'pending' | 'confirmed' | 'in_transit' | 'delivered' | 'cancelled';
type Deps = { db: Firestore; env: Env };

/**
 * Square will not complete a pickup before the order is paid, and buyers on
 * net terms pick up first. So "delivered" is `metadata.picked_up_at`; the
 * Square fulfillment is completed later, once the invoice is paid.
 */
export function orderStatus(order: SquareOrder): Status {
  const f = order.fulfillments?.[0]?.state;
  if (order.state === 'CANCELED' || f === 'CANCELED' || f === 'FAILED') return 'cancelled';
  if (order.state === 'COMPLETED' || f === 'COMPLETED' || order.metadata?.picked_up_at) return 'delivered';
  if (f === 'RESERVED') return 'confirmed';
  if (f === 'PREPARED') return 'in_transit';
  return 'pending';
}

export function paymentStatus(order: SquareOrder): 'paid' | 'invoiced' | 'not_invoiced' {
  return orderPaid(order) ? 'paid' : order.metadata?.invoice_id ? 'invoiced' : 'not_invoiced';
}

export function isFarmLinkOrder(order: SquareOrder): boolean {
  return !!order.metadata?.farm_id && !!order.metadata?.buyer_id;
}

/** Once paid and picked up, close the Square pickup so the order completes. Best-effort. */
export async function settleIfPaid(env: Env, order: SquareOrder): Promise<SquareOrder> {
  const f = order.fulfillments?.[0]?.state;
  if (order.state !== 'OPEN' || !orderPaid(order) || !order.metadata?.picked_up_at || f === 'COMPLETED') return order;
  try {
    return await updateOrder(env, order, { state: 'COMPLETED' });
  } catch (err) {
    console.error('[orders] could not complete paid order:', err instanceof Error ? err.message : err);
    return order;
  }
}

/** Best-effort text through the guarded choke point; a failed send never fails the caller. */
async function text(env: Env, to: unknown, body: string): Promise<void> {
  if (typeof to !== 'string' || !to) return;
  try {
    await sendSms({ env, to, body });
  } catch (err) {
    console.error('[orders] notification failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Announce whatever about this order has not been announced yet.
 * `actor` is who made the change through FarmLink (they are not texted about
 * their own action); omit it for changes seen via webhook.
 */
export async function notifyOrder({ db, env }: Deps, order: SquareOrder, actor?: 'farm' | 'buyer'): Promise<{ sent: number }> {
  if (!isFarmLinkOrder(order)) return { sent: 0 };
  const status = orderStatus(order);
  const paid = orderPaid(order);
  const invoiceId = order.metadata!.invoice_id;

  const ref = db.collection('order_notifications').doc(order.id);
  const due = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.exists ? snap.data() : {}) as { status?: Status; paid?: boolean; invoice_sent?: boolean };
    const statusChanged = prev.status !== status;
    const paidNew = paid && !prev.paid;
    const invoiceDue = !!invoiceId && !prev.invoice_sent && !paid && status !== 'cancelled';
    if (!statusChanged && !paidNew && !invoiceDue) return null;
    tx.set(ref, { status, paid: paid || !!prev.paid, invoice_sent: !!prev.invoice_sent || invoiceDue, updated_at: new Date() }, { merge: true });
    return { statusChanged, paidNew, invoiceDue };
  });
  if (!due) return { sent: 0 };

  const [farmDoc, buyerDoc] = await Promise.all([
    db.collection('farms').doc(order.metadata!.farm_id).get(),
    db.collection('markets').doc(order.metadata!.buyer_id).get(),
  ]);
  const farm = farmDoc.data() ?? {};
  const buyer = buyerDoc.data() ?? {};
  const n = order.reference_id ?? order.id;

  let invoiceText = '';
  if (due.invoiceDue) {
    try {
      const inv = await getInvoice(env, invoiceId);
      const d = inv.payment_requests?.[0]?.due_date;
      if (inv.public_url) invoiceText = `Invoice${d ? ` (due ${d})` : ''}: ${inv.public_url}`;
    } catch (err) {
      console.error('[orders] could not load invoice for text:', err instanceof Error ? err.message : err);
    }
  }

  const out: Array<{ to: unknown; body: string }> = [];
  let invoiceAttached = false;
  if (due.statusChanged) {
    if (status === 'pending') {
      if (actor !== 'farm') {
        const lines = (order.line_items ?? []).map((li) => `${Number(li.quantity)} ${(li.name ?? '').replace(`${farm.name} - `, '')}`).join(', ');
        const total = ((order.total_money?.amount ?? 0) / 100).toFixed(2);
        out.push({ to: farm.phone, body: `New order ${n} from ${buyer.name ?? 'a buyer'}: ${lines}. Total $${total}. Reply to confirm.` });
      }
    } else if (status === 'cancelled') {
      if (actor !== 'farm') out.push({ to: farm.phone, body: `Order ${n} was cancelled.` });
      if (actor !== 'buyer') out.push({ to: buyer.phone, body: `Order ${n} was cancelled.` });
    } else {
      const words = { confirmed: 'is confirmed', in_transit: `is at the depot, ready for pickup: ${DEPOT.short}`, delivered: 'was picked up' }[status];
      invoiceAttached = !!invoiceText;
      out.push({ to: buyer.phone, body: `Order ${n} ${words}.${invoiceText ? ` ${invoiceText}` : ''}` });
    }
  }
  if (invoiceText && !invoiceAttached) out.push({ to: buyer.phone, body: `Order ${n}: ${invoiceText}` });
  if (due.paidNew) {
    out.push({ to: buyer.phone, body: `Payment received for order ${n}. Thank you!` });
    out.push({ to: farm.phone, body: `Order ${n} from ${buyer.name ?? 'your buyer'} is paid.` });
  }

  for (const m of out) await text(env, m.to, m.body);
  return { sent: out.length };
}
