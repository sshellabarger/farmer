import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { processInboundMessage } from '../services/conversation.js';
import { sendSms } from '../services/sms.js';
import { verifyTelnyxWebhookSignature } from '../services/telnyx.js';
import { notifyError } from '../services/error-notify.js';
import { classifyError } from '../utils/errors.js';
import { byDateDesc } from '../utils/sort.js';
import { authenticate } from '../middleware/rbac.js';

// Buffer the request body before parsing so webhook signatures can be checked
// against the exact bytes the provider signed (JSON.stringify of the parsed
// body can differ in whitespace/escaping and break verification).
async function captureRawBody(request: FastifyRequest, _reply: FastifyReply, payload: Readable): Promise<Readable> {
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
function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

// Normalize to E.164 (+1XXXXXXXXXX) the same way the web clients do, so the
// ownership check can't be dodged with formatting differences.
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}

function ownsPhone(user: { role: string; phone: string | null }, phone: string): boolean {
  if (user.role === 'admin') return true;
  return !!user.phone && normalizePhone(user.phone) === normalizePhone(phone);
}

const telnyxInboundSchema = z.object({
  data: z.object({
    event_type: z.string(),
    id: z.string(),
    payload: z.object({
      from: z.object({ phone_number: z.string() }),
      to: z.array(z.object({ phone_number: z.string() })),
      text: z.string(),
      id: z.string(),
      media: z.array(z.any()).optional(),
    }),
  }),
});

export async function smsRoutes(app: FastifyInstance) {
  // Telnyx inbound webhook. Telnyx signs every webhook, so an unverifiable
  // request is spoofed — anyone who finds this URL could otherwise drive the
  // AI engine (and its side effects) as any registered user.
  app.post('/inbound', { preParsing: captureRawBody }, async (request, reply) => {
    if (app.env.TELNYX_PUBLIC_KEY) {
      const valid = verifyTelnyxWebhookSignature({
        publicKey: app.env.TELNYX_PUBLIC_KEY,
        signatureHeader: (request.headers['telnyx-signature-ed25519'] as string) || '',
        timestampHeader: (request.headers['telnyx-timestamp'] as string) || '',
        rawBody: request.rawBody ?? Buffer.from(JSON.stringify(request.body)),
      });
      if (!valid) {
        app.log.warn({ ip: request.ip }, 'Rejected Telnyx webhook: invalid or missing signature');
        return reply.status(403).send({ error: 'Invalid signature' });
      }
    } else if (app.env.NODE_ENV === 'production') {
      // No key to verify against: reject rather than accept spoofable traffic.
      app.log.warn({ ip: request.ip }, 'Rejected Telnyx webhook: TELNYX_PUBLIC_KEY not configured');
      return reply.status(403).send({ error: 'Webhook signature verification not configured' });
    } else {
      app.log.warn('TELNYX_PUBLIC_KEY not set — accepting unsigned Telnyx webhook (development only)');
    }

    const parsed = telnyxInboundSchema.safeParse(request.body);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.flatten() }, 'Invalid Telnyx webhook payload');
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    const { data } = parsed.data;
    if (data.event_type !== 'message.received') return reply.send({ ok: true });

    const from = data.payload.from.phone_number;
    const body = data.payload.text;
    const messageSid = data.payload.id;

    app.log.info({ from, body: body.substring(0, 50), messageSid }, 'Inbound SMS');

    const userSnap = await app.db.collection('users').where('phone', '==', from).limit(1).get();
    if (userSnap.empty) {
      await sendSms({ env: app.env, to: from, body: `Welcome! Please create an account at ${app.env.APP_URL}/signup to get started.` });
      return reply.send({ ok: true });
    }

    try {
      const responseText = await processInboundMessage({ db: app.db, env: app.env, phone: from, message: body, messageSid });
      await sendSms({ env: app.env, to: from, body: responseText });
      reply.send({ ok: true });
    } catch (err) {
      app.log.error(err, 'Failed to process inbound SMS');
      reply.send({ ok: true });
    }
  });

  // WhatsApp webhook verification
  app.get('/whatsapp/inbound', async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === app.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(query['hub.challenge']);
    }
    return reply.status(403).send('Forbidden');
  });

  // WhatsApp inbound messages
  app.post('/whatsapp/inbound', { preParsing: captureRawBody }, async (request, reply) => {
    if (app.env.META_APP_SECRET) {
      const signature = (request.headers['x-hub-signature-256'] as string) || '';
      // Meta signs the raw bytes; fall back to re-serializing only if the
      // raw body wasn't captured.
      const rawBody = request.rawBody ? request.rawBody.toString('utf8') : JSON.stringify(request.body);
      const { verifyWebhookSignature } = await import('../services/whatsapp.js');
      if (!verifyWebhookSignature(app.env.META_APP_SECRET, rawBody, signature)) {
        return reply.status(403).send({ error: 'Invalid signature' });
      }
    }

    const payload = request.body as any;
    if (payload.object !== 'whatsapp_business_account') return reply.send({ ok: true });

    const changes = payload.entry?.[0]?.changes?.[0]?.value;
    if (!changes?.messages) return reply.send({ ok: true });

    for (const msg of changes.messages) {
      if (msg.type !== 'text' || !msg.text?.body) continue;

      const from = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;
      const body = msg.text.body;

      const userSnap = await app.db.collection('users').where('phone', '==', from).limit(1).get();
      if (userSnap.empty) {
        const { sendWhatsApp } = await import('../services/whatsapp.js');
        await sendWhatsApp({ env: app.env, to: from, body: `Welcome to FarmLink! Please create an account at ${app.env.APP_URL}/signup.` });
        continue;
      }

      try {
        const responseText = await processInboundMessage({ db: app.db, env: app.env, phone: from, message: body, messageSid: msg.id });
        const { sendWhatsApp } = await import('../services/whatsapp.js');
        await sendWhatsApp({ env: app.env, to: from, body: responseText });
      } catch (err) {
        app.log.error(err, 'Failed to process inbound WhatsApp');
      }
    }

    reply.send({ ok: true });
  });

  // Direct chat endpoint for the web app. Acts as the phone's owner inside the
  // AI tool-calling engine, so callers may only chat as their own number
  // (admins may impersonate any number for support/testing).
  app.post('/chat', { preHandler: authenticate(app) }, async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10), message: z.string().min(1) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Need phone and message' });

    const { phone, message } = parsed.data;
    if (!ownsPhone(request.authUser!, phone)) {
      return reply.status(403).send({ error: 'Forbidden: you can only chat as your own phone number' });
    }
    try {
      const responseText = await processInboundMessage({ db: app.db, env: app.env, phone, message, messageSid: `web-${Date.now()}` });
      reply.send({ response: responseText });
    } catch (err) {
      app.log.error(err, 'Failed to process web chat message');
      reply.status(500).send({ error: 'Failed to process message' });
    }
  });

  // Conversation history — own number only (admins may view any).
  app.get('/history/:phone', { preHandler: authenticate(app) }, async (request, reply) => {
    const { phone } = request.params as { phone: string };
    if (!ownsPhone(request.authUser!, phone)) {
      return reply.status(403).send({ error: 'Forbidden: you can only view your own conversation history' });
    }

    const convoSnap = await app.db
      .collection('conversations')
      .where('phone_number', '==', phone)
      .get();

    if (convoSnap.empty) return reply.send({ messages: [] });

    const latest = byDateDesc(convoSnap.docs.map((d) => ({ doc: d, last_message_at: d.data().last_message_at })), 'last_message_at')[0];
    const convoId = latest.doc.id;
    const msgsSnap = await app.db
      .collection('conversations').doc(convoId).collection('messages')
      .orderBy('created_at', 'asc')
      .get();

    const messages = msgsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    reply.send({ messages });
  });

  // List conversations — own conversations plus partners of farms/markets the
  // caller owns. Admins see everything.
  app.get('/conversations', { preHandler: authenticate(app) }, async (request, reply) => {
    const user = request.authUser!;
    const { farm_id, market_id } = request.query as { farm_id?: string; market_id?: string };

    let includeUserIds: string[] = user.role === 'admin' ? [] : [user.id];

    if (farm_id) {
      if (user.role !== 'admin' && farm_id !== user.farmId) {
        return reply.status(403).send({ error: 'Forbidden: you do not own this farm' });
      }
      const relsSnap = await app.db.collection('farm_market_rels')
        .where('farm_id', '==', farm_id).get();
      for (const d of relsSnap.docs) {
        if (!d.data().active) continue;
        const marketDoc = await app.db.collection('markets').doc(d.data().market_id).get();
        if (marketDoc.exists) includeUserIds.push(marketDoc.data()!.user_id);
      }
    }
    if (market_id) {
      if (user.role !== 'admin' && market_id !== user.marketId) {
        return reply.status(403).send({ error: 'Forbidden: you do not own this market' });
      }
      const relsSnap = await app.db.collection('farm_market_rels')
        .where('market_id', '==', market_id).get();
      for (const d of relsSnap.docs) {
        if (!d.data().active) continue;
        const farmDoc = await app.db.collection('farms').doc(d.data().farm_id).get();
        if (farmDoc.exists) includeUserIds.push(farmDoc.data()!.user_id);
      }
    }

    let query: FirebaseFirestore.Query = app.db.collection('conversations');
    if (includeUserIds.length > 0) {
      // Firestore 'in' caps at 30 values — keep the filter rather than
      // falling back to an unscoped query, which would leak other users' data.
      query = query.where('user_id', 'in', includeUserIds.slice(0, 30));
    }

    const snapshot = await query.get();
    const convoDocs = byDateDesc(snapshot.docs.map((d) => ({ doc: d, last_message_at: d.data().last_message_at })), 'last_message_at').slice(0, 50).map((x) => x.doc);

    const results = await Promise.all(
      convoDocs.map(async (doc) => {
        const conv = doc.data();
        const userDoc = await app.db.collection('users').doc(conv.user_id).get();
        const userData = userDoc.data() || {};

        const msgsSnap = await app.db
          .collection('conversations').doc(doc.id).collection('messages')
          .orderBy('created_at', 'desc')
          .limit(1)
          .get();

        const lastMsg = msgsSnap.empty ? null : msgsSnap.docs[0].data();

        const countSnap = await app.db
          .collection('conversations').doc(doc.id).collection('messages')
          .count().get();

        return {
          id: doc.id,
          phone_number: conv.phone_number,
          context: conv.context,
          last_message_at: conv.last_message_at,
          created_at: conv.created_at,
          user_name: userData.name || 'Unknown',
          user_role: userData.role,
          last_message: lastMsg?.body || null,
          last_message_direction: lastMsg?.direction || null,
          message_count: countSnap.data().count,
        };
      }),
    );

    reply.send({ conversations: results });
  });

  // voip.ms inbound. voip.ms can't sign callbacks, so the callback URL set in
  // the voip.ms portal embeds a shared secret (?secret=...) that we require
  // here — otherwise anyone who finds this URL can spoof texts from any number.
  const handleVoipmsInbound = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
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

    const normalizedFrom = from.startsWith('+') ? from : `+1${from}`;

    const userSnap = await app.db.collection('users').where('phone', '==', normalizedFrom).limit(1).get();
    if (userSnap.empty) {
      // Send a welcome prompt, but never let a send failure 500 the webhook
      // (voip.ms retries non-200 responses, which would reprocess the message).
      await sendSms({ env: app.env, to: normalizedFrom, body: `Welcome! Please create an account at ${app.env.APP_URL}/signup.` })
        .catch((err) => app.log.warn({ err, to: normalizedFrom }, 'Failed to send welcome SMS'));
      return reply.type('text/plain').send('ok');
    }

    try {
      const responseText = await processInboundMessage({ db: app.db, env: app.env, phone: normalizedFrom, message, messageSid: id });
      await sendSms({ env: app.env, to: normalizedFrom, body: responseText });
    } catch (err) {
      app.log.error(err, 'Failed to process voip.ms inbound SMS');
      const classified = classifyError(err);
      const userReply = classified.isAnthropicError
        ? "Our AI assistant is temporarily unavailable. Please try again in a moment."
        : "Something went wrong. Our team has been notified. Please try again shortly.";
      await sendSms({ env: app.env, to: normalizedFrom, body: userReply }).catch(() => null);
      notifyError({ env: app.env, err, source: 'sms-inbound', userPhone: normalizedFrom, userMessage: message }).catch(() => null);
    }

    return reply.type('text/plain').send('ok');
  };

  app.get('/voipms/inbound', handleVoipmsInbound);
  app.post('/voipms/inbound', handleVoipmsInbound);

  // Status callback
  app.post('/status', async (request, reply) => {
    reply.send({ ok: true });
  });
}
