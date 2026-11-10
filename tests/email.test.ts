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

  it('wraps every email in the SJCA Markets page, never the retired FarmLink one (fix X6)', async () => {
    await sendEmail({ env: production, to: 'owner@example.com', subject: 'Your 2027 application is approved', message: 'Hello,\nWelcome.' });
    const { html } = send.mock.calls[0][0] as { html: string };
    expect(html).toContain('<h1>SJCA Markets</h1>');
    expect(html).toContain('<div class="footer">St. Joseph Center of Arkansas - SJCA Markets</div>');
    expect(html).not.toMatch(/FarmLink/i);
    expect(html).toContain('<p>Your 2027 application is approved</p>');
  });

  it('escapes the subject where the page repeats it, and leaves the subject header itself alone', async () => {
    const subject = '[SJCA Markets] Hill & Dale <Market> check-in deadline';
    await sendEmail({ env: production, to: 'owner@example.com', subject, message: 'x' });
    const payload = send.mock.calls[0][0] as { subject: string; html: string };
    expect(payload.subject).toBe(subject);
    expect(payload.html).toContain('<p>[SJCA Markets] Hill &amp; Dale &lt;Market&gt; check-in deadline</p>');
    expect(payload.html).not.toContain('<Market>');
  });

  it('still passes the markup of the staff emails (error alerts, the deadline summary) through untouched', async () => {
    const message = '<table><tr><th>Producer</th></tr><tr><td><b>Acme Farm</b></td></tr></table>\n<a href="https://example.com/admin">Open</a>';
    await sendEmail({ env: production, to: 'owner@example.com', subject: 'Deadline', message });
    const { html } = send.mock.calls[0][0] as { html: string };
    expect(html).toContain('<table><tr><th>Producer</th></tr><tr><td><b>Acme Farm</b></td></tr></table><br><a href="https://example.com/admin">Open</a>');
  });

  it('a Resend error rejects loudly', async () => {
    send.mockImplementation(async () => ({ data: null as never, error: { message: 'domain not verified' } }));
    await expect(sendEmail({ env: production, to: 'owner@example.com', subject: 'Hello', message: 'x' })).rejects.toThrow('Resend error: domain not verified');
  });
});
