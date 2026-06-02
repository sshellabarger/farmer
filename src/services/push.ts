import { getMessaging } from 'firebase-admin/messaging';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { sendSms } from './sms.js';

/** Store an FCM web-push token on the user's record. */
export async function registerToken(db: Firestore, userId: string, token: string): Promise<void> {
  await db.collection('users').doc(userId).update({
    fcm_tokens: FieldValue.arrayUnion(token),
  }).catch(async () => {
    // Doc may not have the field yet; set it.
    await db.collection('users').doc(userId).set({ fcm_tokens: [token] }, { merge: true });
  });
}

export async function removeToken(db: Firestore, userId: string, token: string): Promise<void> {
  await db.collection('users').doc(userId).update({
    fcm_tokens: FieldValue.arrayRemove(token),
  }).catch(() => {});
}

/** Send a push to all of a user's devices. Returns true if at least one delivered. */
async function sendPushToTokens(
  db: Firestore,
  userId: string,
  tokens: string[],
  payload: { title: string; body: string; url?: string },
): Promise<boolean> {
  if (tokens.length === 0) return false;
  try {
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      // Data-only message so the service worker controls display (icons, click URL).
      data: {
        title: payload.title,
        body: payload.body,
        url: payload.url || '/',
      },
      webpush: {
        fcmOptions: { link: payload.url || '/' },
      },
    });

    // Prune tokens that are no longer valid.
    const stale: string[] = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          stale.push(tokens[i]);
        }
      }
    });
    if (stale.length) {
      await db.collection('users').doc(userId).update({ fcm_tokens: FieldValue.arrayRemove(...stale) }).catch(() => {});
    }

    return res.successCount > 0;
  } catch {
    return false;
  }
}

/** Send a push to a user by id. */
export async function sendPushToUser(db: Firestore, userId: string, payload: { title: string; body: string; url?: string }): Promise<boolean> {
  const doc = await db.collection('users').doc(userId).get();
  const tokens: string[] = doc.data()?.fcm_tokens || [];
  return sendPushToTokens(db, userId, tokens, payload);
}

/**
 * Notify a person by phone, preferring free push over paid SMS.
 * Looks up the user by phone; if they have push tokens, sends push (no SMS).
 * Otherwise falls back to SMS. Returns the channel used.
 */
export async function notifyByPhone(
  db: Firestore,
  env: Env,
  phone: string,
  payload: { title: string; body: string; url?: string; sms?: string },
): Promise<'push' | 'sms' | 'none'> {
  const snap = await db.collection('users').where('phone', '==', phone).limit(1).get();
  if (!snap.empty) {
    const userId = snap.docs[0].id;
    const tokens: string[] = snap.docs[0].data()?.fcm_tokens || [];
    if (tokens.length > 0) {
      const ok = await sendPushToTokens(db, userId, tokens, payload);
      if (ok) return 'push';
    }
  }
  try {
    await sendSms({ env, to: phone, body: payload.sms || payload.body });
    return 'sms';
  } catch {
    return 'none';
  }
}
