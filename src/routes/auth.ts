import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { sendOtp, verifyOtp } from '../services/otp.js';
import { MARKET_TYPES } from '../types/schema.js';
import { v4 as uuid } from 'uuid';

export async function authRoutes(app: FastifyInstance) {
  // Signup
  app.post('/signup', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1, 'Name is required'),
      email: z.string().email('Valid email required'),
      phone: z.string().min(10, 'Phone number required'),
      role: z.enum(['farmer', 'market']),
      businessName: z.string().min(1, 'Business name is required'),
      location: z.string().min(1, 'Location is required'),
      marketType: z.enum(MARKET_TYPES).optional(),
      deliveryPref: z.enum(['pickup', 'delivery', 'both']).optional(),
      specialty: z.string().optional(),
    });

    const data = schema.parse(request.body);

    // Check if phone already registered
    const phoneSnap = await app.db
      .collection('users')
      .where('phone', '==', data.phone)
      .limit(1)
      .get();
    if (!phoneSnap.empty) {
      return reply.status(409).send({ error: 'An account with this phone number already exists.' });
    }

    // Check if email already registered
    const emailSnap = await app.db
      .collection('users')
      .where('email', '==', data.email)
      .limit(1)
      .get();
    if (!emailSnap.empty) {
      return reply.status(409).send({ error: 'An account with this email already exists.' });
    }

    const userId = uuid();
    await app.db.collection('users').doc(userId).set({
      name: data.name,
      phone: data.phone,
      email: data.email,
      role: data.role,
      created_at: new Date(),
      updated_at: new Date(),
    });

    let farm = null;
    let market = null;

    if (data.role === 'farmer') {
      const farmId = uuid();
      const farmData = {
        user_id: userId,
        name: data.businessName,
        location: data.location,
        specialty: data.specialty || null,
        phone: data.phone,
        email: data.email,
        active: true,
        timezone: 'America/Chicago',
        delivery_schedule: [],
        contacts: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      await app.db.collection('farms').doc(farmId).set(farmData);
      farm = { id: farmId, name: data.businessName };
    } else {
      const marketId = uuid();
      const marketData = {
        user_id: userId,
        name: data.businessName,
        location: data.location,
        type: data.marketType || 'other',
        delivery_pref: data.deliveryPref || 'both',
        phone: data.phone,
        email: data.email,
        active: true,
        contacts: [],
        created_at: new Date(),
        updated_at: new Date(),
      };
      await app.db.collection('markets').doc(marketId).set(marketData);
      market = { id: marketId, name: data.businessName };
    }

    try {
      await sendOtp(app.db, app.env, data.phone);
    } catch (err) {
      app.log.error({ err, phone: data.phone }, 'Failed to send signup OTP');
      // Account is created; surface a soft error so the user can retry the OTP request.
      return reply.status(201).send({
        success: true,
        message: 'Account created, but we could not send your verification code. Please request a new code.',
        userId,
        farm,
        market,
        otp_send_failed: true,
      });
    }

    reply.status(201).send({
      success: true,
      message: 'Account created. A verification code has been sent to your phone.',
      userId,
      farm,
      market,
    });
  });

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
      return reply.status(404).send({ error: 'No account found. Please sign up first.' });
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

    const farmSnap = await app.db.collection('farms').where('user_id', '==', userId).limit(1).get();
    const marketSnap = await app.db.collection('markets').where('user_id', '==', userId).limit(1).get();

    const farm = farmSnap.empty ? null : { id: farmSnap.docs[0].id, name: farmSnap.docs[0].data().name };
    const market = marketSnap.empty ? null : { id: marketSnap.docs[0].id, name: marketSnap.docs[0].data().name };

    const token = signJwt({ sub: userId, role: user.role }, app.env.JWT_SECRET);

    reply.send({
      success: true,
      token,
      user: { id: userId, name: user.name, role: user.role, phone: user.phone },
      farm,
      market,
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

    const farmSnap = await app.db.collection('farms').where('user_id', '==', payload.sub).limit(1).get();
    const marketSnap = await app.db.collection('markets').where('user_id', '==', payload.sub).limit(1).get();

    const farm = farmSnap.empty ? null : { id: farmSnap.docs[0].id, name: farmSnap.docs[0].data().name };
    const market = marketSnap.empty ? null : { id: marketSnap.docs[0].id, name: marketSnap.docs[0].data().name };

    reply.send({
      user: { id: userDoc.id, name: user.name, role: user.role, phone: user.phone },
      farm,
      market,
    });
  });
}
