export type ErrorCategory =
  | 'anthropic_billing'
  | 'anthropic_rate_limit'
  | 'anthropic_api'
  | 'firestore_index'
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
  if (message.includes('requires an index') || message.includes('FAILED_PRECONDITION')) {
    return { category: 'firestore_index', isAnthropicError: false, message, raw: err };
  }
  if (
    message.includes('firestore') ||
    message.includes('PERMISSION_DENIED') ||
    message.includes('NOT_FOUND') ||
    message.includes('documentPath') ||
    message.includes('DEADLINE_EXCEEDED')
  ) {
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
    <strong>Fix:</strong> Check voip.ms API credentials (VOIPMS_USERNAME, VOIPMS_PASSWORD, VOIPMS_DID) and that the API IP whitelist allows the server (currently *.*.*.*). <code>sms_toolong</code> means a reply exceeded the per-segment limit — the splitter should handle this.`,
  resend: `
    <strong>Fix:</strong> Check your RESEND_API_KEY and that FROM_EMAIL domain is verified in the Resend dashboard.`,
  firestore_index: `
    <strong>Fix:</strong> A Firestore query needs a composite index. Open the link in the error to auto-create it, or refactor the query to sort in memory (see src/utils/sort.ts).`,
  database: `
    <strong>Fix:</strong> Firestore error — check the document path is valid, security rules, and that the Cloud Function service account has Firestore access.`,
  unknown: `
    <strong>Fix:</strong> Unknown error — review the stack trace above for clues.`,
};

// Plain-text version of the fix hints, for SMS alerts (no HTML).
const FIX_HINTS_TEXT: Record<ErrorCategory, string> = {
  anthropic_billing: 'Add credits at console.anthropic.com -> Billing. SMS replies are silenced until resolved.',
  anthropic_rate_limit: 'Anthropic rate-limited/overloaded. Usually self-resolves in minutes.',
  anthropic_api: 'Anthropic API error. Check status.anthropic.com for outages.',
  voipms: 'Check voip.ms creds + API IP whitelist. sms_toolong = reply too long for a segment.',
  resend: 'Check RESEND_API_KEY and that FROM_EMAIL domain is verified in Resend.',
  firestore_index: 'A Firestore query needs a composite index, or refactor to sort in memory.',
  database: 'Firestore error: check document path, security rules, and service-account access.',
  unknown: 'Unknown error. See the email/console logs for the stack trace.',
};

export function getFixHint(category: ErrorCategory): string {
  return FIX_HINTS[category];
}

export function getFixHintText(category: ErrorCategory): string {
  return FIX_HINTS_TEXT[category];
}
