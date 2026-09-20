import { Resend } from 'resend';
import type { Env } from '../config/env.js';

function getResend(env: Env) {
  return new Resend(env.RESEND_API_KEY);
}

export async function resendSend(resend: Resend, payload: Parameters<Resend['emails']['send']>[0]): Promise<void> {
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend error: ${error.message}`);
}

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
  </style></head><body><div class="wrapper"><div class="header"><h1>FarmLink</h1><p>${title}</p></div><div class="body">${body}</div><div class="footer">FarmLink</div></div></body></html>`;
}

/** Send a simple HTML email through Resend. `message` may contain HTML; newlines become <br>. */
export async function sendEmail({ env, to, subject, message }: { env: Env; to: string; subject: string; message: string }) {
  const body = `<p style="font-size:15px;line-height:1.6">${message.replace(/\n/g, '<br>')}</p>`;
  await resendSend(getResend(env), { from: env.FROM_EMAIL, to, subject, html: baseLayout(subject, body) });
}
