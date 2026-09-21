import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleInboundText } from '../services/inbound.js';
import { notifyError } from '../services/error-notify.js';

// Buffer the request body before parsing so webhook signatures can be checked
// against the exact bytes the provider signed (JSON.stringify of the parsed
// body can differ in whitespace/escaping and break verification). Not needed
// by voip.ms (it cannot sign), kept for the delivery-status callback and any
// future signed provider.
export async function captureRawBody(request: FastifyRequest, _reply: FastifyReply, payload: Readable): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  request.rawBody = raw;
  const stream = Readable.from(raw) as Readable & { receivedEncodedLength?: number };
  stream.receivedEncodedLength = raw.length;
  return stream;
}

// Constant-time string comparison that tolerates length differences
// (timingSafeEqual throws on mismatched lengths).
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

// Normalize to E.164 (+1XXXXXXXXXX) the same way the web clients do, so a
// phone lookup can't be dodged with formatting differences.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}

export async function smsRoutes(app: FastifyInstance) {
  // voip.ms inbound. voip.ms can't sign callbacks, so the callback URL set in
  // the voip.ms portal embeds a shared secret (?secret=...) that we require
  // here — otherwise anyone who finds this URL can spoof texts from any number.
  const handleVoipmsInbound = async (request: FastifyRequest, reply: FastifyReply) => {
    if (app.env.VOIPMS_WEBHOOK_SECRET) {
      const provided = (request.query as Record<string, string>).secret || '';
      if (!timingSafeEqualStrings(provided, app.env.VOIPMS_WEBHOOK_SECRET)) {
        app.log.warn({ ip: request.ip }, 'Rejected voip.ms webhook: bad or missing secret');
        return reply.status(403).type('text/plain').send('forbidden');
      }
    } else {
      // Warn-and-accept until the portal URL carries the secret — hard-failing
      // here before that change would drop all live inbound texts.
      app.log.warn('VOIPMS_WEBHOOK_SECRET not set — accepting unauthenticated voip.ms webhook');
    }

    const params = { ...(request.query as Record<string, string>), ...(request.body as Record<string, string> ?? {}) };
    const from = params.from;
    const message = params.message;
    const id = params.id || `voipms-${Date.now()}`;

    if (!from || !message) return reply.type('text/plain').send('ok');

    const normalizedFrom = normalizePhone(from);
    app.log.info({ from: normalizedFrom, id, body: message.substring(0, 50) }, 'Inbound SMS');

    // Never let a failure 500 the webhook: voip.ms retries non-200 responses,
    // which would reprocess (and re-log) the same text.
    try {
      await handleInboundText({ db: app.db, env: app.env, log: app.log, from: normalizedFrom, body: message, providerMessageId: id });
    } catch (err) {
      app.log.error(err, 'Failed to process voip.ms inbound SMS');
      notifyError({ env: app.env, err, source: 'sms-inbound', userPhone: normalizedFrom, userMessage: message }).catch(() => null);
    }

    return reply.type('text/plain').send('ok');
  };

  app.get('/voipms/inbound', handleVoipmsInbound);
  app.post('/voipms/inbound', handleVoipmsInbound);

  // Delivery-status callback (stub; implemented with the message log in a later phase).
  app.post('/status', async (_request, reply) => {
    reply.send({ ok: true });
  });
}
