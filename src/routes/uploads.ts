import type { FastifyInstance } from 'fastify';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/uploads — upload a single image to Firebase Storage
  app.post('/', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.badRequest('No file uploaded');

    const mime = data.mimetype;
    if (!mime.startsWith('image/')) {
      return reply.badRequest('Only image files are allowed');
    }

    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const filename = `uploads/${randomUUID()}.${ext}`;

    const bucket = getStorage().bucket();
    const file = bucket.file(filename);

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    await file.save(buffer, { contentType: mime, public: true });
    const url = `https://storage.googleapis.com/${bucket.name}/${filename}`;

    return { url, filename };
  });
}
