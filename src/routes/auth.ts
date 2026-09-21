import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwt } from '../utils/jwt.js';
import { sendOtp, verifyOtp } from '../services/otp.js';
import { authenticate } from '../middleware/rbac.js';

/**
 * Phone-OTP login. There is no self-service signup any more: v1's /signup
 * created farm/market docs and is retired; the public producer application
 * form arrives in Phase 2 and admin accounts are created by invite.
 */
export async function authRoutes(app: FastifyInstance) {
  // Check if phone exists
  app.post('/check-phone', async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10) });
    const { phone } = schema.parse(request.body);

    const snap = await app.db.collection('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) {
      reply.send({ exists: false, user: null });
    } else {
      const user = snap.docs[0].data();
      reply.send({ exists: true, user: { name: user.name, role: user.role } });
    }
  });

  // Request OTP
  app.post('/otp/request', async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10) });
    const { phone } = schema.parse(request.body);

    const snap = await app.db.collection('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) {
      return reply.status(404).send({ error: 'No account found for this number.' });
    }
    if (snap.docs[0].data().active === false) {
      return reply.status(403).send({ error: 'This account has been deactivated.' });
    }

    try {
      await sendOtp(app.db, app.env, phone);
    } catch (err) {
      app.log.error({ err, phone }, 'Failed to send OTP');
      return reply.status(502).send({ error: 'Could not send verification code. Please try again shortly.' });
    }

    reply.send({ success: true, message: 'OTP sent' });
  });

  // Verify OTP
  app.post('/otp/verify', async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      code: z.string().length(6),
    });
    const { phone, code } = schema.parse(request.body);

    const isDev = app.env.NODE_ENV === 'development';
    const valid = await verifyOtp(app.db, phone, code, isDev);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid or expired OTP' });
    }

    const userSnap = await app.db.collection('users').where('phone', '==', phone).limit(1).get();
    if (userSnap.empty) {
      return reply.status(404).send({ error: 'No account found.' });
    }

    const userId = userSnap.docs[0].id;
    const user = userSnap.docs[0].data();
    const token = signJwt({ sub: userId, role: user.role }, app.env.JWT_SECRET);

    reply.send({
      success: true,
      token,
      user: {
        id: userId,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email ?? null,
        assigned_market_ids: Array.isArray(user.assigned_market_ids) ? user.assigned_market_ids : [],
      },
    });
  });

  // Get current user. The shared preHandler does the Bearer → JWT → users
  // lookup and rejects with 401 before this handler runs.
  app.get('/me', { preHandler: authenticate(app) }, async (request, reply) => {
    const user = request.authUser!;
    reply.send({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        assigned_market_ids: user.assigned_market_ids,
      },
    });
  });
}
