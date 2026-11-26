import dotenv from 'dotenv';
// No override: values already in the environment (deploy config, test setup) win
// over a developer's local .env.
dotenv.config();
import { z } from 'zod';

const envSchema = z.object({
  // Firebase project (auto-set in Cloud Functions, needed locally)
  GCLOUD_PROJECT: z.string().optional(),
  FIREBASE_CONFIG: z.string().optional(),

  // Send guard: texts, emails and pushes really go out only when
  // NODE_ENV=production AND this is 'true'. Set it in the deploy-time env file
  // only, never in .env. See src/config/send-guard.ts.
  ALLOW_REAL_SENDS: z.enum(['true', 'false']).default('false'),

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

  // Square: the system of record for catalog, stock, orders, buyers and farms.
  // Blank token = Square off (the v1 Firestore inventory path is used).
  // 'production' is honoured only when NODE_ENV=production, so development can
  // never write to the live seller account. See src/services/square.ts.
  SQUARE_ACCESS_TOKEN: z.string().default(''),
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  // The wholesale Location: wholesale stock, orders, invoices and payouts live
  // here. It must be its own Square location, separate from the Little Farm
  // Stop register, so wholesale sales report on their own (LFPP). It is not
  // created by FarmLink: set it up in the Square Dashboard, then put its id here.
  SQUARE_LOCATION_ID: z.string().default(''),
  // Catalog category new farm items are filed under (optional).
  SQUARE_CATEGORY_ID: z.string().default(''),

  // Square webhooks. Both must be set or the webhook route rejects everything.
  // The URL must be exactly the notification URL registered in the Square
  // Developer Dashboard: it is part of what Square signs.
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().default(''),
  SQUARE_WEBHOOK_URL: z.string().default(''),

  // Net payment terms for buyer invoices: due this many days after pickup.
  INVOICE_NET_DAYS: z.coerce.number().int().min(0).max(90).default(15),

  // Wholesale buyers are tax exempt (resale certificate checked in FarmLink).
  // Square has no tax-exempt flag for customers, so FarmLink sends their orders
  // with no taxes and, as a backstop, blocks these Square tax ids on every line.
  // Set it to the seller's catalog tax ids (comma separated).
  SQUARE_EXEMPT_BLOCK_TAX_IDS: z.string().default(''),
  // Square tax ids to charge on buyer-paid fees (delivery, service). Leave
  // blank: SJCA's fees are not taxed (nonprofit, per SJCA Nov 2026). Kept only
  // in case that ever changes.
  SQUARE_FEE_TAX_IDS: z.string().default(''),

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
