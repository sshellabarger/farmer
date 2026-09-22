import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';
import { sendSms } from '../services/sms.js';

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return raw;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export async function inviteRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // POST /api/invite — text an invitation to join.
  app.post('/', { preHandler: [auth] }, async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      name: z.string().optional(),
    });
    const { phone, name } = schema.parse(request.body);
    const user = request.authUser!;

    // Inviter display name comes from the users doc (no business lookup).
    const userDoc = await app.db.collection('users').doc(user.id).get();
    const inviterName = userDoc.data()?.name || 'A FarmLink member';

    const to = normalizePhone(phone);
    const greeting = name ? `Hi ${name}! ` : 'Hi! ';
    const body = `${greeting}${inviterName} invited you to FarmLink, the St. Joseph Center of Arkansas farmers market manager. Learn more: ${app.env.APP_URL}`;

    // Logged to `messages` (kind 'invite') by sendSms; the invitee has no
    // user yet, so user_id records the inviter.
    let messageId: string;
    try {
      const result = await sendSms({ env: app.env, db: app.db, to, body, kind: 'invite', user_id: user.id, sent_by: user.id });
      messageId = result.message_id;
    } catch (err) {
      app.log.error({ err, to }, 'Failed to send invite SMS');
      return reply.status(502).send({ error: 'Could not send the invitation text. Please check the number and try again.' });
    }

    // Record the invite (best-effort) for follow-up.
    await app.db.collection('invites').add({
      invited_phone: to,
      invited_name: name || null,
      invited_by: user.id,
      message_id: messageId,
      created_at: new Date(),
    }).catch(() => {});

    return { success: true, message: `Invitation sent to ${to}` };
  });
}
