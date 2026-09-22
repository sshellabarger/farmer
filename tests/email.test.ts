// Email mirrors the SMS guard (SPEC §7.3): the console provider logs and
// resolves; Resend is reachable only in production with ALLOW_REAL_SENDS=true.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/config/env.js';
import { sendEmail, selectEmailProvider } from '../src/services/email.js';
import { SendsDisabledError } from '../src/services/sms.js';

const { send } = vi.hoisted(() => ({
  send: vi.fn(async (_payload: unknown) => ({ data: { id: 'email-1' }, error: null as null | { message: string } })),
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const base = {
  NODE_ENV: 'test',
  SMS_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  ALLOW_REAL_SENDS: 'false',
  RESEND_API_KEY: '',
  FROM_EMAIL: 'alerts@example.com',
  JWT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: 'test',
} as unknown as Env;
const production = { ...base, EMAIL_PROVIDER: 'resend', NODE_ENV: 'production', ALLOW_REAL_SENDS: 'true', RESEND_API_KEY: 're_test' } as Env;

let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  send.mockClear();
  send.mockImplementation(async () => ({ data: { id: 'email-1' }, error: null }));
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLog.mockRestore();
});

describe('selectEmailProvider', () => {
  it('console is always allowed; resend needs production AND the flag', () => {
    expect(selectEmailProvider(base)).toBe('console');
    expect(selectEmailProvider(production)).toBe('resend');
    expect(() => selectEmailProvider({ ...production, NODE_ENV: 'development' })).toThrow(SendsDisabledError);
    expect(() => selectEmailProvider({ ...production, ALLOW_REAL_SENDS: 'false' })).toThrow(SendsDisabledError);
  });
});

describe('sendEmail', () => {
  it('console provider logs the recipient and subject and resolves without touching Resend', async () => {
    await expect(sendEmail({ env: base, to: 'owner@example.com', subject: 'Hello', message: 'line 1\nline 2' })).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledTimes(1);
    const line = String(consoleLog.mock.calls[0][0]);
    expect(line).toContain('[email:console]');
    expect(consoleLog.mock.calls[0].slice(1)).toEqual(['owner@example.com', 'Hello', 'line 1\nline 2']);
  });

  it('resend is blocked outside production even with ALLOW_REAL_SENDS=true', async () => {
    const env = { ...production, NODE_ENV: 'development' } as Env;
    await expect(sendEmail({ env, to: 'owner@example.com', subject: 'Hello', message: 'x' })).rejects.toBeInstanceOf(SendsDisabledError);
    expect(send).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('resend is blocked in production without the flag', async () => {
    const env = { ...production, ALLOW_REAL_SENDS: 'false' } as Env;
    await expect(sendEmail({ env, to: 'owner@example.com', subject: 'Hello', message: 'x' })).rejects.toBeInstanceOf(SendsDisabledError);
    expect(send).not.toHaveBeenCalled();
  });

  it('production + flag sends through Resend with the configured sender', async () => {
    await sendEmail({ env: production, to: 'owner@example.com', subject: 'Hello', message: 'line 1\nline 2' });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as { from: string; to: string; subject: string; html: string };
    expect(payload).toMatchObject({ from: 'alerts@example.com', to: 'owner@example.com', subject: 'Hello' });
    expect(payload.html).toContain('line 1<br>line 2');
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('a Resend error rejects loudly', async () => {
    send.mockImplementation(async () => ({ data: null as never, error: { message: 'domain not verified' } }));
    await expect(sendEmail({ env: production, to: 'owner@example.com', subject: 'Hello', message: 'x' })).rejects.toThrow('Resend error: domain not verified');
  });
});
