import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notifyError } from '../services/error-notify.js';

const reportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
  source: z.string().max(100).optional(),
});

/**
 * Client-side error reporting.
 *
 * The web app posts uncaught errors here so they flow through the same
 * notifyError pipeline as server errors (throttled alerts via email/SMS,
 * AI-suggested fix, error_alerts dedup store). No auth — errors often occur
 * before login (which is exactly when we most need to hear about them) —
 * but tightly rate-limited per IP to prevent abuse.
 */
export async function errorRoutes(app: FastifyInstance) {
  app.post('/', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const { message, stack, url, userAgent, source } = parsed.data;

    const err = new Error(message);
    if (stack) err.stack = stack;

    // Fire-and-forget: never let the alert pipeline delay or fail the response.
    notifyError({
      env: app.env,
      err,
      source: source || 'web-client',
      context: {
        source: source || 'web-client',
        route: url,
        userMessage: userAgent ? `UA: ${userAgent.slice(0, 200)}` : undefined,
      },
    }).catch((e) => console.error('[errors-route] notify failed:', e instanceof Error ? e.message : e));

    return reply.status(202).send({ received: true });
  });
}
