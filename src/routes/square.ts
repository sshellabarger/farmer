import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { captureRawBody } from './sms.js';
import { getOrder } from '../services/square.js';
import { isFarmLinkOrder, notifyOrder, settleIfPaid } from '../services/order-notify.js';

/**
 * Square webhooks (handoff 04): keep texts in step with changes made in Square
 * itself — an invoice paid on Square's page, a pickup updated at the Dashboard.
 *
 * Every event is reduced to "this order changed": the order is re-read from
 * Square (the payload is never trusted for state), settled if it is now paid,
 * and `notifyOrder` announces whatever has not been announced yet.
 *
 * Security (handoff 05 #3): the signature is checked on every call and the
 * route fails closed. With no signature key configured it accepts nothing.
 */

/** Square signs `notification URL + raw body` with HMAC-SHA256, base64, in `x-square-hmacsha256-signature`. */
export function verifySquareSignature(signatureKey: string, notificationUrl: string, rawBody: string, signature: string | undefined): boolean {
  if (!signatureKey || !notificationUrl || !signature) return false;
  const expected = crypto.createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** The order an event is about, wherever that event type keeps it. */
export function orderIdFromEvent(event: { data?: { object?: Record<string, { order_id?: string } | undefined> } }): string | undefined {
  const o = event.data?.object ?? {};
  return o.invoice?.order_id ?? o.order_updated?.order_id ?? o.order_fulfillment_updated?.order_id ?? o.order_created?.order_id ?? o.payment?.order_id;
}

export async function squareRoutes(app: FastifyInstance) {
  app.post('/webhook', { preParsing: captureRawBody }, async (request, reply) => {
    const env = app.env;
    const raw = request.rawBody ? request.rawBody.toString('utf8') : '';
    const signature = request.headers['x-square-hmacsha256-signature'];
    if (!verifySquareSignature(env.SQUARE_WEBHOOK_SIGNATURE_KEY, env.SQUARE_WEBHOOK_URL, raw, Array.isArray(signature) ? signature[0] : signature)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const event = (request.body ?? {}) as { event_id?: string; type?: string; data?: { object?: Record<string, { order_id?: string }> } };
    const orderId = orderIdFromEvent(event);
    if (!event.event_id || !orderId) return reply.send({ ok: true, ignored: true });

    // Square retries deliveries: the event row is the lock, written before any work.
    const eventRef = app.db.collection('square_events').doc(event.event_id);
    try {
      await eventRef.create({ type: event.type ?? null, order_id: orderId, received_at: new Date() });
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (code === 6 || code === 'already-exists') return reply.send({ ok: true, duplicate: true });
      throw err;
    }

    try {
      let order = await getOrder(env, orderId);
      if (!isFarmLinkOrder(order)) return reply.send({ ok: true, ignored: true });
      order = await settleIfPaid(env, order);
      const { sent } = await notifyOrder({ db: app.db, env }, order);
      return reply.send({ ok: true, sent });
    } catch (err) {
      // Release the lock so Square's retry can try again.
      await eventRef.delete().catch(() => {});
      app.log.error(err, 'Square webhook failed');
      return reply.status(500).send({ error: 'Webhook processing failed' });
    }
  });
}
