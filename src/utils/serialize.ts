/**
 * Recursively convert Firestore Timestamps (and Date objects) in an API response
 * payload to ISO 8601 strings. Without this, Firestore Timestamps serialize to
 * `{_seconds, _nanoseconds}`, which breaks `new Date(...)` on the frontend
 * (showing "Invalid Date"). Wired as a Fastify preSerialization hook.
 */
export function serializeTimestamps(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Firestore Timestamp instance (Admin SDK) — has a toDate() method.
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return value;
    }
  }

  // Already-serialized Timestamp shape: { _seconds, _nanoseconds }.
  if (typeof value._seconds === 'number' && typeof value._nanoseconds === 'number') {
    return new Date(value._seconds * 1000 + Math.floor(value._nanoseconds / 1e6)).toISOString();
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map(serializeTimestamps);

  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) out[key] = serializeTimestamps(value[key]);
  return out;
}
