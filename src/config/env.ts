import dotenv from 'dotenv';
dotenv.config({ override: true });
import { z } from 'zod';

const envSchema = z.object({
  // Firebase project (auto-set in Cloud Functions, needed locally)
  GCLOUD_PROJECT: z.string().optional(),
  FIREBASE_CONFIG: z.string().optional(),

  // SMS provider. voip.ms is the only one (SPEC §9 D5); the enum stays so a
  // console/test provider can be added in Phase 2 without changing callers.
  SMS_PROVIDER: z.enum(['voipms']).default('voipms'),
  // voip.ms
  VOIPMS_USERNAME: z.string().optional(),
  VOIPMS_PASSWORD: z.string().optional(),
  VOIPMS_DID: z.string().optional(),
  // voip.ms SMS callbacks can't be signed, so the callback URL configured in
  // the voip.ms portal must embed this shared secret as ?secret=<value>.
  // IMPORTANT: set the portal URL first, then this var — setting this var
  // while the portal URL lacks ?secret= will reject all inbound texts.
  // Blank disables the check (logged as a warning on every inbound).
  VOIPMS_WEBHOOK_SECRET: z.string().default(''),

  // Email (Resend). FROM_EMAIL has no default any more: blank means email
  // sends fail loudly instead of going out from an org address by accident.
  RESEND_API_KEY: z.string().default(''),
  FROM_EMAIL: z.string().default(''),

  // App URL (used for web links sent via SMS)
  APP_URL: z.string().default('http://localhost:3001'),

  // Anthropic — used only by services/error-notify.ts to diagnose alerts.
  ANTHROPIC_API_KEY: z.string().min(1),

  // App (LOCAL_PORT for dev; Cloud Functions sets PORT itself)
  LOCAL_PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(1),

  // Error alerts — where to text/email errors (with AI-researched fix).
  // Leave blank to disable that channel. Alerts are throttled per error signature.
  ALERT_EMAIL: z.string().default(''),
  ALERT_PHONE: z.string().default(''),

  // Firebase Storage bucket for image uploads (logos, booth photos). No
  // default: blank makes uploads fail rather than target an org bucket.
  STORAGE_BUCKET: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}
