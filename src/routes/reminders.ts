import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/rbac.js';
import { byDateDesc } from '../utils/sort.js';
import { v4 as uuid } from 'uuid';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const createSchema = z.object({
  title: z.string().min(1).max(255),
  frequency: z.enum(['daily', 'weekly']),
  schedule_days: z.string().max(100).optional(),
  time: z.string().regex(timePattern, 'Time must be HH:mm (24-hour)'),
});

const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  frequency: z.enum(['daily', 'weekly']).optional(),
  schedule_days: z.string().max(100).optional(),
  time: z.string().regex(timePattern, 'Time must be HH:mm (24-hour)').optional(),
  active: z.boolean().optional(),
});

export async function reminderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate(app));

  // GET /api/reminders — the user's own reminders
  app.get('/', async (request) => {
    const user = request.authUser!;
    const snap = await app.db.collection('reminders').where('user_id', '==', user.id).get();
    const reminders = byDateDesc(
      snap.docs.map((d) => ({ id: d.id, ...d.data(), created_at: d.data().created_at } as any)),
      'created_at',
    ).map((r: any) => ({
      id: r.id,
      title: r.title,
      frequency: r.frequency,
      schedule_days: r.schedule_days,
      time: r.time,
      active: r.active,
      created_at: r.created_at,
    }));
    return { reminders };
  });

  // POST /api/reminders
  app.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const user = request.authUser!;
    const { title, frequency, schedule_days, time } = parsed.data;
    if (frequency === 'weekly' && !schedule_days?.trim()) {
      return reply.status(400).send({ error: 'Weekly reminders need at least one day.' });
    }

    const id = uuid();
    const reminder = {
      user_id: user.id,
      title,
      frequency,
      schedule_days: frequency === 'weekly' ? schedule_days!.trim() : '',
      time,
      active: true,
      last_sent_date: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    await app.db.collection('reminders').doc(id).set(reminder);
    return reply.status(201).send({ id, ...reminder });
  });

  // PUT /api/reminders/:id
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const user = request.authUser!;
    const ref = app.db.collection('reminders').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()!.user_id !== user.id) return reply.notFound('Reminder not found');

    const updates: Record<string, unknown> = { updated_at: new Date() };
    const { title, frequency, schedule_days, time, active } = parsed.data;
    if (title !== undefined) updates.title = title;
    if (frequency !== undefined) updates.frequency = frequency;
    if (schedule_days !== undefined) updates.schedule_days = schedule_days.trim();
    if (time !== undefined) updates.time = time;
    if (active !== undefined) updates.active = active;

    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // DELETE /api/reminders/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = request.authUser!;
    const ref = app.db.collection('reminders').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()!.user_id !== user.id) return reply.notFound('Reminder not found');
    await ref.delete();
    reply.status(204).send();
  });
}
