// The send guard (handoff 05 #1): outside NODE_ENV=production + ALLOW_REAL_SENDS=true
// no provider may be contacted. v1 had no guard, so dev and tests could text real people.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { realSendsAllowed } from '../src/config/send-guard.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { sendSms as telnyxSend } from '../src/services/telnyx.js';
import { sendWhatsApp, sendWhatsAppTemplate } from '../src/services/whatsapp.js';
import { sendEmail } from '../src/services/email.js';
import type { Env } from '../src/config/env.js';

const resendSend = vi.fn(async () => ({ error: null }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

const base = {
  VOIPMS_USERNAME: 'u', VOIPMS_PASSWORD: 'p', VOIPMS_DID: '5550000000',
  TELNYX_API_KEY: 'k', TELNYX_PHONE_NUMBER: '+15550000000',
  WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1',
  RESEND_API_KEY: 'r', FROM_EMAIL: 'from@example.test',
};
const env = (over: Partial<Env>) => ({ ...base, ...over }) as Env;
const to = '+15555550100';

describe('send guard', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    resendSend.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows real sends only with production AND the explicit flag', () => {
    expect(realSendsAllowed({ NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' })).toBe(true);
    expect(realSendsAllowed({ NODE_ENV: 'production', ALLOW_REAL_SENDS: 'false' })).toBe(false);
    expect(realSendsAllowed({ NODE_ENV: 'development', ALLOW_REAL_SENDS: 'true' })).toBe(false);
    expect(realSendsAllowed({ NODE_ENV: 'test', ALLOW_REAL_SENDS: 'true' })).toBe(false);
  });

  for (const blocked of [
    { NODE_ENV: 'development', ALLOW_REAL_SENDS: 'true' },
    { NODE_ENV: 'test', ALLOW_REAL_SENDS: 'true' },
    { NODE_ENV: 'production', ALLOW_REAL_SENDS: 'false' },
  ] as const) {
    it(`contacts no provider when ${blocked.NODE_ENV}/${blocked.ALLOW_REAL_SENDS}`, async () => {
      const e = env(blocked);
      for (const id of [
        await voipmsSend({ env: e, to, body: 'hi' }),
        await telnyxSend({ env: e, to, body: 'hi' }),
        await sendWhatsApp({ env: e, to, body: 'hi' }),
        await sendWhatsAppTemplate({ env: e, to, templateName: 't' }),
      ]) {
        expect(id).toMatch(/^simulated-/);
      }
      await sendEmail({ env: e, to: 'someone@example.test', subject: 's', message: 'm' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resendSend).not.toHaveBeenCalled();
    });
  }

  it('never logs a full phone number', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await voipmsSend({ env: env({ NODE_ENV: 'development', ALLOW_REAL_SENDS: 'false' }), to, body: 'hi' });
    expect(log.mock.calls.flat().join(' ')).not.toContain('5555550100');
  });

  it('reaches the provider when both conditions hold', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'success', sms: 42 }), text: async () => '' });
    await voipmsSend({ env: env({ NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' }), to, body: 'hi' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await sendEmail({ env: env({ NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true' }), to: 'someone@example.test', subject: 's', message: 'm' });
    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});
