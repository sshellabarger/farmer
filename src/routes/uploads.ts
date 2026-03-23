import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/uploads — upload a single image, returns URL
  app.post('/', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.badRequest('No file uploaded');
    }

    // Validate it's an image
    const mime = data.mimetype;
    if (!mime.startsWith('image/')) {
      return reply.badRequest('Only image files are allowed');
    }

    // Generate unique filename
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const filename = `${randomUUID()}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Save file
    await pipeline(data.file, fs.createWriteStream(filepath));

    const url = `/uploads/${filename}`;
    return { url, filename };
  });
}
