import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processInboundMessage } from '../services/conversation.js';
import { sendSms } from '../services/twilio.js';

const inboundSchema = z.object({
  From: z.string(),
  To: z.string(),
  Body: z.string(),
  MessageSid: z.string(),
  NumMedia: z.coerce.number().optional(),
});

export async function smsRoutes(app: FastifyInstance) {
  // Twilio inbound webhook
  app.post('/inbound', async (request, reply) => {
    const parsed = inboundSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    const { From: from, Body: body, MessageSid: messageSid } = parsed.data;

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
      return reply.type('text/xml').send('<Response></Response>');
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

      // Send reply via Twilio
      await sendSms({
        env: app.env,
        to: from,
        body: responseText,
      });

      // Return empty TwiML (we send reply via API, not TwiML response)
      reply.type('text/xml').send('<Response></Response>');
    } catch (err) {
      app.log.error(err, 'Failed to process inbound SMS');
      // Still return 200 so Twilio doesn't retry
      reply.type('text/xml').send('<Response></Response>');
    }
  });

  // Direct chat endpoint — bypasses Twilio, for web testing
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

  // Twilio delivery status callback
  app.post('/status', async (request, reply) => {
    const body = request.body as Record<string, string>;
    app.log.info({ sid: body.MessageSid, status: body.MessageStatus }, 'SMS status update');
    // TODO: update notification status in DB
    reply.send({ ok: true });
  });
}
