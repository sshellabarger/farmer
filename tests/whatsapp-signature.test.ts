// Regression: verifyWebhookSignature passed raw strings to
// crypto.timingSafeEqual, which throws RangeError on length mismatch — so any
// request with a malformed x-hub-signature-256 header 500'd the WhatsApp
// webhook (and fired owner error alerts) instead of returning a clean 403.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../src/services/whatsapp.js';

const APP_SECRET = 'test-app-secret';
const RAW_BODY = JSON.stringify({ object: 'whatsapp_business_account' });

function sign(body: string, secret = APP_SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifyWebhookSignature(APP_SECRET, RAW_BODY, sign(RAW_BODY))).toBe(true);
  });

  it('rejects an empty signature header without throwing', () => {
    expect(verifyWebhookSignature(APP_SECRET, RAW_BODY, '')).toBe(false);
  });

  it('rejects a wrong-length signature header without throwing', () => {
    expect(verifyWebhookSignature(APP_SECRET, RAW_BODY, 'sha256=deadbeef')).toBe(false);
  });

  it('rejects a same-length signature over different bytes', () => {
    expect(
      verifyWebhookSignature(APP_SECRET, RAW_BODY, sign(RAW_BODY, 'wrong-secret')),
    ).toBe(false);
  });
});
