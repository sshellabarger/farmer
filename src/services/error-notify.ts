import Anthropic from '@anthropic-ai/sdk';
import { sendEmail } from './email.js';
import { classifyError, getFixHint, type ClassifiedError } from '../utils/errors.js';
import type { Env } from '../config/env.js';

const SUPPORT_EMAIL = 'scott@thoughtafter.com';

function errorEmailHtml(
  classified: ClassifiedError,
  context: { userPhone: string; userMessage: string; timestamp: string },
  aiAnalysis?: string,
): string {
  const stack = classified.raw instanceof Error ? classified.raw.stack || '' : '';
  const fixHint = getFixHint(classified.category);

  return `
    <div style="font-family:monospace;font-size:13px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="color:#666;width:140px;padding:4px 0">Time</td><td>${context.timestamp}</td></tr>
      <tr><td style="color:#666;padding:4px 0">Category</td><td><strong>${classified.category}</strong></td></tr>
      <tr><td style="color:#666;padding:4px 0">User Phone</td><td>${context.userPhone}</td></tr>
      <tr><td style="color:#666;padding:4px 0">User Message</td><td>"${context.userMessage}"</td></tr>
    </table>

    <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:12px 16px;border-radius:4px;margin-bottom:16px">
      <strong>Error:</strong> ${classified.message}
    </div>

    ${aiAnalysis ? `
    <div style="background:#dbeafe;border-left:4px solid #2563eb;padding:12px 16px;border-radius:4px;margin-bottom:16px">
      <strong>AI Analysis:</strong><br><br>${aiAnalysis.replace(/\n/g, '<br>')}
    </div>` : ''}

    <div style="background:#dcfce7;border-left:4px solid #16a34a;padding:12px 16px;border-radius:4px;margin-bottom:16px">
      ${fixHint}
    </div>

    ${stack ? `
    <details>
      <summary style="cursor:pointer;color:#666;margin-bottom:8px">Stack trace</summary>
      <pre style="background:#f5f5f0;padding:12px;border-radius:4px;overflow-x:auto;font-size:11px">${stack}</pre>
    </details>` : ''}
    </div>
  `;
}

export async function notifyError({
  env,
  err,
  userPhone,
  userMessage,
}: {
  env: Env;
  err: unknown;
  userPhone: string;
  userMessage: string;
}): Promise<void> {
  const classified = classifyError(err);
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'medium' });
  const categoryLabel = classified.category.replace(/_/g, ' ').toUpperCase();

  let aiAnalysis: string | undefined;

  if (!classified.isAnthropicError && env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const errorDetail = classified.raw instanceof Error
        ? `${classified.raw.message}\n\n${classified.raw.stack || ''}`
        : String(classified.raw);

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are a support assistant for FarmLink, a farm-to-market SMS platform built with Node.js, Fastify, Kysely/PostgreSQL, BullMQ/Redis, and Twilio/voip.ms for SMS.

An error occurred while processing an inbound SMS from a user.

User message: "${userMessage}"
Error category: ${classified.category}
Error: ${errorDetail}

In 2-4 sentences, explain what likely caused this error and what a developer should check first to fix it. Be specific and technical.`,
        }],
      });

      aiAnalysis = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    } catch {
      // AI analysis failed — send email without it
    }
  }

  const html = errorEmailHtml(classified, { userPhone, userMessage, timestamp }, aiAnalysis);

  try {
    await sendEmail({
      env,
      to: SUPPORT_EMAIL,
      subject: `[FarmLink Error] ${categoryLabel} — ${timestamp}`,
      message: html,
    });
  } catch (emailErr) {
    // Last-resort: log to console if even email fails
    console.error('[FarmLink] Failed to send error notification email:', emailErr);
    console.error('[FarmLink] Original error:', classified.message);
  }
}
