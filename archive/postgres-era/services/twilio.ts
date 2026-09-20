import Twilio from 'twilio';
import type { Env } from '../config/env.js';

let client: ReturnType<typeof Twilio> | null = null;

function getClient(env: Env) {
  if (!client) {
    client = Twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

export async function sendSms({
  env,
  to,
  body,
}: {
  env: Env;
  to: string;
  body: string;
}) {
  const tw = getClient(env);
  const message = await tw.messages.create({
    to,
    from: env.TWILIO_PHONE_NUMBER,
    body,
  });
  return message.sid;
}
