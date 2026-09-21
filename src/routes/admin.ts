import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { selectSmsProvider, trySendSms } from '../services/sms.js';

export async function adminRoutes(app: FastifyInstance) {
  const auth = authenticate(app);
  const adminOnly = requireRole('admin');

  // ─── GET /api/admin/utilization ───
  // Per-user activity. The v1 order/inventory/conversation counters are gone;
  // what remains is the user list with opt-out state, sorted newest first.
  app.get('/utilization', {
    preHandler: [auth, adminOnly],
  }, async () => {
    const usersSnap = await app.db.collection('users').get();
    const users = usersSnap.docs.map((doc) => {
      const u = doc.data();
      return {
        id: doc.id,
        name: u.name,
        email: u.email || null,
        phone: u.phone,
        role: u.role,
        sms_opt_out_at: u.sms_opt_out_at || null,
        created_at: u.created_at,
        updated_at: u.updated_at,
      };
    });

    users.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return { users, total: users.length };
  });

  // ─── GET /api/admin/providers ───
  // Which send providers this deployment is wired to (SPEC §7.3). The web
  // dashboard shows a "Test mode" banner when real_sends_possible is false;
  // after a production deploy this is the first smoke check.
  app.get('/providers', {
    preHandler: [auth, adminOnly],
  }, async () => {
    let real_sends_possible = false;
    try {
      real_sends_possible = selectSmsProvider(app.env) === 'voipms';
    } catch {
      real_sends_possible = false;
    }
    return {
      sms_provider: app.env.SMS_PROVIDER,
      email_provider: app.env.EMAIL_PROVIDER,
      allow_real_sends: app.env.ALLOW_REAL_SENDS === 'true',
      node_env: app.env.NODE_ENV,
      real_sends_possible,
    };
  });

  // ─── POST /api/admin/broadcast ───
  // Text every non-admin user in the audience. Opted-out users are skipped
  // and every send is logged to `messages` (kind: 'broadcast') by sendSms.
  app.post('/broadcast', {
    preHandler: [auth, adminOnly],
  }, async (request) => {
    const schema = z.object({
      audience: z.enum(['farmers', 'markets', 'all']),
      message: z.string().min(1).max(1600),
    });

    const { audience, message } = schema.parse(request.body);
    const broadcastId = uuid();

    // Gather target users
    const usersSnap = await app.db.collection('users').get();
    const candidates = usersSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((u: any) => {
        if (u.role === 'admin') return false; // don't message admins
        if (audience === 'all') return true;
        if (audience === 'farmers') return u.role === 'farmer' || u.role === 'both';
        if (audience === 'markets') return u.role === 'market' || u.role === 'both';
        return false;
      })
      .filter((u: any) => !!u.phone); // must have phone number

    const targets = candidates.filter((u: any) => !u.sms_opt_out_at);
    const skipped = candidates.length - targets.length;

    const results: { phone: string; name: string; status: 'sent' | 'simulated' | 'failed'; error?: string }[] = [];

    for (const user of targets as any[]) {
      const result = await trySendSms({
        db: app.db,
        env: app.env,
        to: user.phone,
        body: message,
        kind: 'broadcast',
        user_id: user.id,
        sent_by: request.authUser!.id,
        extra: { broadcast_id: broadcastId },
      });
      if (result.ok) {
        results.push({ phone: user.phone, name: user.name, status: result.status });
      } else {
        app.log.error({ phone: user.phone, error: result.error }, 'Broadcast SMS failed');
        results.push({ phone: user.phone, name: user.name, status: 'failed', error: result.error });
      }
    }

    // Log broadcast for audit. A simulated send (console provider) counts as
    // sent here: the summary is about the loop, the per-row truth is in `messages`.
    const sent = results.filter(r => r.status !== 'failed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    await app.db.collection('admin_broadcasts').doc(broadcastId).set({
      admin_user_id: request.authUser!.id,
      audience,
      message,
      recipient_count: targets.length,
      skipped_opted_out: skipped,
      sent_count: sent,
      failed_count: failed,
      created_at: new Date(),
    });

    return {
      success: true,
      audience,
      total: targets.length,
      skipped_opted_out: skipped,
      sent,
      failed,
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
