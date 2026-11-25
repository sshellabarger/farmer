import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizeDays(input: string): string {
  const parts = input.toLowerCase().split(/[,&\s]+/).map((d) => d.trim()).filter(Boolean);
  const matched = WEEKDAYS.filter((day) => parts.some((p) => day.toLowerCase().startsWith(p.slice(0, 3))));
  return matched.join(', ');
}

function normalizeTime(input: string): string | null {
  // Accept "8am", "8:30 AM", "14:00", "2pm" → "HH:mm" 24h.
  const m = input.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === 'pm' && hours < 12) hours += 12;
  if (m[3] === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export async function reminderSet(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You need to be registered to set reminders.' };

  const title = input.title as string;
  const frequency = input.frequency as string;
  const timeRaw = input.time as string;
  if (!title || !frequency || !timeRaw) return { error: 'Missing required fields: title, frequency, and time.' };

  const time = normalizeTime(timeRaw);
  if (!time) return { error: `Could not understand the time "${timeRaw}". Try formats like "8am", "2:30 PM", or "14:00".` };

  let scheduleDays = '';
  if (frequency === 'weekly') {
    scheduleDays = normalizeDays((input.schedule_days as string) || '');
    if (!scheduleDays) return { error: 'For weekly reminders, specify the day(s), e.g. "Monday" or "Tue, Fri".' };
  }

  const id = uuid();
  await db.collection('reminders').doc(id).set({
    user_id: userId,
    title,
    frequency,
    schedule_days: scheduleDays,
    time,
    active: true,
    last_sent_date: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const when = frequency === 'daily' ? `daily at ${time}` : `every ${scheduleDays} at ${time}`;
  return { success: true, reminder_id: id, message: `Reminder set: "${title}" — ${when} (Central time).` };
}

export async function reminderList(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You need to be registered to view reminders.' };

  const snap = await db.collection('reminders').where('user_id', '==', userId).get();
  const items = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .filter((r) => (input.include_paused ? true : r.active))
    .map((r) => ({
      id: r.id,
      title: r.title,
      frequency: r.frequency,
      schedule_days: r.schedule_days,
      time: r.time,
      active: r.active,
    }));

  if (items.length === 0) return { items: [], message: 'No reminders set.' };
  return { total: items.length, items };
}

export async function reminderUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { error: 'You need to be registered to manage reminders.' };

  const reminderId = input.reminder_id as string;
  if (!reminderId) return { error: 'Missing reminder_id. Use reminder_list to find it.' };

  const ref = db.collection('reminders').doc(reminderId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.user_id !== userId) return { error: 'Reminder not found.' };

  if (input.delete === true) {
    await ref.delete();
    return { success: true, message: `Reminder "${doc.data()!.title}" deleted.` };
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (input.active !== undefined) updates.active = !!input.active;
  if (input.title) updates.title = input.title;
  if (input.time) {
    const time = normalizeTime(input.time as string);
    if (!time) return { error: `Could not understand the time "${input.time}".` };
    updates.time = time;
  }
  if (input.frequency) updates.frequency = input.frequency;
  if (input.schedule_days) {
    const days = normalizeDays(input.schedule_days as string);
    if (!days) return { error: `Could not understand the day(s) "${input.schedule_days}".` };
    updates.schedule_days = days;
  }

  await ref.update(updates);
  const updated = (await ref.get()).data()!;
  const when = updated.frequency === 'daily' ? `daily at ${updated.time}` : `every ${updated.schedule_days} at ${updated.time}`;
  return { success: true, message: `Reminder "${updated.title}" updated — ${when}, ${updated.active ? 'active' : 'paused'}.` };
}
