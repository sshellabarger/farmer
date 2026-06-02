// In-memory sort helpers for Firestore query results.
// Used instead of Firestore .orderBy() on filtered queries so we don't
// require composite indexes for every where+orderBy combination.

function toMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Sort an array of objects by a timestamp/date field, descending (newest first). */
export function byDateDesc<T>(items: T[], field: string): T[] {
  return [...items].sort((a: any, b: any) => toMillis(b[field]) - toMillis(a[field]));
}

/** Sort an array of objects by a timestamp/date field, ascending (oldest first). */
export function byDateAsc<T>(items: T[], field: string): T[] {
  return [...items].sort((a: any, b: any) => toMillis(a[field]) - toMillis(b[field]));
}

/** Sort an array of objects by a numeric field, ascending. */
export function byNumberAsc<T>(items: T[], field: string, fallback = 0): T[] {
  return [...items].sort((a: any, b: any) => (a[field] ?? fallback) - (b[field] ?? fallback));
}

/** Sort an array of objects by a string field, ascending (locale-aware). */
export function byStringAsc<T>(items: T[], field: string): T[] {
  return [...items].sort((a: any, b: any) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')));
}
