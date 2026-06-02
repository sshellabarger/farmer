import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { sendSms } from './sms.js';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a 6-digit OTP, store it in Firestore (keyed by phone), and send it
 * via the configured SMS provider. Firestore is used instead of in-memory state
 * because Cloud Functions instances are ephemeral and don't share memory.
 */
export async function sendOtp(db: Firestore, env: Env, phone: string): Promise<void> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.collection('otps').doc(phone).set({
    code,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  const body = `Your FarmLink verification code is ${code}. It expires in 5 minutes.`;
  await sendSms({ env, to: phone, body });
}

/**
 * Verify an OTP for a phone number. Consumes the code on success.
 * In development mode, any 6-digit code is accepted.
 */
export async function verifyOtp(
  db: Firestore,
  phone: string,
  code: string,
  isDev: boolean,
): Promise<boolean> {
  const ref = db.collection('otps').doc(phone);
  const doc = await ref.get();

  if (isDev) {
    if (doc.exists) await ref.delete();
    return true;
  }

  if (!doc.exists) return false;

  const data = doc.data()!;
  const expiresAt = data.expires_at?.toDate?.() || new Date(data.expires_at);

  if (data.code !== code || expiresAt < new Date()) {
    return false;
  }

  await ref.delete();
  return true;
}
