/**
 * HTML escaping for the emails the app composes (Phase 4 fix X6).
 *
 * `sendEmail` inserts its `message` into an HTML page as it is, so every
 * value that did not come from this code base (a name an applicant typed, a
 * market name, a URL an admin pasted) must pass through `escapeHtml` before
 * it is interpolated into a message. Pure functions, no I/O.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Escapes a value for HTML text and for a quoted attribute value. `null` and
 * `undefined` become the empty string; anything else is stringified first.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => ENTITIES[ch]!);
}

/**
 * An `<a>` for an http(s) URL, with the URL itself as the link text (so the
 * address is visible and survives a plain-text rendering). Anything that is
 * not an http(s) URL comes back as escaped text, never as a link: a
 * `javascript:` or `data:` address must not become clickable.
 */
export function htmlLink(url: unknown): string {
  const text = escapeHtml(url);
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return text;
  return `<a href="${text}">${text}</a>`;
}
