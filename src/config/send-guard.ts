import type { Env } from './env.js';

/**
 * The structural send guard (handoff 05 #1).
 *
 * Nothing leaves the app (text, WhatsApp, email, push) unless BOTH hold:
 *   NODE_ENV=production  and  ALLOW_REAL_SENDS=true
 * ALLOW_REAL_SENDS belongs only in a deploy-time env file, never in `.env`.
 * Everywhere else a send is printed to the console and reported as simulated.
 *
 * Every provider function calls `simulateSend` first, so the guard holds even
 * for code that bypasses the `sendSms` choke point.
 */
export function realSendsAllowed(env: Pick<Env, 'NODE_ENV' | 'ALLOW_REAL_SENDS'>): boolean {
  return env.NODE_ENV === 'production' && env.ALLOW_REAL_SENDS === 'true';
}

/** For the few callers with no Env in reach. Unknown values count as "off". */
export function guardEnvFromProcess(): Pick<Env, 'NODE_ENV' | 'ALLOW_REAL_SENDS'> {
  return {
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    ALLOW_REAL_SENDS: process.env.ALLOW_REAL_SENDS === 'true' ? 'true' : 'false',
  };
}

/** Keep the last 2 characters so logs never hold a full phone or address. */
function mask(to: string): string {
  return to.length <= 2 ? '**' : `${'*'.repeat(to.length - 2)}${to.slice(-2)}`;
}

/**
 * Returns a simulated message id when real sends are off (the caller must
 * return it without contacting the provider), or null when the send may go out.
 */
export function simulateSend(
  env: Pick<Env, 'NODE_ENV' | 'ALLOW_REAL_SENDS'>,
  channel: 'sms' | 'whatsapp' | 'email' | 'push',
  to: string,
  summary: string,
): string | null {
  if (realSendsAllowed(env)) return null;
  console.log(`[send-guard] ${channel} NOT sent (simulated) to ${mask(to)}: ${summary}`);
  return `simulated-${channel}-${Date.now()}`;
}
