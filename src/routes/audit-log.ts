import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { byDateDesc } from '../utils/sort.js';
import type { AuditEntry } from '../services/audit.js';

type AuditRow = AuditEntry & { id: string };

/**
 * GET /api/audit-log — admin only. A full collection scan when `actor_id`
 * isn't given, filtered/sorted in memory (repo convention: one equality
 * filter at the DB). See notes-A1.md for the growth caveat: this needs a
 * bounded query once fake-db grows `orderBy`.
 */
export async function auditLogRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [authenticate(app), requireRole('admin')] }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        collection: z.string().optional(),
        actor_id: z.string().optional(),
        action_prefix: z.string().optional(),
      })
      .parse(request.query ?? {});

    const snap = query.actor_id
      ? await app.db.collection('audit_log').where('actor_id', '==', query.actor_id).get()
      : await app.db.collection('audit_log').get();

    let entries = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as unknown as AuditRow);
    if (query.collection) entries = entries.filter((e) => e.target?.collection === query.collection);
    if (query.action_prefix) entries = entries.filter((e) => String(e.action ?? '').startsWith(query.action_prefix!));

    entries = byDateDesc(entries, 'at').slice(0, query.limit);

    return { entries };
  });
}
