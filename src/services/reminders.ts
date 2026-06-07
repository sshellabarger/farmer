import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { v4 as uuid } from 'uuid';
import { sendPushToUser } from './push.js';
import { sendSms } from './sms.js';

const TIMEZONE = 'America/Chicago';
// A reminder fires when its time has passed within the last CATCH_WINDOW_MIN
// minutes and it hasn't already been sent today. The scheduler runs every
// 15 minutes, so a 30-minute window tolerates a missed/slow run.
const CATCH_WINDOW_MIN = 30;

function nowInCentral(): { day: string; minutes: number; dateStr: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const hour = parseInt(get('hour'), 10) % 24; // "24" can appear for midnight
  return {
    day: get('weekday'),
    minutes: hour * 60 + parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function timeToMinutes(time: string): number | null {
  const m = time?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export async function processDueReminders(db: Firestore, env: Env): Promise<{ checked: number; sent: number }> {
  const { day, minutes, dateStr } = nowInCentral();

  const snap = await db.collection('reminders').where('active', '==', true).get();
  let sent = 0;

  for (const doc of snap.docs) {
    const r = doc.data();

    if (r.last_sent_date === dateStr) continue;

    if (r.frequency === 'weekly') {
      const days = String(r.schedule_days || '').toLowerCase();
      if (!days.includes(day.toLowerCase().slice(0, 3))) continue;
    }

    const target = timeToMinutes(r.time);
    if (target === null) continue;
    const delta = minutes - target;
    if (delta < 0 || delta >= CATCH_WINDOW_MIN) continue;

    const userDoc = await db.collection('users').doc(r.user_id).get();
    const phone = userDoc.data()?.phone;
    if (!phone) continue;

    const body = `⏰ Reminder: ${r.title}`;

    // Best-effort push (free, shows if the app is open) — never counts as delivery.
    // FCM "success" only means Google accepted the message, not that the user saw it.
    sendPushToUser(db, r.user_id, {
      title: 'FarmLink Reminder',
      body: r.title,
      url: '/settings',
    }).catch(() => {});

    // SMS is the authoritative channel: reminders are time-critical, so we only
    // mark the reminder sent when the SMS actually goes out.
    let smsOk = true;
    try {
      await sendSms({ env, to: phone, body });
    } catch {
      smsOk = false;
    }

    // Audit trail so delivery failures are diagnosable.
    await db.collection('notifications').doc(uuid()).set({
      type: 'reminder',
      channel: 'sms',
      status: smsOk ? 'sent' : 'failed',
      user_id: r.user_id,
      reminder_id: doc.id,
      created_at: new Date(),
      sent_at: smsOk ? new Date() : null,
    }).catch(() => {});

    if (smsOk) {
      await doc.ref.update({ last_sent_date: dateStr, updated_at: new Date() });
      sent++;
    }
  }

  return { checked: snap.size, sent };
}
