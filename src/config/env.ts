import dotenv from 'dotenv';
dotenv.config({ override: true });
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SMS_PROVIDER: z.enum(['telnyx', 'voipms', 'whatsapp']).default('telnyx'),
  // Telnyx (required when SMS_PROVIDER=telnyx or whatsapp)
  TELNYX_API_KEY: z.string().default(''),
  TELNYX_PHONE_NUMBER: z.string().default(''),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  // WhatsApp Cloud API (Meta direct)
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // voip.ms (required when SMS_PROVIDER=voipms)
  VOIPMS_USERNAME: z.string().optional(),
  VOIPMS_PASSWORD: z.string().optional(),
  VOIPMS_DID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}
