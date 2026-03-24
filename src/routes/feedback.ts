import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { sendSms } from '../services/telnyx.js';

const createSchema = z.object({
  type: z.enum(['feature_request', 'bug_report']),
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  source: z.enum(['sms', 'web', 'system']).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().min(1).optional(),
  status: z.enum(['open', 'under_review', 'planned', 'in_progress', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  admin_notes: z.string().nullable().optional(),
});

export async function feedbackRoutes(app: FastifyInstance) {
  // All feedback routes require authentication
  app.addHook('preHandler', authenticate(app));

  // GET /api/feedback — list feedback
  // Admins see all; regular users see only their own
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { type, status, priority } = request.query;
    const user = request.authUser!;

    let query = app.db
      .selectFrom('feedback')
      .innerJoin('users', 'users.id', 'feedback.user_id')
      .select([
        'feedback.id',
        'feedback.user_id',
        'users.name as user_name',
        'users.role as user_role',
        'feedback.type',
        'feedback.status',
        'feedback.priority',
        'feedback.title',
        'feedback.description',
        'feedback.source',
        'feedback.created_at',
        'feedback.updated_at',
      ])
      .orderBy('feedback.created_at', 'desc');

    // Non-admins only see their own feedback
    if (user.role !== 'admin') {
      query = query.where('feedback.user_id', '=', user.id);
    } else {
      // Admins also get admin_notes
      query = query.select('feedback.admin_notes');
    }

    if (type) {
      query = query.where('feedback.type', '=', type as any);
    }
    if (status) {
      query = query.where('feedback.status', '=', status as any);
    }
    if (priority) {
      query = query.where('feedback.priority', '=', priority as any);
    }

    const items = await query.execute();
    return { feedback: items };
  });

  // POST /api/feedback — create feedback
  app.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }

    const user = request.authUser!;
    const { type, title, description, source } = parsed.data;

    const [feedback] = await app.db
      .insertInto('feedback')
      .values({
        user_id: user.id,
        type,
        title,
        description,
        source: source || 'web',
      })
      .returningAll()
      .execute();

    // Notify admins via SMS (fire-and-forget)
    const userName = await app.db
      .selectFrom('users')
      .select(['name'])
      .where('id', '=', user.id)
      .executeTakeFirst();

    const admins = await app.db
      .selectFrom('users')
      .select(['phone'])
      .where('role', '=', 'admin')
      .execute();

    const label = type === 'feature_request' ? 'Feature request' : 'Bug report';
    const notifMsg = `📋 New ${label} from ${userName?.name || 'User'}:\n"${title}"\n\nReview at farmlink.us/feedback or reply "show feedback" to manage.`;

    for (const admin of admins) {
      sendSms({ env: app.env, to: admin.phone, body: notifMsg }).catch((err) => {
        app.log.warn(`Failed to notify admin ${admin.phone}: ${(err as Error).message}`);
      });
    }

    return reply.status(201).send(feedback);
  });

  // GET /api/feedback/:id — get single feedback item
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = request.authUser!;
    const { id } = request.params;

    const feedback = await app.db
      .selectFrom('feedback')
      .innerJoin('users', 'users.id', 'feedback.user_id')
      .select([
        'feedback.id',
        'feedback.user_id',
        'users.name as user_name',
        'users.role as user_role',
        'feedback.type',
        'feedback.status',
        'feedback.priority',
        'feedback.title',
        'feedback.description',
        'feedback.admin_notes',
        'feedback.source',
        'feedback.created_at',
        'feedback.updated_at',
      ])
      .where('feedback.id', '=', id)
      .executeTakeFirst();

    if (!feedback) {
      return reply.notFound('Feedback not found');
    }

    // Non-admins can only view their own feedback
    if (user.role !== 'admin' && feedback.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Strip admin_notes for non-admins
    if (user.role !== 'admin') {
      const { admin_notes, ...rest } = feedback;
      return rest;
    }

    return feedback;
  });

  // PUT /api/feedback/:id — update feedback
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }

    const user = request.authUser!;
    const { id } = request.params;

    // Look up existing feedback
    const existing = await app.db
      .selectFrom('feedback')
      .select(['user_id'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!existing) {
      return reply.notFound('Feedback not found');
    }

    const isOwner = existing.user_id === user.id;
    const isAdmin = user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Non-admins can only update title and description on their own items
    const { title, description, status, priority, admin_notes } = parsed.data;
    const updates: Record<string, unknown> = { updated_at: new Date() };

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;

    // Admin-only fields
    if (isAdmin) {
      if (status !== undefined) updates.status = status;
      if (priority !== undefined) updates.priority = priority;
      if (admin_notes !== undefined) updates.admin_notes = admin_notes;
    }

    const [updated] = await app.db
      .updateTable('feedback')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .execute();

    return updated;
  });

  // DELETE /api/feedback/:id — admin only
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    const { id } = request.params;

    const existing = await app.db
      .selectFrom('feedback')
      .select(['id'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!existing) {
      return reply.notFound('Feedback not found');
    }

    await app.db
      .deleteFrom('feedback')
      .where('id', '=', id)
      .execute();

    return { success: true };
  });
}
