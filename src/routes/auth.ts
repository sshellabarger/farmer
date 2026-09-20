import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { sendOtp, verifyOtp } from '../services/otp.js';

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
      user: { id: userId, name: user.name, role: user.role, phone: user.phone },
    });
  });

  // Get current user
  app.get('/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const payload = verifyJwt(authHeader.slice(7), app.env.JWT_SECRET);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const userDoc = await app.db.collection('users').doc(payload.sub).get();
    if (!userDoc.exists) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const user = userDoc.data()!;

    reply.send({
      user: { id: userDoc.id, name: user.name, role: user.role, phone: user.phone },
    });
  });
}
