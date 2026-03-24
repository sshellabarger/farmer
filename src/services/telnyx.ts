import type { Env } from '../config/env.js';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

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
