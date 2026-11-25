import type { FastifyInstance } from 'fastify';
import { uploadImageBuffer } from '../services/storage.js';

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/uploads — upload a single image to Firebase Storage
  app.post('/', async (request, reply) => {
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

  // POST /api/uploads/produce/:token — public, token-gated upload that attaches
  // the photo directly to a specific inventory item (used by the SMS "upload" link).
  app.post<{ Params: { token: string } }>('/produce/:token', async (request, reply) => {
    const { token } = request.params;
    if (!token) return reply.badRequest('Missing token');

    const linkRef = app.db.collection('upload_links').doc(token);
    const linkDoc = await linkRef.get();
    if (!linkDoc.exists) return reply.status(410).send({ error: 'This upload link is invalid or has expired.' });

    const link = linkDoc.data()!;
    const expiresAt = link.expires_at?.toDate?.() || new Date(link.expires_at);
    if (expiresAt < new Date()) return reply.status(410).send({ error: 'This upload link has expired.' });

    const data = await request.file();
    if (!data) return reply.badRequest('No file uploaded');
    if (!data.mimetype.startsWith('image/')) return reply.badRequest('Only image files are allowed');

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);

    const { url } = await uploadImageBuffer(app.env, buffer, data.mimetype);

    // Attach to the inventory item and remember it as the product's default photo.
    const invRef = app.db.collection('inventory').doc(link.inventory_id);
    const invDoc = await invRef.get();
    if (invDoc.exists) {
      await invRef.update({ image_url: url });
      const productId = invDoc.data()!.product_id;
      if (productId) await app.db.collection('products').doc(productId).update({ image_url: url }).catch(() => {});
    }

    await linkRef.delete().catch(() => {});
    return { success: true, url };
  });

  // GET /api/uploads/produce/:token — metadata for the upload form (item name, etc.)
  app.get<{ Params: { token: string } }>('/produce/:token', async (request, reply) => {
    const { token } = request.params;
    if (!token) return reply.badRequest('Missing token');
    const linkDoc = await app.db.collection('upload_links').doc(token).get();
    if (!linkDoc.exists) return reply.status(410).send({ error: 'This upload link is invalid or has expired.' });
    const link = linkDoc.data()!;
    const expiresAt = link.expires_at?.toDate?.() || new Date(link.expires_at);
    if (expiresAt < new Date()) return reply.status(410).send({ error: 'This upload link has expired.' });
    return { product_name: link.product_name || 'your produce', inventory_id: link.inventory_id };
  });
}
