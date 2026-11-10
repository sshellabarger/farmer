// Fix X6: every value interpolated into an email body is HTML-escaped, and the
// producer-facing emails (invitation, acceptance) are built that way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { escapeHtml, htmlLink } from '../src/utils/html.js';
import { acceptanceEmailBody, inviteEmailBody } from '../src/services/invites.js';
import type { FarmersMarket } from '../src/services/markets.js';
import { T_OPEN, adminAuth, boot, market, seed, validSubmission } from './helpers/a1-fixtures.js';

describe('escapeHtml', () => {
  it('escapes markup, ampersands and both kinds of quote', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('Hill & Dale')).toBe('Hill &amp; Dale');
    expect(escapeHtml(`"quoted" and 'single'`)).toBe('&quot;quoted&quot; and &#39;single&#39;');
    expect(escapeHtml('a`b')).toBe('a&#96;b');
    expect(escapeHtml('<img src=x onerror="alert(\'x\')">')).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;');
  });

  it('escapes an ampersand once, also when the text already looks escaped', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
    expect(escapeHtml('a & b && c')).toBe('a &amp; b &amp;&amp; c');
  });

  it('leaves plain text alone and stringifies everything else', () => {
    expect(escapeHtml("Terry O'Neil-Smith Jr.")).toBe('Terry O&#39;Neil-Smith Jr.');
    expect(escapeHtml('Plain words, 100% safe: yes/no')).toBe('Plain words, 100% safe: yes/no');
    expect(escapeHtml(1250)).toBe('1250');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml('')).toBe('');
  });
});

describe('htmlLink', () => {
  it('links an http(s) address with the address as its text, escaped in both places', () => {
    expect(htmlLink('https://pay.example.test/booth')).toBe('<a href="https://pay.example.test/booth">https://pay.example.test/booth</a>');
    expect(htmlLink('https://pay.example.test/x?a=1&b=2')).toBe('<a href="https://pay.example.test/x?a=1&amp;b=2">https://pay.example.test/x?a=1&amp;b=2</a>');
    expect(htmlLink('https://x.test/"><script>alert(1)</script>')).toBe(
      '<a href="https://x.test/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">https://x.test/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>',
    );
  });

  it('never links anything else', () => {
    expect(htmlLink('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(htmlLink('data:text/html,<b>x</b>')).toBe('data:text/html,&lt;b&gt;x&lt;/b&gt;');
    expect(htmlLink(null)).toBe('');
  });
});

const HOSTILE = '<script>alert("x")</script>';
const totals = { rate: 'seasonal' as const, spaces: 2 as const, electric: true, pay_in_full: false, booth_fee: 1400, electric_fee: 50, total: 1450, basis: 'season' as const, installments: 2 };

describe('the producer-facing email bodies', () => {
  const m = { id: 'wlrfm', ...market({ name: 'Hill & Dale <Market>' }) } as unknown as FarmersMarket;

  it('the acceptance email escapes the applicant-typed first name, the market name and every address', () => {
    const body = acceptanceEmailBody({
      market: m,
      season: '2027',
      firstName: HOSTILE,
      agreementUrl: 'https://test.example/agreement?t=abc',
      totals,
      boothFeeUrl: 'https://pay.example.test/booth?a=1&b=2',
      insuranceHelpUrl: 'https://help.example.test/"onmouseover="x',
      firstDate: '2027-04-03',
      appUrl: 'https://test.example',
    });
    expect(body).not.toContain('<script');
    expect(body).toContain('Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;,');
    expect(body).toContain('Your 2027 Hill &amp; Dale &lt;Market&gt; application has been approved.');
    expect(body).toContain('<a href="https://test.example/agreement?t=abc">https://test.example/agreement?t=abc</a>');
    expect(body).toContain('<a href="https://pay.example.test/booth?a=1&amp;b=2">');
    expect(body).toContain('href="https://help.example.test/&quot;onmouseover=&quot;x"');
    expect(body).toContain('Booth fee: $1450 for the season, in 2 installments.');
    expect(body).toContain('<a href="https://test.example/rules?market=wlrfm">');
    // The only markup in the body is the links this code wrote.
    expect(body.replace(/<a href="[^"<>]*">[^<>]*<\/a>/g, '')).not.toMatch(/[<>]/);
  });

  it('the invitation email escapes the market name and links the application and the rules', () => {
    const body = inviteEmailBody(m, '2027', 'https://test.example/apply?t=tok', 'https://test.example/');
    expect(body).toContain('Applications for the 2027 Hill &amp; Dale &lt;Market&gt; season are open.');
    expect(body).toContain('<a href="https://test.example/apply?t=tok">https://test.example/apply?t=tok</a>');
    expect(body).toContain('<a href="https://test.example/rules?market=wlrfm">https://test.example/rules?market=wlrfm</a>');
    expect(body.replace(/<a href="[^"<>]*">[^<>]*<\/a>/g, '')).not.toMatch(/[<>]/);
  });
});

describe('approving an application whose contact name carries markup', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T_OPEN);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends an acceptance email with the name escaped, end to end', async () => {
    const db = seed();
    const app: FastifyInstance = await boot(db);
    const submission = validSubmission() as { contact: Record<string, unknown> };
    submission.contact = { ...submission.contact, name: `${HOSTILE} Testfield` };
    const sub = await app.inject({ method: 'POST', url: '/api/applications', payload: submission as never });
    expect(sub.statusCode).toBe(201);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${sub.json().id}`,
      headers: adminAuth(),
      payload: { action: 'approve', fee_plan: 'seasonal', spaces: 1, electric: false, pay_in_full: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sends.email).toBe(true);

    const emails = log.mock.calls.filter((c) => String(c[0]).startsWith('[email:console]'));
    expect(emails).toHaveLength(1);
    const body = String(emails[0]![3]);
    expect(body).toContain('Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;,');
    expect(body).not.toContain('<script');
  });
});
