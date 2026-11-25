import type { Env } from '../config/env.js';
import { sendSms as telnyxSend } from './telnyx.js';
import { sendSms as voipmsSend } from './voipms.js';
import { sendWhatsApp } from './whatsapp.js';

/**
 * Provider-agnostic message send.
 * Routes to Telnyx SMS, voip.ms, or WhatsApp based on SMS_PROVIDER env var.
 * Default: telnyx
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
  const provider = env.SMS_PROVIDER || 'telnyx';

  switch (provider) {
    case 'voipms':
      return voipmsSend({ env, to, body });
    case 'whatsapp':
      return sendWhatsApp({ env, to, body });
    case 'telnyx':
    default:
      return telnyxSend({ env, to, body });
  }
}
