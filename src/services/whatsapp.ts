import crypto from 'node:crypto';
import type { Env } from '../config/env.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Send a text message via Meta WhatsApp Cloud API.
 */
export async function sendWhatsApp({
  env,
  to,
  body,
}: {
  env: Env;
  to: string;
  body: string;
}): Promise<string> {
  // Meta expects phone numbers without '+' prefix
  const recipient = to.replace(/^\+/, '');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: {
      preview_url: false,
      body,
    },
  };

  const response = await fetch(
    `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${error}`);
  }

  const result = (await response.json()) as {
    messages: Array<{ id: string }>;
  };
  return result.messages[0].id;
}

/**
 * Send a pre-approved template message (required outside the 24-hour window).
 */
export async function sendWhatsAppTemplate({
  env,
  to,
  templateName,
  languageCode = 'en_US',
  parameters = [],
}: {
  env: Env;
  to: string;
  templateName: string;
  languageCode?: string;
  parameters?: Array<{ type: 'text'; text: string }>;
}): Promise<string> {
  const recipient = to.replace(/^\+/, '');

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components:
        parameters.length > 0
          ? [{ type: 'body', parameters }]
          : [],
    },
  };

  const response = await fetch(
    `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp template send failed (${response.status}): ${error}`);
  }

  const result = (await response.json()) as {
    messages: Array<{ id: string }>;
  };
  return result.messages[0].id;
}

/**
 * Verify the X-Hub-Signature-256 header on inbound webhooks.
 * Returns true if the signature is valid.
 */
export function verifyWebhookSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}
