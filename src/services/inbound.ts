import type { Firestore } from 'firebase-admin/firestore';
import type { FastifyBaseLogger } from 'fastify';
import { v4 as uuid } from 'uuid';
import type { Env } from '../config/env.js';
import { trySendSms, type SmsKind } from './sms.js';

/**
 * Phase 1 STOPGAP inbound handler (SPEC §7.4, minimal).
 *
 * The v1 AI ordering assistant is retired. Until the SJCA check-in flow ships
 * (Phase 3) this handler only (1) logs every inbound text to `messages`,
 * (2) honours STOP/START/HELP so the published privacy/terms promises are
 * true, and (3) answers anything else with a one-line "the service has
 * changed" note at most once per 24 hours per phone — never a loop.
 *
 * Every outbound reply goes through `trySendSms`, which logs it to
 * `messages` and never throws: voip.ms retries non-200 webhook responses,
 * which would reprocess the inbound text.
 */

export const STOP_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
export const START_KEYWORDS = new Set(['START', 'UNSTOP']);
export const HELP_KEYWORDS = new Set(['HELP']);

export const REPLIES = {
  unsubscribed: "You're unsubscribed from FarmLink texts. Reply START to resubscribe.",
  resubscribed: "You're resubscribed to FarmLink texts.",
  help: 'FarmLink is becoming the St. Joseph Center of Arkansas farmers market manager. Reply STOP to unsubscribe.',
  closed: "Thanks. FarmLink's ordering service has closed and is becoming the SJCA farmers market manager. A team member will follow up.",
} as const;

export type OutboundKind = Extract<SmsKind, 'opt_out_confirm' | 'opt_in_confirm' | 'help' | 'auto_reply'>;

// Only one "service has changed" auto-reply per phone per window.
const AUTO_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value as { toDate?: () => Date };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True if an outbound text went out to this phone within the window. A
 * `simulated` row (console provider) counts the same as `sent`: the reply
 * "happened" as far as the one-per-24 h rule is concerned.
 */
async function repliedRecently(db: Firestore, phone: string, now: Date): Promise<boolean> {
  // One equality filter at the DB, the rest in memory (repo convention; no
  // composite index needed).
  const snap = await db.collection('messages').where('to', '==', phone).get();
  const cutoff = now.getTime() - AUTO_REPLY_WINDOW_MS;
  return snap.docs.some((d) => {
    const m = d.data();
    if (m.direction !== 'outbound') return false;
    if (m.status !== 'sent' && m.status !== 'simulated') return false;
    const at = toDate(m.created_at);
    return !!at && at.getTime() >= cutoff;
  });
}

export async function handleInboundText({
  db,
  env,
  log,
  from,
  body,
  providerMessageId,
}: {
  db: Firestore;
  env: Env;
  log: FastifyBaseLogger;
  from: string;
  body: string;
  providerMessageId: string;
}): Promise<void> {
  const now = new Date();

  // (a) Log the inbound text. This is the only record of it.
  await db.collection('messages').doc(uuid()).set({
    direction: 'inbound',
    from,
    to: env.VOIPMS_DID ?? '',
    body,
    provider: 'voipms',
    provider_message_id: providerMessageId,
    status: 'received',
    status_at: now,
    error: null,
    kind: 'inbound',
    segments: 1,
    created_at: now,
  });

  const keyword = body.trim().toUpperCase();
  const userSnap = await db.collection('users').where('phone', '==', from).limit(1).get();
  const userRef = userSnap.empty ? null : userSnap.docs[0].ref;
  const userData = userSnap.empty ? null : userSnap.docs[0].data();
  const userId = userSnap.empty ? null : userSnap.docs[0].id;

  const reply = async (text: string, kind: OutboundKind) => {
    const result = await trySendSms({ db, env, to: from, body: text, kind, user_id: userId });
    if (!result.ok) log.warn({ to: from, kind, error: result.error }, 'Inbound auto-reply failed to send');
  };

  // (b) Keywords. STOP/START/HELP always get their confirmation (carrier
  // norms), even when the number is unknown or already opted out.
  if (STOP_KEYWORDS.has(keyword)) {
    if (userRef) await userRef.update({ sms_opt_out_at: now, updated_at: now }).catch((err: unknown) => log.error(err, 'Failed to record opt-out'));
    await reply(REPLIES.unsubscribed, 'opt_out_confirm');
    return;
  }

  if (START_KEYWORDS.has(keyword)) {
    if (userRef) await userRef.update({ sms_opt_out_at: null, updated_at: now }).catch((err: unknown) => log.error(err, 'Failed to clear opt-out'));
    await reply(REPLIES.resubscribed, 'opt_in_confirm');
    return;
  }

  if (HELP_KEYWORDS.has(keyword)) {
    await reply(REPLIES.help, 'help');
    return;
  }

  // Anything else: a single courtesy reply per 24 h, never to an opted-out user.
  if (userData?.sms_opt_out_at) return;
  if (await repliedRecently(db, from, now)) return;
  await reply(REPLIES.closed, 'auto_reply');
}
