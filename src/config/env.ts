import dotenv from 'dotenv';
dotenv.config({ override: true });
import { z } from 'zod';

const envSchema = z.object({
  // Firebase project (auto-set in Cloud Functions, needed locally)
  GCLOUD_PROJECT: z.string().optional(),
  FIREBASE_CONFIG: z.string().optional(),

  // SMS Provider: telnyx | voipms | whatsapp
  SMS_PROVIDER: z.enum(['telnyx', 'voipms', 'whatsapp']).default('telnyx'),
  // Telnyx
  TELNYX_API_KEY: z.string().default(''),
  TELNYX_PHONE_NUMBER: z.string().default(''),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  // Base64 ed25519 public key from the Telnyx portal, used to verify inbound
  // webhook signatures. When blank, the webhook rejects all traffic in
  // production (Telnyx always signs, so unsigned means spoofed) but accepts
  // in development for local testing.
  TELNYX_PUBLIC_KEY: z.string().default(''),
  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
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

  // Email (Resend)
  RESEND_API_KEY: z.string().default(''),
  FROM_EMAIL: z.string().default('farmlink@farmlink.us'),

  // App URL (used for web links sent via SMS)
  APP_URL: z.string().default('http://localhost:3001'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // App (LOCAL_PORT for dev; Cloud Functions sets PORT itself)
  LOCAL_PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(1),

  // Cloud Tasks (for delayed notifications)
  CLOUD_TASKS_QUEUE: z.string().default('notifications'),
  CLOUD_TASKS_LOCATION: z.string().default('us-central1'),
  CLOUD_FUNCTIONS_URL: z.string().optional(),

  // Error alerts — where to text/email errors (with AI-researched fix).
  // Leave blank to disable that channel. Alerts are throttled per error signature.
  ALERT_EMAIL: z.string().default(''),
  ALERT_PHONE: z.string().default(''),

  // Firebase Storage bucket for image uploads (profile logos, produce photos).
  STORAGE_BUCKET: z.string().default('arkansaslocalfoodnetwork.firebasestorage.app'),

  // Local Food Marketplace (ALFN) availability sync.
  // Leave LFM_API_BASE / LFM_API_KEY blank to run the sync in dry-run mode
  // (it returns what *would* be pushed without calling out). LFM's documented
  // key-based API is reporting-oriented; a write/availability endpoint likely
  // requires approved-partner access — confirm with info@localfoodmarketplace.com.
  LFM_API_BASE: z.string().default(''),
  LFM_API_KEY: z.string().default(''),
  LFM_MARKET_ID: z.string().default(''),
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
