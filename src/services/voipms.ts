import type { Env } from '../config/env.js';

const VOIPMS_API_BASE = 'https://voip.ms/api/v1/rest.php';

/**
 * Send an SMS via voip.ms REST API.
 *
 * voip.ms uses GET requests with query-string parameters.
 * Phone numbers must be 10-digit NANPA (no +1 prefix).
 */
const SMS_MAX_LENGTH = 155;

function splitMessage(body: string): string[] {
  if (body.length <= SMS_MAX_LENGTH) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > 0) {
    if (remaining.length <= SMS_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', SMS_MAX_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(' ', SMS_MAX_LENGTH);
    if (cutAt <= 0) cutAt = SMS_MAX_LENGTH;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

async function sendSegment({
  username,
  password,
  did,
  dst,
  message,
}: {
  username: string;
  password: string;
  did: string;
  dst: string;
  message: string;
}): Promise<string> {
  const params = new URLSearchParams({ api_username: username, api_password: password, method: 'sendSMS', did, dst, message });
  const response = await fetch(`${VOIPMS_API_BASE}?${params.toString()}`);
  if (!response.ok) throw new Error(`voip.ms API HTTP error (${response.status}): ${response.statusText}`);
  const result = (await response.json()) as { status: string; sms?: string };
  if (result.status !== 'success') throw new Error(`voip.ms sendSMS failed: ${result.status}`);
  return result.sms || 'sent';
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
  const dst = to.replace(/^\+1/, '');
  const did = (env.VOIPMS_DID || '').replace(/^\+1/, '');
  const username = env.VOIPMS_USERNAME || '';
  const password = env.VOIPMS_PASSWORD || '';

  const chunks = splitMessage(body);
  let lastId = 'sent';
  for (const chunk of chunks) {
    lastId = await sendSegment({ username, password, did, dst, message: chunk });
  }
  return lastId;
}
