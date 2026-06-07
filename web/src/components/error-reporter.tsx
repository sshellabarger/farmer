'use client';

import { useEffect } from 'react';

/**
 * Reports uncaught client-side errors to /api/errors so they trigger the
 * same alert pipeline as server errors (email/SMS with AI-suggested fix).
 *
 * Safeguards: dedupes by message per session, caps total reports per page
 * load, and never throws itself.
 */
const MAX_REPORTS_PER_SESSION = 5;

export function ErrorReporter() {
  useEffect(() => {
    const seen = new Set<string>();
    let sent = 0;

    const report = (message: string, stack?: string) => {
      try {
        if (sent >= MAX_REPORTS_PER_SESSION) return;
        const key = message.slice(0, 120);
        if (seen.has(key)) return;
        seen.add(key);
        sent += 1;
        fetch('/api/errors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: message.slice(0, 2000),
            stack: stack?.slice(0, 8000),
            url: window.location.href.slice(0, 500),
            userAgent: navigator.userAgent.slice(0, 300),
            source: 'web-client',
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Never let the reporter itself break the page.
      }
    };

    const onError = (event: ErrorEvent) => {
      report(event.message || 'Unknown error', event.error?.stack);
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      report(`Unhandled rejection: ${message}`, reason instanceof Error ? reason.stack : undefined);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
