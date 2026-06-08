import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { sendSms } from '../services/sms.js';

export async function adminRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const adminOnly = requireRole('admin');

  // ─── GET /api/admin/utilization ───
  // Returns per-user activity: messages, orders, inventory, last active
  app.get('/utilization', {
    preHandler: [auth, adminOnly],
  }, async () => {
    const usersSnap = await app.db.collection('users').get();
    const users: any[] = [];

    for (const doc of usersSnap.docs) {
      const u = doc.data();

      // Find associated farm / market
      const farmSnap = await app.db.collection('farms').where('user_id', '==', doc.id).limit(1).get();
      const marketSnap = await app.db.collection('markets').where('user_id', '==', doc.id).limit(1).get();
      const farm = farmSnap.empty ? null : { id: farmSnap.docs[0].id, ...farmSnap.docs[0].data() };
      const market = marketSnap.empty ? null : { id: marketSnap.docs[0].id, ...marketSnap.docs[0].data() };

      // Count conversations + messages for this user's phone
      let messageCount = 0;
      let lastMessageAt: any = null;
      const convSnap = await app.db.collection('conversations')
        .where('user_id', '==', doc.id).get();
      for (const convDoc of convSnap.docs) {
        const conv = convDoc.data();
        const msgSnap = await convDoc.ref.collection('messages').get();
        messageCount += msgSnap.size;
        if (conv.last_message_at) {
          const ts = conv.last_message_at?.toDate?.() || new Date(conv.last_message_at);
          if (!lastMessageAt || ts > lastMessageAt) lastMessageAt = ts;
        }
      }

      // Count orders (as farm or market)
      let orderCount = 0;
      if (farm) {
        const farmOrders = await app.db.collection('orders').where('farm_id', '==', farm.id).get();
        orderCount += farmOrders.size;
      }
      if (market) {
        const marketOrders = await app.db.collection('orders').where('market_id', '==', market.id).get();
        orderCount += marketOrders.size;
      }

      // Count inventory items (for farmers)
      let inventoryCount = 0;
      if (farm) {
        const invSnap = await app.db.collection('inventory').where('farm_id', '==', farm.id).get();
        inventoryCount = invSnap.size;
      }

      users.push({
        id: doc.id,
        name: u.name,
        email: u.email || null,
        phone: u.phone,
        role: u.role,
        farm_name: farm ? (farm as any).name : null,
        farm_id: farm ? farm.id : null,
        market_name: market ? (market as any).name : null,
        market_id: market ? market.id : null,
        message_count: messageCount,
        order_count: orderCount,
        inventory_count: inventoryCount,
        last_message_at: lastMessageAt?.toISOString?.() || lastMessageAt || null,
        created_at: u.created_at,
        updated_at: u.updated_at,
      });
    }

    // Sort: most recently active first, then by created_at
    users.sort((a, b) => {
      const aTime = a.last_message_at || a.created_at || '';
      const bTime = b.last_message_at || b.created_at || '';
      return String(bTime).localeCompare(String(aTime));
    });

    return { users, total: users.length };
  });

  // ─── GET /api/admin/users ───
  // Lightweight user list for broadcast targeting
  app.get('/users', {
    preHandler: [auth, adminOnly],
  }, async () => {
    const usersSnap = await app.db.collection('users').get();
    const users = usersSnap.docs.map(doc => {
      const u = doc.data();
      return {
        id: doc.id,
        name: u.name,
        phone: u.phone,
        role: u.role,
      };
    });
    return { users };
  });

  // ─── POST /api/admin/broadcast ───
  // Send SMS to all farmers, all markets, or all users
  app.post('/broadcast', {
    preHandler: [auth, adminOnly],
  }, async (request, reply) => {
    const schema = z.object({
      audience: z.enum(['farmers', 'markets', 'all']),
      message: z.string().min(1).max(1600),
    });

    const { audience, message } = schema.parse(request.body);

    // Gather target users
    const usersSnap = await app.db.collection('users').get();
    const targets = usersSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((u: any) => {
        if (u.role === 'admin') return false; // don't message admins
        if (audience === 'all') return true;
        if (audience === 'farmers') return u.role === 'farmer' || u.role === 'both';
        if (audience === 'markets') return u.role === 'market' || u.role === 'both';
        return false;
      })
      .filter((u: any) => !!u.phone); // must have phone number

    const results: { phone: string; name: string; status: 'sent' | 'failed'; error?: string }[] = [];

    for (const user of targets as any[]) {
      try {
        await sendSms({ env: app.env, to: user.phone, body: message });
        results.push({ phone: user.phone, name: user.name, status: 'sent' });
      } catch (err: any) {
        app.log.error({ err, phone: user.phone }, 'Broadcast SMS failed');
        results.push({ phone: user.phone, name: user.name, status: 'failed', error: err.message });
      }
    }

    // Log broadcast for audit
    const { v4: uuid } = await import('uuid');
    await app.db.collection('admin_broadcasts').doc(uuid()).set({
      admin_user_id: request.authUser!.id,
      audience,
      message,
      recipient_count: targets.length,
      sent_count: results.filter(r => r.status === 'sent').length,
      failed_count: results.filter(r => r.status === 'failed').length,
      created_at: new Date(),
    });

    return {
      success: true,
      audience,
      total: targets.length,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    };
  });

  // ─── GET /api/admin/broadcasts ───
  // Audit log of past broadcasts
  app.get('/broadcasts', {
    preHandler: [auth, adminOnly],
  }, async () => {
    const snap = await app.db.collection('admin_broadcasts')
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();

    const broadcasts = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return { broadcasts };
  });
}
