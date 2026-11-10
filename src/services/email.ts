import { Resend } from 'resend';
import type { Env } from '../config/env.js';
import { SendsDisabledError } from './sms.js';
import { escapeHtml } from '../utils/html.js';

/**
 * Outbound email. Mirrors the SMS guard (SPEC §7.3): Resend is reachable
 * only when NODE_ENV=production AND ALLOW_REAL_SENDS=true; the console
 * provider prints the message and resolves. The `resend` package is imported
 * here and nowhere else (test-enforced). No `messages` row for email in
 * Phase 2.
 */

export type EmailProvider = 'resend' | 'console';

/** Structural guard. Throws SendsDisabledError before any I/O. */
export function selectEmailProvider(env: Env): EmailProvider {
  if (env.EMAIL_PROVIDER === 'console') return 'console';
  if (env.NODE_ENV === 'production' && env.ALLOW_REAL_SENDS === 'true') return 'resend';
  throw new SendsDisabledError(
    `EMAIL_PROVIDER=${env.EMAIL_PROVIDER} needs NODE_ENV=production and ALLOW_REAL_SENDS=true (got NODE_ENV=${env.NODE_ENV}, ALLOW_REAL_SENDS=${env.ALLOW_REAL_SENDS})`,
  );
}

function getResend(env: Env) {
  return new Resend(env.RESEND_API_KEY);
}

export async function resendSend(resend: Resend, payload: Parameters<Resend['emails']['send']>[0]): Promise<void> {
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend error: ${error.message}`);
}

/** The name every email carries in its header and footer (Phase 4 fix X6: producers receive these now). */
export const EMAIL_BRAND = 'SJCA Markets';
export const EMAIL_ORGANISATION = 'St. Joseph Center of Arkansas';

/**
 * The page every email is wrapped in. `title` is plain text (the subject) and
 * is escaped here; `body` is HTML and is inserted as it is, so whoever builds
 * it escapes what it interpolates (`escapeHtml`, src/utils/html.ts).
 */
export function baseLayout(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, sans-serif; color: #1a1a1a; margin: 0; padding: 0; background: #f5f5f0; }
  .wrapper { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; }
  .header { background: #2d5a27; padding: 24px 32px; color: #fff; }
  .header h1 { margin: 0; font-size: 22px; } .header p { margin: 4px 0 0; font-size: 13px; opacity: 0.75; }
  .body { padding: 28px 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 8px 10px; background: #f5f5f0; font-size: 12px; text-transform: uppercase; }
  td { padding: 10px; border-bottom: 1px solid #f0f0eb; }
  .footer { padding: 16px 32px; background: #f5f5f0; font-size: 12px; color: #999; text-align: center; }
  </style></head><body><div class="wrapper"><div class="header"><h1>${EMAIL_BRAND}</h1><p>${escapeHtml(title)}</p></div><div class="body">${body}</div><div class="footer">${EMAIL_ORGANISATION} - ${EMAIL_BRAND}</div></div></body></html>`;
}

/**
 * Send a simple HTML email. `message` IS HTML (newlines become <br>): it is
 * inserted into the page unescaped, so the caller escapes every value it did
 * not write itself with `escapeHtml` (the error alerts and the deadline
 * summary build their own markup; the producer-facing bodies in invites.ts
 * escape each interpolated value). `subject` is plain text.
 * Throws SendsDisabledError when the real provider is configured outside
 * production + ALLOW_REAL_SENDS; the console provider logs and resolves.
 */
export async function sendEmail({ env, to, subject, message }: { env: Env; to: string; subject: string; message: string }) {
  const provider = selectEmailProvider(env);
  if (provider === 'console') {
    console.log('[email:console] to=%s subject=%s\n%s', to, subject, message);
    return;
  }
  const body = `<p style="font-size:15px;line-height:1.6">${message.replace(/\n/g, '<br>')}</p>`;
  await resendSend(getResend(env), { from: env.FROM_EMAIL, to, subject, html: baseLayout(subject, body) });
}
