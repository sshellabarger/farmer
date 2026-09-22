/** Best-effort E.164 for US numbers; the API normalizes again server-side. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.trim().startsWith('+') ? raw.trim() : `+${digits}`;
}
