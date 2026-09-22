/**
 * Firestore hands back `Timestamp` instances for every date field it stores.
 * Freshly written documents (and the test fake's raw store) hold `Date`, and
 * imported rows may hold ISO strings. Every read of a date field goes through
 * here, so comparison code never touches a raw field — `doc.end_at.getTime()`
 * on a Timestamp is what broke the nightly rollMarketDates run on 2026-09-22.
 */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; _seconds?: number; _nanoseconds?: number; seconds?: number; nanoseconds?: number };
    if (typeof v.toDate === 'function') return v.toDate();
    const seconds = v._seconds ?? v.seconds;
    const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
    if (typeof seconds === 'number') return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** `toDate` for fields that must exist; a malformed doc reads as the epoch, i.e. "long past". */
export function toDateOrEpoch(value: unknown): Date {
  return toDate(value) ?? new Date(0);
}

export function toMillis(value: unknown): number | null {
  const d = toDate(value);
  return d ? d.getTime() : null;
}
