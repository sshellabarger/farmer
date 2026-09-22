import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import type { Env } from '../config/env.js';
import { sendSms as voipmsSend } from './voipms.js';

/**
 * The one outbound text choke point (SPEC §7.2, §7.3). Every text the app
 * sends goes through `sendSms` so three things apply uniformly:
 *
 *   1. the structural send guard — a real provider is reachable only when
 *      NODE_ENV=production AND ALLOW_REAL_SENDS=true; anything else throws
 *      SendsDisabledError before a single byte is written or sent;
 *   2. the `messages` log — a `queued` row is written BEFORE the provider
 *      call and updated to `sent` / `simulated` / `failed` after it, so no
 *      text can leave unlogged;
 *   3. segment splitting.
 *
 * voip.ms is the only real provider (SPEC §9 D5) and `./voipms.js` is
 * imported here and nowhere else (test-enforced). The console provider
 * prints the text and records it as `simulated`.
 */

export type SmsProvider = 'voipms' | 'console';

export type SmsKind =
  | 'otp'
  | 'invite'
  | 'admin_invite'
  | 'reminder'
  | 'broadcast'
  | 'opt_out_confirm'
  | 'opt_in_confirm'
  | 'help'
  | 'auto_reply'
  | 'alert'
  | 'support'
  | 'checkin'
  | 'booth'
  // Phase 3 (contract §2.6): the check-in workflow and the inbound upgrade.
  | 'checkin_link'
  | 'checkin_reminder'
  | 'deadline_summary'
  | 'forwarded_inbound';

export interface SendSmsArgs {
  env: Env;
  db: Firestore;
  to: string;
  body: string;
  kind: SmsKind;
  producer_id?: string | null;
  market_date_id?: string | null;
  user_id?: string | null;
  sent_by?: string | null;
  /** Extra keys on the `messages` row, e.g. { broadcast_id }, { reminder_id }. */
  extra?: Record<string, unknown>;
}

export interface SendSmsResult {
  message_id: string;
  provider: SmsProvider;
  provider_message_id: string;
  status: 'sent' | 'simulated';
  segments: number;
}

/** Thrown by the structural guard: the configured provider may not send here. */
export class SendsDisabledError extends Error {
  readonly code = 'SENDS_DISABLED';
  constructor(message: string) {
    super(message);
    this.name = 'SendsDisabledError';
  }
}

/** The provider rejected the text. The `messages` row is marked `failed`. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly message_id: string,
    readonly cause_message: string,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}

/** Structural guard. Throws SendsDisabledError before any I/O. */
export function selectSmsProvider(env: Env): SmsProvider {
  if (env.SMS_PROVIDER === 'console') return 'console';
  if (env.NODE_ENV === 'production' && env.ALLOW_REAL_SENDS === 'true') return 'voipms';
  throw new SendsDisabledError(
    `SMS_PROVIDER=${env.SMS_PROVIDER} needs NODE_ENV=production and ALLOW_REAL_SENDS=true (got NODE_ENV=${env.NODE_ENV}, ALLOW_REAL_SENDS=${env.ALLOW_REAL_SENDS})`,
  );
}

// voip.ms rejects (sms_toolong) messages over the per-segment limit. That limit
// depends on encoding: GSM-7 allows 160 chars/segment, but any non-GSM character
// (emoji, curly quotes, accents, etc.) forces UCS-2 where the limit drops to 70.
// We detect the encoding and split accordingly, with a small safety margin.
const GSM_MAX_LENGTH = 153;
const UCS2_MAX_LENGTH = 67;

function hasNonGsmChars(body: string): boolean {
  // Treat any character outside printable ASCII (plus tab/newline/CR) as UCS-2.
  // A precise GSM-7 charset check is overkill; this errs on the safe side.
  for (const ch of body) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c > 0x7e) return true;
  }
  return false;
}

/** Split a message into carrier-safe segments, preferring newline/space breaks. */
export function splitMessage(body: string): string[] {
  const maxLen = hasNonGsmChars(body) ? UCS2_MAX_LENGTH : GSM_MAX_LENGTH;
  // Work in code points so we never split an emoji (surrogate pair) in half.
  const codePoints = Array.from(body);
  if (codePoints.length <= maxLen) return [body];

  const chunks: string[] = [];
  let start = 0;
  while (start < codePoints.length) {
    let end = Math.min(start + maxLen, codePoints.length);
    if (end < codePoints.length) {
      // Prefer to break at a newline or space within the window.
      const window = codePoints.slice(start, end);
      let breakIdx = window.lastIndexOf('\n');
      if (breakIdx <= 0) breakIdx = window.lastIndexOf(' ');
      if (breakIdx > 0) end = start + breakIdx;
    }
    chunks.push(codePoints.slice(start, end).join('').trim());
    start = end;
    // Skip a leading separator we broke on.
    while (start < codePoints.length && (codePoints[start] === ' ' || codePoints[start] === '\n')) start++;
  }
  return chunks.filter((c) => c.length > 0);
}

/**
 * Send a text and log it. Lifecycle:
 *
 *   1. `selectSmsProvider` — throws SendsDisabledError before anything is
 *      written or sent;
 *   2. write the `messages` row as `queued` — a failed write throws, so no
 *      text ever goes out unlogged;
 *   3. send every segment (voip.ms) or print once (console);
 *   4. update the row to `sent` / `simulated`; on failure retry once, then
 *      report to the console and still resolve (the text is out — the
 *      provider id in the log line is the handle left to reconcile by);
 *   5. on a provider throw mark the row `failed` (best-effort) and throw
 *      SmsSendError.
 *
 * Callers that must not fail on a bad send (webhooks, broadcast loops) use
 * `trySendSms`. Sends must honour `sms_opt_out_at`; that check belongs to
 * the caller, which knows who the recipient is.
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const { env, db, to, body, kind } = args;

  // (1) Structural guard, before any I/O.
  const provider = selectSmsProvider(env);

  const chunks = splitMessage(body);
  const now = new Date();
  const message_id = uuid();
  const row = db.collection('messages').doc(message_id);

  // (2) Queued row first. `extra` goes first so a caller can never clobber
  // the core fields with it.
  await row.set({
    ...(args.extra ?? {}),
    direction: 'outbound',
    to,
    from: provider === 'console' ? 'console' : env.VOIPMS_DID ?? '',
    body,
    provider,
    provider_message_id: null,
    status: 'queued',
    status_at: now,
    error: null,
    kind,
    segments: chunks.length,
    producer_id: args.producer_id ?? null,
    market_date_id: args.market_date_id ?? null,
    user_id: args.user_id ?? null,
    sent_by: args.sent_by ?? null,
    created_at: now,
  });

  // (3) Send.
  let provider_message_id: string;
  try {
    if (provider === 'console') {
      console.log('[sms:console] to=%s kind=%s segments=%d\n%s', to, kind, chunks.length, body);
      provider_message_id = `console-${message_id}`;
    } else {
      provider_message_id = 'sent';
      for (const chunk of chunks) {
        provider_message_id = await voipmsSend({ env, to, body: chunk });
      }
    }
  } catch (err) {
    // (5) Provider failure.
    const cause_message = err instanceof Error ? err.message : String(err);
    await row.update({ status: 'failed', error: cause_message, status_at: new Date() }).catch(() => {});
    throw new SmsSendError(`SMS send failed (provider=${provider}, kind=${kind}): ${cause_message}`, message_id, cause_message);
  }

  // (4) Mark the row. Retry once, then report — never throw: the text is out.
  const status: SendSmsResult['status'] = provider === 'console' ? 'simulated' : 'sent';
  const update = { status, provider_message_id, status_at: new Date() };
  try {
    await row.update(update);
  } catch {
    try {
      await row.update(update);
    } catch (err) {
      console.error(
        `Sent SMS not marked ${status}: messages/${message_id} update failed twice (provider_message_id=${provider_message_id}, kind=${kind})`,
        err,
      );
    }
  }

  return { message_id, provider, provider_message_id, status, segments: chunks.length };
}

/**
 * `sendSms` that never throws — every failure (SendsDisabledError included)
 * becomes `{ ok: false }` so a webhook or a broadcast loop can carry on.
 */
export async function trySendSms(
  args: SendSmsArgs,
): Promise<({ ok: true } & SendSmsResult) | { ok: false; message_id: string | null; error: string }> {
  try {
    const result = await sendSms(args);
    return { ok: true, ...result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const message_id = err instanceof SmsSendError ? err.message_id : null;
    return { ok: false, message_id, error };
  }
}
