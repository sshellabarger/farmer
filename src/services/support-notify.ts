import type { Env } from '../config/env.js';
import { sendSms } from './sms.js';
import { sendEmail } from './email.js';

/**
 * Notify the support contacts (ALERT_PHONE / ALERT_EMAIL from .env) about new
 * user feedback. Fire-and-forget; failures are swallowed so they never block
 * the user's submission.
 */
export async function notifySupportFeedback(
  env: Env,
  opts: { type: string; title: string; description: string; submittedBy: string; source: string },
): Promise<void> {
  const label = opts.type === 'feature_request' ? 'Feature Request' : 'Bug Report';

  if (env.ALERT_PHONE) {
    const body = `📋 New ${label} from ${opts.submittedBy} (${opts.source}):\n"${opts.title}"`;
    sendSms({ env, to: env.ALERT_PHONE, body }).catch((e) =>
      console.warn('[support-notify] SMS failed:', e instanceof Error ? e.message : e),
    );
  }

  if (env.ALERT_EMAIL) {
    const message =
      `<b>${label}</b> from ${opts.submittedBy} (via ${opts.source})<br><br>` +
      `<b>${opts.title}</b><br><br>${opts.description.replace(/\n/g, '<br>')}`;
    sendEmail({
      env,
      to: env.ALERT_EMAIL,
      subject: `[FarmLink Feedback] ${label}: ${opts.title}`,
      message,
    }).catch((e) => console.warn('[support-notify] email failed:', e instanceof Error ? e.message : e));
  }
}
