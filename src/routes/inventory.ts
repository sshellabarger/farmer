import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, requireInventoryFarmOwner } from '../middleware/rbac.js';
import { byDateDesc } from '../utils/sort.js';
import { classifyFreshness } from '../utils/freshness.js';
import { syncFarmToLfm } from '../services/lfm-sync.js';
import { v4 as uuid } from 'uuid';

export async function inventoryRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const farmerOrAdmin = requireRole('farmer', 'admin');
  const invFarmOwner = requireInventoryFarmOwner(app);

  // GET /api/inventory?farm_id=&category=&status= (public read)
  app.get<{ Querystring: Record<string, string> }>('/', async (request) => {
    const { farm_id, category, status } = request.query;

    let query: FirebaseFirestore.Query = app.db.collection('inventory');
    if (farm_id) query = query.where('farm_id', '==', farm_id);
    if (status) query = query.where('status', '==', status);

    const snapshot = await query.get();
    const sortedDocs = byDateDesc(snapshot.docs.map((d) => ({ doc: d, listed_at: d.data().listed_at })), 'listed_at').map((x) => x.doc);

    const inventory = await Promise.all(
      sortedDocs.map(async (doc) => {
        const inv = doc.data();
        const productDoc = await app.db.collection('products').doc(inv.product_id).get();
        const product = productDoc.data() || {};
        const farmDoc = await app.db.collection('farms').doc(inv.farm_id).get();
        const farm = farmDoc.data() || {};

        if (category && !product.category?.toLowerCase().includes(category.toLowerCase())) {
          return null;
        }

        const freshness = classifyFreshness(inv.harvest_date, product.category, product.name);

        return {
          id: doc.id,
          product_name: product.name || 'Unknown',
          category: product.category || '',
          farm_name: farm.name || 'Unknown',
          quantity: inv.quantity,
          remaining: inv.remaining,
          unit: product.unit || '',
          price: inv.price,
          status: inv.status,
          harvest_date: inv.harvest_date,
          listed_at: inv.listed_at,
          image_url: inv.image_url,
          ...(freshness || {}),
        };
      }),
    );

    return { inventory: inventory.filter(Boolean) };
  });

  // POST /api/inventory/sync-lfm — push this farm's available produce to
  // Local Food Marketplace (ALFN). Runs as a dry-run (reports what would sync)
  // until the LFM_* env vars are configured with a confirmed write endpoint.
  app.post('/sync-lfm', {
    preHandler: [auth, farmerOrAdmin],
  }, async (request, reply) => {
    const farmId = request.authUser!.farmId;
    if (!farmId) return reply.badRequest('No farm associated with this account');

    const result = await syncFarmToLfm({ db: app.db, env: app.env, farmId });
    return result;
  });

  // POST /api/inventory
  app.post('/', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      product_id: z.string(),
      quantity: z.number().positive(),
      price: z.number().positive(),
      harvest_date: z.string().optional(),
      image_url: z.string().optional(),
    });

    const data = schema.parse(request.body);
    const id = uuid();

    const inv = {
      farm_id: data.farm_id,
      product_id: data.product_id,
      quantity: data.quantity,
      remaining: data.quantity,
      price: data.price,
      // Default to today's date when none is given so every listing has a harvest date.
      harvest_date: data.harvest_date ? new Date(data.harvest_date) : new Date(),
      image_url: data.image_url || null,
      status: 'available',
      listed_at: new Date(),
    };

    await app.db.collection('inventory').doc(id).set(inv);
    reply.status(201).send({ id, ...inv });
  });

  // PUT /api/inventory/:id
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    const { remaining, price, status, image_url, harvest_date, quantity } = request.body as Record<string, unknown>;

    const ref = app.db.collection('inventory').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.notFound('Inventory not found');
    const current = doc.data()!;

    const updates: Record<string, unknown> = {};
    if (remaining !== undefined) updates.remaining = remaining;
    if (price !== undefined) updates.price = price;
    if (image_url !== undefined) updates.image_url = image_url;
    if (harvest_date !== undefined) updates.harvest_date = harvest_date ? new Date(harvest_date as string) : null;
    if (quantity !== undefined) updates.quantity = quantity;

    // Derive status from quantities so it never drifts out of sync (e.g. editing
    // a previously "sold" item's quantity back up must not stay "sold"). An
    // explicit status in the request still wins (e.g. "reserved").
    if (status !== undefined) {
      updates.status = status;
    } else if (remaining !== undefined || quantity !== undefined) {
      const newRemaining = Number(remaining ?? current.remaining ?? 0);
      const newQuantity = Number(quantity ?? current.quantity ?? newRemaining);
      updates.status = newRemaining <= 0 ? 'sold' : newRemaining < newQuantity ? 'partial' : 'available';
    }

    await ref.update(updates);

    // Keep the product's default photo in sync so "use existing" can reuse it later.
    if (image_url !== undefined) {
      const productId = doc.data()!.product_id;
      if (productId) {
        await app.db.collection('products').doc(productId).update({ image_url: image_url ?? null }).catch(() => {});
      }
    }

    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  });

  // DELETE /api/inventory/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [auth, farmerOrAdmin, invFarmOwner],
  }, async (request, reply) => {
    await app.db.collection('inventory').doc(request.params.id).delete();
    reply.status(204).send();
  });
}
