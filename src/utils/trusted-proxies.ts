/**
 * The proxies whose `X-Forwarded-For` entries the API believes (Phase 4 fix X1).
 *
 * `request.ip` is the rate-limit key and the address stored as evidence on an
 * application (`ip`, `sms_consent.ip`, `signature.ip`) and on a Hold Harmless
 * signature. Fastify (through proxy-addr) walks the chain from the socket
 * leftwards and stops at the first address that is NOT in this list, so
 * `request.ip` is "the first untrusted address from the right".
 *
 * Why a list and not `trustProxy: true` (measured in production, 2026-11-09):
 *
 *   - Through Firebase Hosting the function sees
 *       X-Forwarded-For: <client ip>, <google proxy ip>
 *     Hosting discards any `X-Forwarded-For` the client sent, and the proxy
 *     address was always inside Google's service ranges.
 *   - Sent directly to the public run.app / cloudfunctions.net URL it sees
 *       X-Forwarded-For: <whatever the client sent>, <client ip>
 *     With `trustProxy: true` the left-most entry won, so a caller could mint
 *     a fresh rate-limit bucket (and a false evidence address) per request.
 *
 * With the list below both paths resolve to the true client: loopback is the
 * socket (the Cloud Function hands every request to `fastify.inject`, whose
 * socket address is 127.0.0.1), the Google hop is skipped, and the next
 * address is the one Google's front end observed.
 *
 * RESIDUAL RISK (accepted, documented for the owner):
 *
 *   - A caller able to send requests FROM an address inside Google's service
 *     ranges (for example a Google Apps Script or another Google-hosted
 *     fetcher) reaching the direct URL would be taken for the proxy, and the
 *     entry it wrote to its left would be believed. The per-IP limits can be
 *     side-stepped that way; the global daily caps on uploads and on
 *     submissions (fix X2) are the backstop, and the evidence address on such
 *     a submission would be whatever that caller claimed.
 *   - If Google starts fronting Hosting from a range that is not listed here,
 *     Hosting traffic would be keyed per proxy address (many clients sharing
 *     a few buckets, so limits trip early) until the list is updated. The
 *     symptom is 429s for ordinary visitors and evidence addresses that all
 *     belong to Google.
 *
 * The ranges are Google's published service ("goog") netblocks that cover
 * every proxy address observed (66.249.x, 142.250.x, 74.125.x, 66.102.x,
 * 192.178.x, 64.233.x). They are an infrastructure fact, not market data.
 */

/** The socket address of `fastify.inject` (and of a local dev client). */
export const LOOPBACK_RANGES: readonly string[] = ['127.0.0.0/8', '::1/128'];

/** Google front-end / service address ranges (IPv4 and IPv6). */
export const GOOGLE_SERVICE_RANGES: readonly string[] = [
  '64.233.160.0/19',
  '66.102.0.0/20',
  '66.249.64.0/19',
  '72.14.192.0/18',
  '74.125.0.0/16',
  '108.177.0.0/17',
  '142.250.0.0/15',
  '172.217.0.0/16',
  '172.253.0.0/16',
  '173.194.0.0/16',
  '192.178.0.0/15',
  '209.85.128.0/17',
  '216.58.192.0/19',
  '216.239.32.0/19',
  '2001:4860::/32',
  '2404:6800::/32',
  '2607:f8b0::/32',
  '2800:3f0::/32',
  '2a00:1450::/32',
  '2c0f:fb50::/32',
];

/** What `buildApp()` passes to Fastify's `trustProxy`. */
export const TRUSTED_PROXIES: string[] = [...LOOPBACK_RANGES, ...GOOGLE_SERVICE_RANGES];
