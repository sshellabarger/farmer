import type { Env } from '../config/env.js';

const VOIPMS_API_BASE = 'https://voip.ms/api/v1/rest.php';

/**
 * Send ONE SMS segment via the voip.ms REST API.
 *
 * voip.ms uses GET requests with query-string parameters and phone numbers
 * must be 10-digit NANPA (no +1 prefix). Segment splitting happens in
 * services/sms.ts so every caller gets it; this function sends `body` as-is
 * and voip.ms will reject it (sms_toolong) if it exceeds one segment.
 */
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

  const params = new URLSearchParams({ api_username: username, api_password: password, method: 'sendSMS', did, dst, message: body });
  const response = await fetch(`${VOIPMS_API_BASE}?${params.toString()}`);
  if (!response.ok) throw new Error(`voip.ms API HTTP error (${response.status}): ${response.statusText}`);
  const result = (await response.json()) as { status: string; sms?: string };
  if (result.status !== 'success') throw new Error(`voip.ms sendSMS failed: ${result.status}`);
  return result.sms || 'sent';
}
