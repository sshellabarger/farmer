import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processInboundMessage } from '../services/conversation.js';
import { sendSms } from '../services/telnyx.js';

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

  // List all conversations with last message, user info, and message count
  app.get('/conversations', async (request, reply) => {
    const { role } = request.query as { role?: string };

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
