import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.js';
import { sendSms } from '../services/sms.js';
import { normalizePhone } from '../routes/sms.js';

interface SmsOutcome {
  status: 'sent' | 'simulated' | 'failed';
  error?: string;
}

async function sendInviteText(app: FastifyInstance, opts: { to: string; body: string; userId: string; sentBy: string }): Promise<SmsOutcome> {
  const args = { env: app.env, db: app.db, to: opts.to, body: opts.body, kind: 'admin_invite' as const, user_id: opts.userId, sent_by: opts.sentBy };
  try {
    await sendSms(args);
    return { status: app.env.NODE_ENV === 'production' ? 'sent' : 'simulated' };
  } catch (err) {
    return { status: 'failed', error: String(err) };
  }
}

export async function adminUserRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const adminOnly = [auth, requireRole('admin')];

  // ─── GET /api/admin/users ───
  app.get('/', { preHandler: adminOnly }, async () => {
    const snap = await app.db.collection('users').get();
    const users = snap.docs.map((doc) => {
      const u = doc.data();
      return {
        id: doc.id,
        name: u.name ?? null,
        phone: u.phone ?? null,
        email: u.email ?? null,
        role: u.role,
        assigned_market_ids: Array.isArray(u.assigned_market_ids) ? u.assigned_market_ids : [],
        active: u.active !== false,
        sms_opt_out_at: u.sms_opt_out_at ?? null,
        invited_at: u.invited_at ?? null,
        created_at: u.created_at ?? null,
      };
    });
    return { users };
  });

  // ─── POST /api/admin/users/invite ───
  app.post('/invite', { preHandler: adminOnly }, async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10),
      name: z.string().min(1),
      role: z.enum(['admin', 'market_manager']),
      assigned_market_ids: z.array(z.string()).default([]),
      email: z.string().email().optional(),
    });
    const input = schema.parse(request.body);
    const phone = normalizePhone(input.phone);
    const user = request.authUser!;

    if (input.role === 'market_manager' && input.assigned_market_ids.length === 0) {
      return reply.status(400).send({ error: 'market_manager requires at least one assigned_market_ids entry' });
    }

    const dup = await app.db.collection('users').where('phone', '==', phone).limit(1).get();
    if (!dup.empty) return reply.status(409).send({ error: 'A user with this phone number already exists' });

    const now = new Date();
    const userId = uuid();
    const newUser = {
      name: input.name,
      phone,
      email: input.email ?? null,
      role: input.role,
      assigned_market_ids: input.assigned_market_ids,
      active: true,
      fcm_tokens: [],
      sms_opt_out_at: null,
      invited_by: user.id,
      invited_at: now,
      created_at: now,
      updated_at: now,
    };
    await app.db.collection('users').doc(userId).set(newUser);

    const body = `${user.name ?? 'A staff member'} added you to the SJCA Market Manager (${input.role === 'admin' ? 'admin' : 'market manager'}). Sign in with this phone number at ${app.env.APP_URL}/login`;
    const sms = await sendInviteText(app, { to: phone, body, userId, sentBy: user.id });

    const inviteId = uuid();
    await app.db.collection('invites').doc(inviteId).set({
      invited_phone: phone,
      invited_name: input.name,
      invited_by: user.id,
      kind: 'admin_user',
      user_id: userId,
      role: input.role,
      assigned_market_ids: input.assigned_market_ids,
      message_id: null,
      created_at: now,
    });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'user.invite',
      target: { collection: 'users', id: userId },
      after: newUser,
    });

    return reply.status(201).send({ user: { id: userId, ...newUser }, sms });
  });

  // ─── POST /api/admin/users/:id/resend-invite ───
  app.post('/:id/resend-invite', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const doc = await app.db.collection('users').doc(id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'User not found' });
    const target = doc.data()!;

    const body = `${user.name ?? 'A staff member'} added you to the SJCA Market Manager (${target.role === 'admin' ? 'admin' : 'market manager'}). Sign in with this phone number at ${app.env.APP_URL}/login`;
    const sms = await sendInviteText(app, { to: target.phone as string, body, userId: id, sentBy: user.id });

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'user.invite.resend',
      target: { collection: 'users', id },
    });

    return { sms };
  });

  // ─── PATCH /api/admin/users/:id ───
  app.patch('/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const doc = await app.db.collection('users').doc(id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'User not found' });
    const existing = doc.data()!;

    const schema = z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().nullable().optional(),
      role: z.enum(['admin', 'market_manager']).optional(),
      assigned_market_ids: z.array(z.string()).optional(),
      active: z.boolean().optional(),
    });
    const input = schema.parse(request.body);

    if (id === user.id && ((input.role !== undefined && input.role !== 'admin') || input.active === false)) {
      return reply.status(409).send({ error: 'You cannot demote or deactivate your own account' });
    }

    const now = new Date();
    const update: Record<string, unknown> = { updated_at: now };
    if (input.name !== undefined) update.name = input.name;
    if (input.email !== undefined) update.email = input.email;
    if (input.role !== undefined) update.role = input.role;
    if (input.assigned_market_ids !== undefined) update.assigned_market_ids = input.assigned_market_ids;
    if (input.active !== undefined) update.active = input.active;

    await app.db.collection('users').doc(id).update(update);
    const updated = { id, ...existing, ...update };

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'user.update',
      target: { collection: 'users', id },
      before: existing,
      after: update,
    });

    return { user: updated };
  });
}
