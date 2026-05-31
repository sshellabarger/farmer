export type ErrorCategory =
  | 'anthropic_billing'
  | 'anthropic_rate_limit'
  | 'anthropic_api'
  | 'database'
  | 'voipms'
  | 'resend'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  isAnthropicError: boolean;
  message: string;
  raw: unknown;
}

export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.status;

  if (message.includes('credit balance is too low') || message.includes('billing')) {
    return { category: 'anthropic_billing', isAnthropicError: true, message, raw: err };
  }
  if (status === 429 || message.includes('rate limit') || message.includes('overloaded')) {
    return { category: 'anthropic_rate_limit', isAnthropicError: true, message, raw: err };
  }
  if (message.includes('anthropic') || message.includes('claude') || status === 529 || (status >= 500 && status < 600 && (err as any)?.request_id)) {
    return { category: 'anthropic_api', isAnthropicError: true, message, raw: err };
  }
  if (message.includes('voip.ms') || message.includes('sendSMS') || message.includes('sms_toolong')) {
    return { category: 'voipms', isAnthropicError: false, message, raw: err };
  }
  if (message.includes('Resend') || message.includes('resend')) {
    return { category: 'resend', isAnthropicError: false, message, raw: err };
  }
  if (message.includes('relation') || message.includes('column') || message.includes('violates') || message.includes('pg')) {
    return { category: 'database', isAnthropicError: false, message, raw: err };
  }
  return { category: 'unknown', isAnthropicError: false, message, raw: err };
}

const FIX_HINTS: Record<ErrorCategory, string> = {
  anthropic_billing: `
    <strong>Fix:</strong> Add credits at <a href="https://console.anthropic.com/settings/billing">console.anthropic.com → Plans &amp; Billing</a>.<br>
    All SMS replies are silenced until resolved.`,
  anthropic_rate_limit: `
    <strong>Fix:</strong> Anthropic is rate limiting or overloaded. Usually self-resolves in minutes.<br>
    Consider adding retry logic or upgrading your usage tier.`,
  anthropic_api: `
    <strong>Fix:</strong> Anthropic API returned an unexpected error. Check <a href="https://status.anthropic.com">status.anthropic.com</a> for outages.`,
  voipms: `
    <strong>Fix:</strong> Check voip.ms API credentials (VOIPMS_USERNAME, VOIPMS_PASSWORD, VOIPMS_DID) and that your server IP is whitelisted in the voip.ms portal.`,
  resend: `
    <strong>Fix:</strong> Check your RESEND_API_KEY and that FROM_EMAIL domain is verified in the Resend dashboard.`,
  database: `
    <strong>Fix:</strong> Database error — check PostgreSQL is running and DATABASE_URL is correct. Review migration state.`,
  unknown: `
    <strong>Fix:</strong> Unknown error — review the stack trace above for clues.`,
};

export function getFixHint(category: ErrorCategory): string {
  return FIX_HINTS[category];
}
