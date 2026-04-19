import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processInboundMessage } from '../services/conversation.js';
import { sendSms } from '../services/sms.js';

// Telnyx webhook payload shape (nested under data.payload)
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

    // Only process inbound messages
    if (data.event_type !== 'message.received') {
      return reply.send({ ok: true });
    }

    const from = data.payload.from.phone_number;
    const body = data.payload.text;
    const messageSid = data.payload.id;

    app.log.info({ from, body: body.substring(0, 50), messageSid }, 'Inbound SMS');

    // Reject unregistered phone numbers — require signup first
    const registeredUser = await app.db
      .selectFrom('users')
      .select(['id'])
      .where('phone', '=', from)
      .executeTakeFirst();

    if (!registeredUser) {
      await sendSms({
        env: app.env,
        to: from,
        body: '👋 Welcome! To use FarmLink, please create an account first at our website. Visit farmlink.app/signup to get started!',
      });
      return reply.send({ ok: true });
    }

    try {
      // Process through conversation engine (AI + tools)
      const responseText = await processInboundMessage({
        db: app.db,
        env: app.env,
        phone: from,
        message: body,
        messageSid,
      });

      // Send reply via Telnyx
      await sendSms({
        env: app.env,
        to: from,
        body: responseText,
      });

      reply.send({ ok: true });
    } catch (err) {
      app.log.error(err, 'Failed to process inbound SMS');
      // Still return 200 so Telnyx doesn't retry
      reply.send({ ok: true });
    }
  });

  // ── Meta WhatsApp Cloud API webhook verification (GET) ──
  app.get('/whatsapp/inbound', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === app.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      app.log.info('WhatsApp webhook verified');
      return reply.type('text/plain').send(challenge);
    }

    app.log.warn({ mode, token }, 'WhatsApp webhook verification failed');
    return reply.status(403).send('Forbidden');
  });

  // ── Meta WhatsApp Cloud API inbound messages (POST) ──
  app.post('/whatsapp/inbound', async (request, reply) => {
    // Verify signature if META_APP_SECRET is configured
    if (app.env.META_APP_SECRET) {
      const signature = (request.headers['x-hub-signature-256'] as string) || '';
      const rawBody = JSON.stringify(request.body);
      const { verifyWebhookSignature } = await import('../services/whatsapp.js');
      if (!verifyWebhookSignature(app.env.META_APP_SECRET, rawBody, signature)) {
        app.log.warn('Invalid WhatsApp webhook signature');
        return reply.status(403).send({ error: 'Invalid signature' });
      }
    }

    const payload = request.body as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              from: string;
              id: string;
              timestamp: string;
              text?: { body: string };
              type: string;
            }>;
            contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
            statuses?: Array<{ id: string; status: string; recipient_id: string }>;
          };
          field?: string;
        }>;
      }>;
    };

    // Always return 200 quickly — Meta retries on failure
    if (payload.object !== 'whatsapp_business_account') {
      return reply.send({ ok: true });
    }

    const changes = payload.entry?.[0]?.changes?.[0]?.value;
    if (!changes) return reply.send({ ok: true });

    // Handle status updates
    if (changes.statuses) {
      for (const status of changes.statuses) {
        app.log.info({ id: status.id, status: status.status }, 'WhatsApp status update');
      }
      return reply.send({ ok: true });
    }

    // Handle inbound messages
    const messages = changes.messages;
    if (!messages || messages.length === 0) return reply.send({ ok: true });

    for (const msg of messages) {
      // Only handle text messages for now
      if (msg.type !== 'text' || !msg.text?.body) {
        app.log.info({ type: msg.type, from: msg.from }, 'Skipping non-text WhatsApp message');
        continue;
      }

      // Meta sends numbers without '+' — normalize to E.164
      const from = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;
      const body = msg.text.body;
      const messageSid = msg.id;
      const senderName = changes.contacts?.[0]?.profile?.name;

      app.log.info({ from, body: body.substring(0, 50), messageSid, senderName, channel: 'whatsapp' }, 'Inbound WhatsApp');

      // Check registration
      const registeredUser = await app.db
        .selectFrom('users')
        .select(['id'])
        .where('phone', '=', from)
        .executeTakeFirst();

      if (!registeredUser) {
        const { sendWhatsApp } = await import('../services/whatsapp.js');
        await sendWhatsApp({
          env: app.env,
          to: from,
          body: '👋 Welcome to FarmLink! Please create an account first at farmlink.app/signup to get started.',
        });
        continue;
      }

      try {
        const responseText = await processInboundMessage({
          db: app.db,
          env: app.env,
          phone: from,
          message: body,
          messageSid,
        });

        const { sendWhatsApp } = await import('../services/whatsapp.js');
        await sendWhatsApp({
          env: app.env,
          to: from,
          body: responseText,
        });
      } catch (err) {
        app.log.error(err, 'Failed to process inbound WhatsApp');
      }
    }

    reply.send({ ok: true });
  });

  // Direct chat endpoint — bypasses Telnyx, for web testing
  app.post('/chat', async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      message: z.string().min(1),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Need phone and message' });
    }

    const { phone, message } = parsed.data;
    app.log.info({ phone, message: message.substring(0, 50) }, 'Web chat message');

    try {
      const responseText = await processInboundMessage({
        db: app.db,
        env: app.env,
        phone,
        message,
        messageSid: `web-${Date.now()}`,
      });

      reply.send({ response: responseText });
    } catch (err) {
      app.log.error(err, 'Failed to process web chat message');
      reply.status(500).send({ error: 'Failed to process message' });
    }
  });

  // Get conversation history for a phone number
  app.get('/history/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string };

    const conversation = await app.db
      .selectFrom('conversations')
      .selectAll()
      .where('phone_number', '=', phone)
      .orderBy('last_message_at', 'desc')
      .executeTakeFirst();

    if (!conversation) {
      return reply.send({ messages: [] });
    }

    const messages = await app.db
      .selectFrom('messages')
      .selectAll()
      .where('conversation_id', '=', conversation.id)
      .orderBy('created_at', 'asc')
      .execute();

    reply.send({ messages });
  });

  // List conversations — if authenticated, filter to the user's own conversations
  app.get('/conversations', async (request, reply) => {
    // Soft auth: try to extract user from token without failing
    const authHeader = request.headers.authorization;
    let authUserId: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const { verifyJwt } = await import('../utils/jwt.js');
      const payload = verifyJwt(authHeader.slice(7), app.env.JWT_SECRET);
      if (payload?.sub) authUserId = payload.sub;
    }
    const { role, farm_id, market_id } = request.query as { role?: string; farm_id?: string; market_id?: string };

    // If farm_id or market_id provided, get conversations for the user AND all their partners
    let partnerUserIds: string[] = [];
    if (farm_id) {
      // Get user IDs of all markets related to this farm
      const rels = await app.db
        .selectFrom('farm_market_rels')
        .innerJoin('markets', 'markets.id', 'farm_market_rels.market_id')
        .select('markets.user_id')
        .where('farm_market_rels.farm_id', '=', farm_id)
        .where('farm_market_rels.active', '=', true)
        .execute();
      partnerUserIds = rels.map(r => r.user_id).filter(Boolean) as string[];
    }
    if (market_id) {
      // Get user IDs of all farms related to this market
      const rels = await app.db
        .selectFrom('farm_market_rels')
        .innerJoin('farms', 'farms.id', 'farm_market_rels.farm_id')
        .select('farms.user_id')
        .where('farm_market_rels.market_id', '=', market_id)
        .where('farm_market_rels.active', '=', true)
        .execute();
      partnerUserIds = rels.map(r => r.user_id).filter(Boolean) as string[];
    }

    // Build list of user IDs to include: the auth user + partners
    const includeUserIds = [...(authUserId ? [authUserId] : []), ...partnerUserIds];

    const conversations = await app.db
      .selectFrom('conversations')
      .innerJoin('users', 'users.id', 'conversations.user_id')
      .select([
        'conversations.id',
        'conversations.phone_number',
        'conversations.context',
        'conversations.last_message_at',
        'conversations.created_at',
        'users.name as user_name',
        'users.role as user_role',
      ])
      .orderBy('conversations.last_message_at', 'desc')
      .$if(includeUserIds.length > 0, (qb) => qb.where('conversations.user_id', 'in', includeUserIds))
      .$if(!!role, (qb) => qb.where('users.role', '=' as any, role as any))
      .execute();

    // For each conversation, get the last message and message count
    const results = await Promise.all(
      conversations.map(async (conv) => {
        const lastMessage = await app.db
          .selectFrom('messages')
          .select(['body', 'direction', 'created_at'])
          .where('conversation_id', '=', conv.id)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();

        const countResult = await app.db
          .selectFrom('messages')
          .select((eb) => eb.fn.count('id').as('count'))
          .where('conversation_id', '=', conv.id)
          .executeTakeFirst();

        return {
          id: conv.id,
          phone_number: conv.phone_number,
          context: conv.context,
          last_message_at: conv.last_message_at,
          created_at: conv.created_at,
          user_name: conv.user_name,
          user_role: conv.user_role,
          last_message: lastMessage?.body || null,
          last_message_direction: lastMessage?.direction || null,
          message_count: Number(countResult?.count || 0),
        };
      }),
    );

    reply.send({ conversations: results });
  });

  // voip.ms inbound webhook — handles both GET (query params) and POST (form body)
  const handleVoipmsInbound = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const params = {
      ...(request.query as Record<string, string>),
      ...(request.body as Record<string, string> ?? {}),
    };
    const from = params.from;
    const to = params.to;
    const message = params.message;
    const id = params.id || `voipms-${Date.now()}`;

    if (!from || !message) {
      app.log.warn({ method: request.method, params }, 'Invalid voip.ms webhook — missing from or message');
      return reply.type('text/plain').send('ok');
    }

    const normalizedFrom = from.startsWith('+') ? from : `+1${from}`;
    app.log.info({ from: normalizedFrom, to, body: message.substring(0, 50), id }, 'Inbound SMS (voip.ms)');

    const registeredUser = await app.db
      .selectFrom('users')
      .select(['id'])
      .where('phone', '=', normalizedFrom)
      .executeTakeFirst();

    if (!registeredUser) {
      await sendSms({
        env: app.env,
        to: normalizedFrom,
        body: '👋 Welcome! To use FarmLink, please create an account first at our website. Visit farmlink.us/signup to get started!',
      });
      return reply.type('text/plain').send('ok');
    }

    try {
      const responseText = await processInboundMessage({
        db: app.db,
        env: app.env,
        phone: normalizedFrom,
        message,
        messageSid: id,
      });

      await sendSms({
        env: app.env,
        to: normalizedFrom,
        body: responseText,
      });
    } catch (err) {
      app.log.error(err, 'Failed to process voip.ms inbound SMS');
    }

    return reply.type('text/plain').send('ok');
  };

  app.get('/voipms/inbound', handleVoipmsInbound);
  app.post('/voipms/inbound', handleVoipmsInbound);

  // Telnyx delivery status callback
  app.post('/status', async (request, reply) => {
    const body = request.body as { data?: { event_type?: string; payload?: { id?: string; to?: string } } };
    const eventType = body?.data?.event_type || 'unknown';
    const msgId = body?.data?.payload?.id || 'unknown';
    app.log.info({ id: msgId, event: eventType }, 'SMS status update');
    // TODO: update notification status in DB
    reply.send({ ok: true });
  });
}
