import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/rbac.js';
import { uploadImageBuffer } from '../services/storage.js';

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/uploads — upload a single image to Firebase Storage.
  // Authenticated: v1 left this open to the internet (SPEC §2.1, D7). The
  // token-gated /produce/:token flow retired with produce photos.
  app.post('/', { preHandler: [authenticate(app)] }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.badRequest('No file uploaded');

    const mime = data.mimetype;
    if (!mime.startsWith('image/')) {
      return reply.badRequest('Only image files are allowed');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    const { url, filename } = await uploadImageBuffer(app.env, buffer, mime);
    return { url, filename };
  });
}
