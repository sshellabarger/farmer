import type { ToolContext } from './index.js';
import { notifySupportFeedback } from '../services/support-notify.js';
import { byDateDesc } from '../utils/sort.js';
import { v4 as uuid } from 'uuid';

export async function feedbackSubmit(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You need to be registered to submit feedback.' };

  const type = input.type as string;
  const title = input.title as string;
  const description = input.description as string;
  if (!type || !title || !description) return { error: 'Missing required fields: type, title, and description.' };

  const id = uuid();
  await db.collection('feedback').doc(id).set({
    user_id: userId, type, title, description, source: 'sms',
    status: 'open', priority: 'medium', admin_notes: null,
    created_at: new Date(), updated_at: new Date(),
  });

  const userDoc = await db.collection('users').doc(userId).get();
  notifySupportFeedback(ctx.env, {
    type, title, description,
    submittedBy: userDoc.data()?.name || 'Unknown',
    source: 'sms',
  }).catch(() => {});

  const label = type === 'feature_request' ? 'Feature request' : 'Bug report';
  return { success: true, feedback_id: id, message: `${label} submitted: "${title}". Thank you!` };
}

export async function feedbackQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You must be logged in to view feedback.' };

  const userDoc = await db.collection('users').doc(userId).get();
  const isAdmin = userDoc.data()?.role === 'admin';

  let query: FirebaseFirestore.Query = db.collection('feedback');
  if (!isAdmin) query = query.where('user_id', '==', userId);

  const snapshot = await query.get();
  const filtered = snapshot.docs.filter((d) => {
    const fb = d.data();
    if (input.type && fb.type !== input.type) return false;
    if (input.status && fb.status !== input.status) return false;
    if (input.priority && fb.priority !== input.priority) return false;
    return true;
  });
  const fbDocs = byDateDesc(filtered.map((d) => ({ doc: d, created_at: d.data().created_at })), 'created_at').slice(0, 20).map((x) => x.doc);

  const items = await Promise.all(
    fbDocs.map(async (doc) => {
      const fb = doc.data();
      const submitterDoc = await db.collection('users').doc(fb.user_id).get();
      return {
        id: doc.id,
        type: fb.type,
        status: fb.status,
        priority: fb.priority,
        title: fb.title,
        submitted_by: submitterDoc.data()?.name || 'Unknown',
        source: fb.source,
        created: fb.created_at,
        ...(isAdmin ? { admin_notes: fb.admin_notes } : {}),
      };
    }),
  );

  if (items.length === 0) return { items: [], message: 'No feedback items found.' };
  return { total: items.length, items };
}

export async function feedbackUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You must be logged in to update feedback.' };

  const userDoc = await db.collection('users').doc(userId).get();
  if (userDoc.data()?.role !== 'admin') return { error: 'Only admins can update feedback.' };

  const feedbackId = input.feedback_id as string;
  if (!feedbackId) return { error: 'Missing feedback_id.' };

  const ref = db.collection('feedback').doc(feedbackId);
  const doc = await ref.get();
  if (!doc.exists) return { error: 'Feedback item not found.' };

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (input.status) updates.status = input.status;
  if (input.priority) updates.priority = input.priority;
  if (input.admin_notes !== undefined) updates.admin_notes = input.admin_notes;

  await ref.update(updates);
  const updated = await ref.get();
  const data = updated.data()!;

  return {
    success: true,
    feedback_id: updated.id,
    title: data.title,
    status: data.status,
    priority: data.priority,
    admin_notes: data.admin_notes,
    message: `Feedback "${data.title}" updated — status: ${data.status}, priority: ${data.priority}.`,
  };
}
