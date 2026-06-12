import { ZodError } from 'zod';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import type { Env } from '../config/env.js';

/**
 * Shared global error handler for both entrypoints (Cloud Functions and the
 * local dev server). Zod validation failures from route-level schema.parse()
 * have no statusCode, so without special-casing they'd surface as 500s and
 * page the on-call alert channel for plain bad client input.
 *
 * `notify: false` keeps local dev from texting/emailing the prod alert channels.
 */
export function createErrorHandler({ env, notify = true }: { env: Env; notify?: boolean }) {
  return async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error(error);

    // name check covers a ZodError from a duplicated zod install, which
    // would fail the instanceof check.
    if (error instanceof ZodError || error.name === 'ZodError') {
      const issues = (error as unknown as ZodError).issues ?? [];
      const message = issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      return reply.status(400).send({ error: message || 'Invalid request body' });
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Only alert on real server-side failures (5xx), not client/validation 4xx.
    if (status >= 500 && notify) {
      try {
        const { notifyError } = await import('../services/error-notify.js');
        // Awaited so the alert completes before the function instance freezes.
        await notifyError({
          env,
          err: error,
          source: 'api-route',
          context: { route: request.url, method: request.method },
        });
      } catch (e) {
        console.error('notifyError failed:', e);
      }
    }
    return reply.status(status).send({ error: status >= 500 ? 'Internal server error' : error.message });
  };
}
