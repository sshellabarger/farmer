import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processInboundMessage } from '../services/conversation.js';
import { sendSms } from '../services/sms.js';
import { notifyError } from '../services/error-notify.js';
import { classifyError } from '../utils/errors.js';

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
  // Telnyx inbound webhook
  app.post('/inbound', async (request, reply) => {
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
      await sendSms({ env: app.env, to: from, body: 'Welcome! Please create an account at farmlink.app/signup to get started.' });
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
  app.post('/whatsapp/inbound', async (request, reply) => {
    if (app.env.META_APP_SECRET) {
      const signature = (request.headers['x-hub-signature-256'] as string) || '';
      const rawBody = JSON.stringify(request.body);
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
        await sendWhatsApp({ env: app.env, to: from, body: 'Welcome to FarmLink! Please create an account at farmlink.app/signup.' });
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

  // Direct chat endpoint for web testing
  app.post('/chat', async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10), message: z.string().min(1) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Need phone and message' });

    const { phone, message } = parsed.data;
    try {
      const responseText = await processInboundMessage({ db: app.db, env: app.env, phone, message, messageSid: `web-${Date.now()}` });
      reply.send({ response: responseText });
    } catch (err) {
      app.log.error(err, 'Failed to process web chat message');
      reply.status(500).send({ error: 'Failed to process message' });
    }
  });

  // Conversation history
  app.get('/history/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string };

    const convoSnap = await app.db
      .collection('conversations')
      .where('phone_number', '==', phone)
      .orderBy('last_message_at', 'desc')
      .limit(1)
      .get();

    if (convoSnap.empty) return reply.send({ messages: [] });

    const convoId = convoSnap.docs[0].id;
    const msgsSnap = await app.db
      .collection('conversations').doc(convoId).collection('messages')
      .orderBy('created_at', 'asc')
      .get();

    const messages = msgsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    reply.send({ messages });
  });

  // List conversations
  app.get('/conversations', async (request, reply) => {
    const authHeader = request.headers.authorization;
    let authUserId: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const { verifyJwt } = await import('../utils/jwt.js');
      const payload = verifyJwt(authHeader.slice(7), app.env.JWT_SECRET);
      if (payload?.sub) authUserId = payload.sub;
    }

    const { farm_id, market_id } = request.query as { farm_id?: string; market_id?: string };

    let includeUserIds: string[] = authUserId ? [authUserId] : [];

    if (farm_id) {
      const relsSnap = await app.db.collection('farm_market_rels')
        .where('farm_id', '==', farm_id).where('active', '==', true).get();
      for (const d of relsSnap.docs) {
        const marketDoc = await app.db.collection('markets').doc(d.data().market_id).get();
        if (marketDoc.exists) includeUserIds.push(marketDoc.data()!.user_id);
      }
    }
    if (market_id) {
      const relsSnap = await app.db.collection('farm_market_rels')
        .where('market_id', '==', market_id).where('active', '==', true).get();
      for (const d of relsSnap.docs) {
        const farmDoc = await app.db.collection('farms').doc(d.data().farm_id).get();
        if (farmDoc.exists) includeUserIds.push(farmDoc.data()!.user_id);
      }
    }

    let query: FirebaseFirestore.Query = app.db.collection('conversations');
    if (includeUserIds.length > 0 && includeUserIds.length <= 30) {
      query = query.where('user_id', 'in', includeUserIds);
    }

    const snapshot = await query.orderBy('last_message_at', 'desc').limit(50).get();

    const results = await Promise.all(
      snapshot.docs.map(async (doc) => {
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

  // voip.ms inbound
  const handleVoipmsInbound = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const params = { ...(request.query as Record<string, string>), ...(request.body as Record<string, string> ?? {}) };
    const from = params.from;
    const message = params.message;
    const id = params.id || `voipms-${Date.now()}`;

    if (!from || !message) return reply.type('text/plain').send('ok');

    const normalizedFrom = from.startsWith('+') ? from : `+1${from}`;

    const userSnap = await app.db.collection('users').where('phone', '==', normalizedFrom).limit(1).get();
    if (userSnap.empty) {
      await sendSms({ env: app.env, to: normalizedFrom, body: 'Welcome! Please create an account at farmlink.us/signup.' });
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
      notifyError({ env: app.env, err, userPhone: normalizedFrom, userMessage: message }).catch(() => null);
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
