import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwt, verifyJwt } from '../utils/jwt.js';

// In-memory OTP store (use Redis in production)
const otpStore = new Map<string, { code: string; expires: number }>();

export async function authRoutes(app: FastifyInstance) {
  // ─── Signup: create user + farm/market, then send OTP ───
  app.post('/signup', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1, 'Name is required'),
      email: z.string().email('Valid email required'),
      phone: z.string().min(10, 'Phone number required'),
      role: z.enum(['farmer', 'market']),
      businessName: z.string().min(1, 'Business name is required'),
      location: z.string().min(1, 'Location is required'),
      // Market-specific
      marketType: z.enum(['farmers_market', 'restaurant', 'grocery', 'co_op', 'other']).optional(),
      deliveryPref: z.enum(['pickup', 'delivery', 'both']).optional(),
      // Farm-specific
      specialty: z.string().optional(),
    });

    const data = schema.parse(request.body);

    // Check if phone already registered
    const existing = await app.db
      .selectFrom('users')
      .selectAll()
      .where('phone', '=', data.phone)
      .executeTakeFirst();

    if (existing) {
      return reply.status(409).send({
        error: 'An account with this phone number already exists. Please sign in instead.',
      });
    }

    // Check if email already registered
    const existingEmail = await app.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', data.email)
      .executeTakeFirst();

    if (existingEmail) {
      return reply.status(409).send({
        error: 'An account with this email already exists. Please sign in instead.',
      });
    }

    // Create user
    const user = await app.db
      .insertInto('users')
      .values({
        name: data.name,
        phone: data.phone,
        email: data.email,
        role: data.role as any,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let farm = null;
    let market = null;

    if (data.role === 'farmer') {
      farm = await app.db
        .insertInto('farms')
        .values({
          user_id: user.id,
          name: data.businessName,
          location: data.location,
          specialty: data.specialty || null,
          phone: data.phone,
          email: data.email,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      market = await app.db
        .insertInto('markets')
        .values({
          user_id: user.id,
          name: data.businessName,
          location: data.location,
          type: (data.marketType || 'other') as any,
          delivery_pref: (data.deliveryPref || 'both') as any,
          phone: data.phone,
          email: data.email,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    // Generate OTP for phone verification
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(data.phone, { code, expires: Date.now() + 5 * 60 * 1000 });
    app.log.info({ phone: data.phone, code }, 'Signup OTP generated (dev mode — check logs)');

    // In production: send via SMS provider
    reply.status(201).send({
      success: true,
      message: 'Account created. Please verify your phone number.',
      userId: user.id,
      farm: farm ? { id: farm.id, name: farm.name } : null,
      market: market ? { id: market.id, name: market.name } : null,
    });
  });

  // ─── Check if phone exists (for login vs signup routing) ───
  app.post('/check-phone', async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10) });
    const { phone } = schema.parse(request.body);

    const user = await app.db
      .selectFrom('users')
      .select(['id', 'name', 'role'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    reply.send({ exists: !!user, user: user ? { name: user.name, role: user.role } : null });
  });

  // ─── Request OTP ───
  app.post('/otp/request', async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10) });
    const { phone } = schema.parse(request.body);

    // Only allow OTP for registered users
    const user = await app.db
      .selectFrom('users')
      .select(['id'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    if (!user) {
      return reply.status(404).send({
        error: 'No account found with this phone number. Please sign up first.',
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });

    app.log.info({ phone, code }, 'OTP generated (dev mode — check logs)');

    // In production: send via SMS provider
    reply.send({ success: true, message: 'OTP sent' });
  });

  // ─── Verify OTP and return JWT ───
  app.post('/otp/verify', async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      code: z.string().length(6),
    });
    const { phone, code } = schema.parse(request.body);

    // Verify OTP (dev mode accepts any 6-digit code)
    const stored = otpStore.get(phone);
    const isDev = app.env.NODE_ENV === 'development';

    if (!isDev && (!stored || stored.code !== code || stored.expires < Date.now())) {
      return reply.status(401).send({ error: 'Invalid or expired OTP' });
    }
    otpStore.delete(phone);

    const user = await app.db
      .selectFrom('users')
      .selectAll()
      .where('phone', '=', phone)
      .executeTakeFirst();

    if (!user) {
      return reply.status(404).send({
        error: 'No account found. Please sign up first.',
      });
    }

    const farm = await app.db
      .selectFrom('farms')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    const market = await app.db
      .selectFrom('markets')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    const token = signJwt({ sub: user.id, role: user.role }, app.env.JWT_SECRET);

    reply.send({
      success: true,
      token,
      user: { id: user.id, name: user.name, role: user.role, phone: user.phone },
      farm: farm ? { id: farm.id, name: farm.name } : null,
      market: market ? { id: market.id, name: market.name } : null,
    });
  });

  // Get current user from JWT
  app.get('/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const payload = verifyJwt(authHeader.slice(7), app.env.JWT_SECRET);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const user = await app.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', payload.sub)
      .executeTakeFirst();

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const farm = await app.db
      .selectFrom('farms')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    const market = await app.db
      .selectFrom('markets')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    reply.send({
      user: { id: user.id, name: user.name, role: user.role, phone: user.phone },
      farm: farm ? { id: farm.id, name: farm.name } : null,
      market: market ? { id: market.id, name: market.name } : null,
    });
  });
}
