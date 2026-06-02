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

  // POST /api/invite — text an invitation to a prospective farm or market.
  app.post('/', { preHandler: [auth] }, async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      name: z.string().optional(),
    });
    const { phone, name } = schema.parse(request.body);
    const user = request.authUser!;

    // Resolve the inviter's display name + business.
    const userDoc = await app.db.collection('users').doc(user.id).get();
    const inviterName = userDoc.data()?.name || 'A FarmLink member';

    let business = '';
    if (user.farmId) {
      const f = await app.db.collection('farms').doc(user.farmId).get();
      business = f.data()?.name || '';
    } else if (user.marketId) {
      const m = await app.db.collection('markets').doc(user.marketId).get();
      business = m.data()?.name || '';
    }

    const to = normalizePhone(phone);
    const greeting = name ? `Hi ${name}! ` : 'Hi! ';
    const inviter = business ? `${inviterName} at ${business}` : inviterName;
    const body = `${greeting}${inviter} wants you to join FarmLink — a free, text-first way to connect local farms and markets. Sign up here: ${app.env.APP_URL}/signup`;

    try {
      await sendSms({ env: app.env, to, body });
    } catch (err) {
      app.log.error({ err, to }, 'Failed to send invite SMS');
      return reply.status(502).send({ error: 'Could not send the invitation text. Please check the number and try again.' });
    }

    // Record the invite (best-effort) for follow-up/analytics.
    await app.db.collection('invites').add({
      invited_phone: to,
      invited_name: name || null,
      invited_by: user.id,
      inviter_business: business || null,
      created_at: new Date(),
    }).catch(() => {});

    return { success: true, message: `Invitation sent to ${to}` };
  });
}
