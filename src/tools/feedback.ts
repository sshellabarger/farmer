import type { ToolContext } from './index.js';
import { sendSms } from '../services/telnyx.js';

/**
 * Notify all admin users via SMS about new feedback.
 */
async function notifyAdmins(ctx: ToolContext, feedbackType: string, title: string, userName: string) {
  const { db, env } = ctx;

  const admins = await db
    .selectFrom('users')
    .select(['phone'])
    .where('role', '=', 'admin')
    .execute();

  const label = feedbackType === 'feature_request' ? 'Feature request' : 'Bug report';
  const message = `📋 New ${label} from ${userName}:\n"${title}"\n\nReview at farmlink.us/feedback or reply "show feedback" to manage.`;

  for (const admin of admins) {
    try {
      await sendSms({ env, to: admin.phone, body: message });
    } catch (err) {
      console.warn(`[feedback] Failed to notify admin ${admin.phone}:`, (err as Error).message);
    }
  }
}

export async function feedbackSubmit(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  if (!userId) {
    return { error: 'You need to be registered to submit feedback. Would you like to sign up first?' };
  }

  const type = input.type as string;
  const title = input.title as string;
  const description = input.description as string;

  if (!type || !title || !description) {
    return { error: 'Missing required fields: type, title, and description.' };
  }

  const [feedback] = await db
    .insertInto('feedback')
    .values({
      user_id: userId,
      type: type as any,
      title,
      description,
      source: 'sms',
    })
    .returningAll()
    .execute();

  // Get submitter name for admin notification
  const user = await db
    .selectFrom('users')
    .select(['name'])
    .where('id', '=', userId)
    .executeTakeFirst();

  // Notify admins (fire-and-forget)
  notifyAdmins(ctx, type, title, user?.name || 'Unknown').catch(() => {});

  const label = type === 'feature_request' ? 'Feature request' : 'Bug report';

  return {
    success: true,
    feedback_id: feedback.id,
    message: `${label} submitted: "${title}". Our team will review it. Thank you for helping us improve FarmLink!`,
  };
}

export async function feedbackQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  if (!userId) {
    return { error: 'You must be logged in to view feedback.' };
  }

  // Check if user is admin
  const user = await db
    .selectFrom('users')
    .select(['role'])
    .where('id', '=', userId)
    .executeTakeFirst();

  const isAdmin = user?.role === 'admin';

  let query = db
    .selectFrom('feedback')
    .innerJoin('users', 'users.id', 'feedback.user_id')
    .select([
      'feedback.id',
      'feedback.type',
      'feedback.status',
      'feedback.priority',
      'feedback.title',
      'feedback.description',
      'users.name as submitted_by',
      'feedback.source',
      'feedback.created_at',
    ])
    .orderBy('feedback.created_at', 'desc');

  // Non-admins see only their own
  if (!isAdmin) {
    query = query.where('feedback.user_id', '=', userId);
  }

  // Apply filters
  if (input.type) {
    query = query.where('feedback.type', '=', input.type as any);
  }
  if (input.status) {
    query = query.where('feedback.status', '=', input.status as any);
  }
  if (input.priority) {
    query = query.where('feedback.priority', '=', input.priority as any);
  }

  // Admins also get admin_notes
  if (isAdmin) {
    query = query.select('feedback.admin_notes');
  }

  const items = await query.limit(20).execute();

  if (items.length === 0) {
    return { items: [], message: 'No feedback items found.' };
  }

  return {
    total: items.length,
    items: items.map((f) => ({
      id: f.id,
      type: f.type,
      status: f.status,
      priority: f.priority,
      title: f.title,
      submitted_by: f.submitted_by,
      source: f.source,
      created: f.created_at,
      ...(isAdmin && 'admin_notes' in f ? { admin_notes: f.admin_notes } : {}),
    })),
  };
}

export async function feedbackUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  if (!userId) {
    return { error: 'You must be logged in to update feedback.' };
  }

  // Only admins can update feedback status/priority
  const user = await db
    .selectFrom('users')
    .select(['role'])
    .where('id', '=', userId)
    .executeTakeFirst();

  if (user?.role !== 'admin') {
    return { error: 'Only admins can update feedback status and priority.' };
  }

  const feedbackId = input.feedback_id as string;
  if (!feedbackId) {
    return { error: 'Missing feedback_id.' };
  }

  const existing = await db
    .selectFrom('feedback')
    .selectAll()
    .where('id', '=', feedbackId)
    .executeTakeFirst();

  if (!existing) {
    return { error: 'Feedback item not found.' };
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };

  if (input.status) updates.status = input.status;
  if (input.priority) updates.priority = input.priority;
  if (input.admin_notes !== undefined) updates.admin_notes = input.admin_notes;

  const [updated] = await db
    .updateTable('feedback')
    .set(updates)
    .where('id', '=', feedbackId)
    .returningAll()
    .execute();

  return {
    success: true,
    feedback_id: updated.id,
    title: updated.title,
    status: updated.status,
    priority: updated.priority,
    admin_notes: updated.admin_notes,
    message: `Feedback "${updated.title}" updated — status: ${updated.status}, priority: ${updated.priority}.`,
  };
}
