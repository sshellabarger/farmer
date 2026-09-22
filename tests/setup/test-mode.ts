import { beforeEach } from 'vitest';
process.env.NODE_ENV = 'test';
process.env.SMS_PROVIDER = 'console';
process.env.EMAIL_PROVIDER = 'console';
process.env.ALLOW_REAL_SENDS = 'false';
process.env.JWT_SECRET ??= 'test-secret';
process.env.ANTHROPIC_API_KEY ??= 'test';
function assertTestMode() {
  if (process.env.SMS_PROVIDER !== 'console' || process.env.EMAIL_PROVIDER !== 'console' || process.env.ALLOW_REAL_SENDS !== 'false' || process.env.NODE_ENV === 'production')
    throw new Error(`Refusing to run tests outside console test mode: SMS_PROVIDER=${process.env.SMS_PROVIDER} EMAIL_PROVIDER=${process.env.EMAIL_PROVIDER} ALLOW_REAL_SENDS=${process.env.ALLOW_REAL_SENDS} NODE_ENV=${process.env.NODE_ENV}`);
}
assertTestMode();
beforeEach(assertTestMode);
