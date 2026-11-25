import crypto from 'node:crypto';
import type { Env } from '../config/env.js';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

// Telnyx signs every webhook with ed25519 over "<timestamp>|<raw body>".
// The portal exposes the public key as base64 of the raw 32-byte key; Node's
// crypto only accepts it wrapped in an SPKI DER envelope, hence the prefix.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify the telnyx-signature-ed25519 / telnyx-timestamp headers on an
 * inbound webhook. Returns false (never throws) on malformed input.
 */
export function verifyTelnyxWebhookSignature({
  publicKey,
  signatureHeader,
  timestampHeader,
  rawBody,
  toleranceSeconds = 300,
}: {
  publicKey: string;
  signatureHeader: string;
  timestampHeader: string;
  rawBody: Buffer;
  toleranceSeconds?: number;
}): boolean {
  try {
    // Reject stale timestamps so a captured webhook can't be replayed later.
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return false;
    if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.concat([Buffer.from(`${timestampHeader}|`), rawBody]);
    return crypto.verify(null, message, key, Buffer.from(signatureHeader, 'base64'));
  } catch {
    return false;
  }
}

export async function sendSms({
  env,
  to,
  body,
}: {
  env: Env;
  to: string;
  body: string;
}): Promise<string> {
  const payload: Record<string, string> = {
    from: env.TELNYX_PHONE_NUMBER,
    to,
    text: body,
  };

  if (env.TELNYX_MESSAGING_PROFILE_ID) {
    payload.messaging_profile_id = env.TELNYX_MESSAGING_PROFILE_ID;
  }

  const response = await fetch(`${TELNYX_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telnyx send failed (${response.status}): ${error}`);
  }

  const result = (await response.json()) as { data: { id: string } };
  return result.data.id;
}
