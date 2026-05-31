import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendSms } from '../services/sms.js';
import { v4 as uuid } from 'uuid';

export async function directoryRoutes(app: FastifyInstance) {
  // Browse all farms
  app.get('/farms', async (request, reply) => {
    const { search, market_id } = request.query as { search?: string; market_id?: string };

    const snapshot = await app.db.collection('farms').where('active', '==', true).orderBy('name').get();

    let farms = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (search) {
      const s = search.toLowerCase();
      farms = farms.filter((f: any) =>
        f.name?.toLowerCase().includes(s) ||
        f.location?.toLowerCase().includes(s) ||
        f.specialty?.toLowerCase().includes(s)
      );
    }

    if (market_id) {
      const relsSnap = await app.db
        .collection('farm_market_rels')
        .where('market_id', '==', market_id)
        .get();
      const relMap = new Map(relsSnap.docs.map((d) => [d.data().farm_id, { id: d.id, ...d.data() }]));
      const annotated = farms.map((f: any) => ({ ...f, connection: relMap.get(f.id) ?? null }));
      return reply.send({ farms: annotated });
    }

    reply.send({ farms });
  });

  // Browse all markets
  app.get('/markets', async (request, reply) => {
    const { search, farm_id } = request.query as { search?: string; farm_id?: string };

    const snapshot = await app.db.collection('markets').where('active', '==', true).orderBy('name').get();
    let markets = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (search) {
      const s = search.toLowerCase();
      markets = markets.filter((m: any) =>
        m.name?.toLowerCase().includes(s) ||
        m.location?.toLowerCase().includes(s)
      );
    }

    if (farm_id) {
      const relsSnap = await app.db
        .collection('farm_market_rels')
        .where('farm_id', '==', farm_id)
        .get();
      const relMap = new Map(relsSnap.docs.map((d) => [d.data().market_id, { id: d.id, ...d.data() }]));
      const annotated = markets.map((m: any) => ({ ...m, connection: relMap.get(m.id) ?? null }));
      return reply.send({ markets: annotated });
    }

    reply.send({ markets });
  });

  // Send connection request
  app.post('/connect', async (request, reply) => {
    const schema = z.object({
      farm_id: z.string(),
      market_id: z.string(),
      initiated_by: z.enum(['farm', 'market']),
      message: z.string().max(280).optional(),
    });

    const data = schema.parse(request.body);

    const farmDoc = await app.db.collection('farms').doc(data.farm_id).get();
    const marketDoc = await app.db.collection('markets').doc(data.market_id).get();
    if (!farmDoc.exists || !marketDoc.exists) {
      return reply.status(404).send({ error: 'Farm or market not found' });
    }

    const farm = farmDoc.data()!;
    const market = marketDoc.data()!;

    // Get user phones
    const farmUserDoc = await app.db.collection('users').doc(farm.user_id).get();
    const marketUserDoc = await app.db.collection('users').doc(market.user_id).get();

    // Check existing
    const existingSnap = await app.db
      .collection('farm_market_rels')
      .where('farm_id', '==', data.farm_id)
      .where('market_id', '==', data.market_id)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const existing = existingSnap.docs[0].data();
      if (existing.status === 'active') return reply.status(409).send({ error: 'Already connected' });
      if (existing.status === 'pending') return reply.status(409).send({ error: 'Request already pending' });

      // Re-request after decline
      await existingSnap.docs[0].ref.update({
        status: 'pending',
        initiated_by: data.initiated_by,
        request_message: data.message ?? null,
        responded_at: null,
      });

      const updatedDoc = await existingSnap.docs[0].ref.get();
      const rel = { id: updatedDoc.id, ...updatedDoc.data() };

      const recipientPhone = data.initiated_by === 'farm' ? marketUserDoc.data()?.phone : farmUserDoc.data()?.phone;
      const senderName = data.initiated_by === 'farm' ? farm.name : market.name;
      if (recipientPhone) {
        const msgNote = data.message ? `\n\n"${data.message}"` : '';
        await sendSms({ env: app.env, to: recipientPhone, body: `FarmLink: ${senderName} wants to connect!${msgNote}\n\nReply YES to accept.` }).catch(() => null);
      }

      return reply.send({ rel, sms_sent: !!recipientPhone });
    }

    // Create new
    const relId = uuid();
    const rel = {
      farm_id: data.farm_id,
      market_id: data.market_id,
      priority: 50,
      notification_delay_min: 0,
      active: false,
      status: 'pending',
      initiated_by: data.initiated_by,
      request_message: data.message ?? null,
      responded_at: null,
      created_at: new Date(),
    };
    await app.db.collection('farm_market_rels').doc(relId).set(rel);

    const recipientPhone = data.initiated_by === 'farm' ? marketUserDoc.data()?.phone : farmUserDoc.data()?.phone;
    const senderName = data.initiated_by === 'farm' ? farm.name : market.name;
    if (recipientPhone) {
      const msgNote = data.message ? `\n\n"${data.message}"` : '';
      await sendSms({ env: app.env, to: recipientPhone, body: `FarmLink: ${senderName} wants to connect!${msgNote}\n\nReply YES to accept.` }).catch(() => null);
    }

    reply.send({ rel: { id: relId, ...rel }, sms_sent: !!recipientPhone });
  });

  // Respond to connection request
  app.post('/connect/:relId/respond', async (request, reply) => {
    const schema = z.object({ accept: z.boolean() });
    const { relId } = request.params as { relId: string };
    const { accept } = schema.parse(request.body);

    const ref = app.db.collection('farm_market_rels').doc(relId);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Connection request not found' });

    const rel = doc.data()!;
    if (rel.status !== 'pending') return reply.status(409).send({ error: 'Request already resolved' });

    await ref.update({
      status: accept ? 'active' : 'declined',
      active: accept,
      responded_at: new Date(),
    });

    // Notify requester
    const farmDoc = await app.db.collection('farms').doc(rel.farm_id).get();
    const marketDoc = await app.db.collection('markets').doc(rel.market_id).get();
    const farmUserDoc = await app.db.collection('users').doc(farmDoc.data()!.user_id).get();
    const marketUserDoc = await app.db.collection('users').doc(marketDoc.data()!.user_id).get();

    const requesterPhone = rel.initiated_by === 'farm' ? farmUserDoc.data()?.phone : marketUserDoc.data()?.phone;
    const responderName = rel.initiated_by === 'farm' ? marketDoc.data()?.name : farmDoc.data()?.name;

    if (requesterPhone && responderName) {
      const smsBody = accept
        ? `${responderName} accepted your connection request on FarmLink!`
        : `${responderName} declined your connection request on FarmLink.`;
      await sendSms({ env: app.env, to: requesterPhone, body: smsBody }).catch(() => null);
    }

    const updated = await ref.get();
    reply.send({ rel: { id: updated.id, ...updated.data() } });
  });

  // List pending requests
  app.get('/connect/pending', async (request, reply) => {
    const { farm_id, market_id } = request.query as { farm_id?: string; market_id?: string };

    let query: FirebaseFirestore.Query = app.db
      .collection('farm_market_rels')
      .where('status', '==', 'pending');

    if (farm_id) query = query.where('farm_id', '==', farm_id);
    if (market_id) query = query.where('market_id', '==', market_id);

    const snapshot = await query.get();
    const pending = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const r = doc.data();
        const farmDoc = await app.db.collection('farms').doc(r.farm_id).get();
        const marketDoc = await app.db.collection('markets').doc(r.market_id).get();
        return {
          id: doc.id,
          ...r,
          farm: farmDoc.exists ? { name: farmDoc.data()!.name, location: farmDoc.data()!.location } : null,
          market: marketDoc.exists ? { name: marketDoc.data()!.name, location: marketDoc.data()!.location, type: marketDoc.data()!.type } : null,
        };
      }),
    );

    reply.send({ pending });
  });
}
