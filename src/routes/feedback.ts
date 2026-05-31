import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { sendSms } from '../services/sms.js';
import { v4 as uuid } from 'uuid';

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
  app.addHook('preHandler', authenticate(app));

  // GET /api/feedback
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { type, status, priority } = request.query;
    const user = request.authUser!;

    let query: FirebaseFirestore.Query = app.db.collection('feedback');
    if (user.role !== 'admin') query = query.where('user_id', '==', user.id);
    if (type) query = query.where('type', '==', type);
    if (status) query = query.where('status', '==', status);
    if (priority) query = query.where('priority', '==', priority);

    const snapshot = await query.orderBy('created_at', 'desc').get();

    const feedback = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const fb = doc.data();
        const userDoc = await app.db.collection('users').doc(fb.user_id).get();
        const userData = userDoc.data() || {};
        const result: any = {
          id: doc.id,
          user_id: fb.user_id,
          user_name: userData.name || 'Unknown',
          user_role: userData.role,
          type: fb.type,
          status: fb.status,
          priority: fb.priority,
          title: fb.title,
          description: fb.description,
          source: fb.source,
          created_at: fb.created_at,
          updated_at: fb.updated_at,
        };
        if (user.role === 'admin') result.admin_notes = fb.admin_notes;
        return result;
      }),
    );

    return { feedback };
  });

  // POST /api/feedback
  app.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const user = request.authUser!;
    const { type, title, description, source } = parsed.data;
    const id = uuid();

    const feedback = {
      user_id: user.id,
      type,
      title,
      description,
      source: source || 'web',
      status: 'open',
      priority: 'medium',
      admin_notes: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await app.db.collection('feedback').doc(id).set(feedback);

    // Notify admins
    const userDoc = await app.db.collection('users').doc(user.id).get();
    const adminsSnap = await app.db.collection('users').where('role', '==', 'admin').get();
    const label = type === 'feature_request' ? 'Feature request' : 'Bug report';
    const notifMsg = `New ${label} from ${userDoc.data()?.name || 'User'}:\n"${title}"`;

    for (const adminDoc of adminsSnap.docs) {
      sendSms({ env: app.env, to: adminDoc.data().phone, body: notifMsg }).catch((err) => {
        app.log.warn(`Failed to notify admin: ${(err as Error).message}`);
      });
    }

    return reply.status(201).send({ id, ...feedback });
  });

  // GET /api/feedback/:id
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = request.authUser!;
    const doc = await app.db.collection('feedback').doc(request.params.id).get();
    if (!doc.exists) return reply.notFound('Feedback not found');

    const fb = doc.data()!;
    if (user.role !== 'admin' && fb.user_id !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const userDoc = await app.db.collection('users').doc(fb.user_id).get();
    const result: any = {
      id: doc.id,
      ...fb,
      user_name: userDoc.data()?.name || 'Unknown',
      user_role: userDoc.data()?.role,
    };
    if (user.role !== 'admin') delete result.admin_notes;
    return result;
  });

  // PUT /api/feedback/:id
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const user = request.authUser!;
    const ref = app.db.collection('feedback').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Feedback not found');

    const fb = doc.data()!;
    const isOwner = fb.user_id === user.id;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isAdmin) return reply.status(403).send({ error: 'Forbidden' });

    const { title, description, status, priority, admin_notes } = parsed.data;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (isAdmin) {
      if (status !== undefined) updates.status = status;
      if (priority !== undefined) updates.priority = priority;
      if (admin_notes !== undefined) updates.admin_notes = admin_notes;
    }

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // DELETE /api/feedback/:id (admin only)
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: requireRole('admin'),
  }, async (request, reply) => {
    const ref = app.db.collection('feedback').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Feedback not found');
    await ref.delete();
    return { success: true };
  });
}
