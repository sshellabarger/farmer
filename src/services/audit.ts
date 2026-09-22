import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';

/**
 * audit_log writer (SPEC §6.9: every admin action writes audit_log).
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte.
 */

export interface AuditEntry {
  actor_id: string;
  actor_role: string;
  /** Dotted verb, e.g. 'market.create', 'membership.transition'. */
  action: string;
  target: { collection: string; id: string };
  before?: unknown;
  after?: unknown;
  note?: string | null;
}

/**
 * Append one entry. Never throws: the action it records has already
 * happened, so a failed audit write is reported to the console instead of
 * failing the request. Resolves to the entry id.
 */
export async function writeAudit(db: Firestore, entry: AuditEntry): Promise<string> {
  const id = uuid();
  const row = {
    actor_id: entry.actor_id,
    actor_role: entry.actor_role,
    action: entry.action,
    target: entry.target,
    before: entry.before ?? null,
    after: entry.after ?? null,
    note: entry.note ?? null,
    at: new Date(),
  };
  try {
    await db.collection('audit_log').doc(id).set(row);
  } catch (err) {
    console.error(`audit_log write failed: ${entry.action} ${entry.target.collection}/${entry.target.id}`, err);
  }
  return id;
}
