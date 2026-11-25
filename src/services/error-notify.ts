import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { sendEmail } from './email.js';
import { sendSms } from './sms.js';
import { classifyError, getFixHint, getFixHintText, type ClassifiedError } from '../utils/errors.js';
import type { Env } from '../config/env.js';
import { getDb } from '../db/firestore.js';

// Suppress duplicate alerts for the same error signature within this window,
// so a recurring failure can't flood your phone/inbox or run up SMS costs.
const THROTTLE_MINUTES = 30;

interface NotifyContext {
  source?: string; // e.g. 'sms-inbound', 'api-route', 'scheduler'
  userPhone?: string;
  userMessage?: string;
  route?: string;
  method?: string;
}

function signatureFor(classified: ClassifiedError): string {
  // Group by category + the first line of the message (strip volatile bits like ids/timestamps).
  const head = classified.message.split('\n')[0].replace(/[0-9a-f]{8,}/gi, '#').slice(0, 120);
  return crypto.createHash('sha1').update(`${classified.category}|${head}`).digest('hex');
}

/**
 * Returns true if we should send an alert now (and records the send).
 * Returns false (and increments a suppressed counter) if we're within the
 * throttle window for this error signature.
 */
async function shouldAlert(signature: string): Promise<{ send: boolean; suppressedSince?: number }> {
  try {
    const ref = getDb().collection('error_alerts').doc(signature);
    const now = Date.now();
    return await getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (doc.exists) {
        const data = doc.data()!;
        const lastSent = data.last_sent_at?.toDate?.()?.getTime() ?? 0;
        if (now - lastSent < THROTTLE_MINUTES * 60 * 1000) {
          tx.update(ref, { suppressed: (data.suppressed ?? 0) + 1, last_seen_at: new Date() });
          return { send: false };
        }
        const suppressedSince = data.suppressed ?? 0;
        tx.set(ref, { last_sent_at: new Date(), last_seen_at: new Date(), suppressed: 0 });
        return { send: true, suppressedSince };
      }
      tx.set(ref, { last_sent_at: new Date(), last_seen_at: new Date(), suppressed: 0 });
      return { send: true };
    });
  } catch {
    // If the dedup store fails, fail open (better to alert than to swallow).
    return { send: true };
  }
}

function errorEmailHtml(
  classified: ClassifiedError,
  ctx: NotifyContext,
  timestamp: string,
  aiAnalysis: string | undefined,
  suppressedSince: number | undefined,
): string {
  const stack = classified.raw instanceof Error ? classified.raw.stack || '' : '';
  const fixHint = getFixHint(classified.category);
  const rows = [
    ['Time', timestamp],
    ['Category', `<strong>${classified.category}</strong>`],
    ['Source', ctx.source || '—'],
    ...(ctx.route ? [['Route', `${ctx.method || ''} ${ctx.route}`]] : []),
    ...(ctx.userPhone ? [['User Phone', ctx.userPhone]] : []),
    ...(ctx.userMessage ? [['User Message', `"${ctx.userMessage}"`]] : []),
  ].map(([k, v]) => `<tr><td style="color:#666;width:140px;padding:4px 0">${k}</td><td>${v}</td></tr>`).join('');

  return `
    <div style="font-family:monospace;font-size:13px">
    ${suppressedSince ? `<div style="background:#fef9c3;padding:8px 12px;border-radius:4px;margin-bottom:12px">⏳ ${suppressedSince} similar error(s) were suppressed since the last alert (throttled to 1 per ${THROTTLE_MINUTES} min).</div>` : ''}
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${rows}</table>
    <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:12px 16px;border-radius:4px;margin-bottom:16px">
      <strong>Error:</strong> ${classified.message}
    </div>
    ${aiAnalysis ? `<div style="background:#dbeafe;border-left:4px solid #2563eb;padding:12px 16px;border-radius:4px;margin-bottom:16px"><strong>AI Analysis &amp; Suggested Fix:</strong><br><br>${aiAnalysis.replace(/\n/g, '<br>')}</div>` : ''}
    <div style="background:#dcfce7;border-left:4px solid #16a34a;padding:12px 16px;border-radius:4px;margin-bottom:16px">${fixHint}</div>
    ${stack ? `<details><summary style="cursor:pointer;color:#666;margin-bottom:8px">Stack trace</summary><pre style="background:#f5f5f0;padding:12px;border-radius:4px;overflow-x:auto;font-size:11px">${stack}</pre></details>` : ''}
    </div>`;
}

async function researchFix(env: Env, classified: ClassifiedError, ctx: NotifyContext): Promise<string | undefined> {
  // Don't call Anthropic if the error IS an Anthropic problem (it would also fail).
  if (classified.isAnthropicError || !env.ANTHROPIC_API_KEY) return undefined;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const detail = classified.raw instanceof Error
      ? `${classified.raw.message}\n\n${classified.raw.stack || ''}`
      : String(classified.raw);
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a support engineer for FarmLink, a farm-to-market SMS platform on Firebase (Cloud Functions v2, Firestore, Fastify) using voip.ms for SMS, Resend for email, and the Anthropic API.

An error occurred${ctx.source ? ` in: ${ctx.source}` : ''}${ctx.userMessage ? `\nUser SMS: "${ctx.userMessage}"` : ''}
Error category: ${classified.category}
Error: ${detail}

In 2-4 sentences, explain the most likely cause and the specific first step to fix it. Be concrete and technical.`,
      }],
    });
    return response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch {
    return undefined;
  }
}

export async function notifyError({
  env,
  err,
  source,
  context,
  // Back-compat with the original call shape:
  userPhone,
  userMessage,
}: {
  env: Env;
  err: unknown;
  source?: string;
  context?: NotifyContext;
  userPhone?: string;
  userMessage?: string;
}): Promise<void> {
  const ctx: NotifyContext = { source, userPhone, userMessage, ...(context || {}) };
  const classified = classifyError(err);
  const signature = signatureFor(classified);

  const { send, suppressedSince } = await shouldAlert(signature);
  if (!send) return; // throttled

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'medium' });
  const aiAnalysis = await researchFix(env, classified, ctx);

  // ── Email (detailed) ──
  if (env.ALERT_EMAIL) {
    try {
      await sendEmail({
        env,
        to: env.ALERT_EMAIL,
        subject: `[FarmLink Error] ${classified.category.replace(/_/g, ' ').toUpperCase()} — ${timestamp}`,
        message: errorEmailHtml(classified, ctx, timestamp, aiAnalysis, suppressedSince),
      });
    } catch (e) {
      console.error('[error-notify] email failed:', e instanceof Error ? e.message : e);
    }
  }

  // ── SMS (concise + suggested fix) ──
  if (env.ALERT_PHONE) {
    try {
      const shortMsg = classified.message.split('\n')[0].slice(0, 100);
      const fix = (aiAnalysis?.split('\n')[0] || getFixHintText(classified.category)).slice(0, 220);
      const body = `⚠️ FarmLink ${classified.category}\n${shortMsg}\n\nFix: ${fix}`;
      await sendSms({ env, to: env.ALERT_PHONE, body });
    } catch (e) {
      console.error('[error-notify] sms failed:', e instanceof Error ? e.message : e);
    }
  }

  // Always log to Cloud Logging too.
  console.error(`[FarmLink error] category=${classified.category} source=${ctx.source || '?'} :: ${classified.message}`);
}
