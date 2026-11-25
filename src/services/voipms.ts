import type { Env } from '../config/env.js';

const VOIPMS_API_BASE = 'https://voip.ms/api/v1/rest.php';

/**
 * Send an SMS via voip.ms REST API.
 *
 * voip.ms uses GET requests with query-string parameters.
 * Phone numbers must be 10-digit NANPA (no +1 prefix).
 */

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

function splitMessage(body: string): string[] {
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
