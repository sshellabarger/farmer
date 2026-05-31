import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { v4 as uuid } from 'uuid';

// In-memory OTP store (use Firestore TTL docs in production)
const otpStore = new Map<string, { code: string; expires: number }>();

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
      marketType: z.enum(['farmers_market', 'restaurant', 'grocery', 'co_op', 'other']).optional(),
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

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(data.phone, { code, expires: Date.now() + 5 * 60 * 1000 });
    app.log.info({ phone: data.phone, code }, 'Signup OTP generated');

    reply.status(201).send({
      success: true,
      message: 'Account created. Please verify your phone number.',
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

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });
    app.log.info({ phone, code }, 'OTP generated');

    reply.send({ success: true, message: 'OTP sent' });
  });

  // Verify OTP
  app.post('/otp/verify', async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      code: z.string().length(6),
    });
    const { phone, code } = schema.parse(request.body);

    const stored = otpStore.get(phone);
    const isDev = app.env.NODE_ENV === 'development';

    if (!isDev && (!stored || stored.code !== code || stored.expires < Date.now())) {
      return reply.status(401).send({ error: 'Invalid or expired OTP' });
    }
    otpStore.delete(phone);

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
