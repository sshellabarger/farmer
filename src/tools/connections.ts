import type { ToolContext } from './index.js';
import { sendSms } from '../services/sms.js';
import { v4 as uuid } from 'uuid';

export async function directorySearch(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const type = input.type as 'farms' | 'markets';
  const search = input.search as string | undefined;

  if (type === 'farms') {
    const snapshot = await db.collection('farms').where('active', '==', true).orderBy('name').get();
    let farms = snapshot.docs.map((d) => ({ id: d.id, name: d.data().name, location: d.data().location, specialty: d.data().specialty }));
    if (search) {
      const s = search.toLowerCase();
      farms = farms.filter((f) => f.name?.toLowerCase().includes(s) || f.location?.toLowerCase().includes(s) || f.specialty?.toLowerCase().includes(s));
    }
    return { farms: farms.slice(0, 10) };
  }

  const snapshot = await db.collection('markets').where('active', '==', true).orderBy('name').get();
  let markets = snapshot.docs.map((d) => ({ id: d.id, name: d.data().name, location: d.data().location, type: d.data().type }));
  if (search) {
    const s = search.toLowerCase();
    markets = markets.filter((m) => m.name?.toLowerCase().includes(s) || m.location?.toLowerCase().includes(s));
  }
  return { markets: markets.slice(0, 10) };
}

export async function connectionRequest(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;
  const farmId = input.farm_id as string;
  const marketId = input.market_id as string;
  const message = input.message as string | undefined;

  const userDoc = userId ? await db.collection('users').doc(userId).get() : null;
  const initiatedBy = userDoc?.data()?.role === 'market' ? 'market' : 'farm';

  const farmDoc = await db.collection('farms').doc(farmId).get();
  const marketDoc = await db.collection('markets').doc(marketId).get();
  if (!farmDoc.exists || !marketDoc.exists) return { error: 'Farm or market not found.' };

  const farm = farmDoc.data()!;
  const market = marketDoc.data()!;
  const farmUserDoc = await db.collection('users').doc(farm.user_id).get();
  const marketUserDoc = await db.collection('users').doc(market.user_id).get();

  const existingSnap = await db.collection('farm_market_rels')
    .where('farm_id', '==', farmId).where('market_id', '==', marketId).limit(1).get();

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0].data();
    if (existing.status === 'active') return { error: 'Already connected.' };
    if (existing.status === 'pending') return { error: 'A connection request is already pending.' };

    await existingSnap.docs[0].ref.update({ status: 'pending', initiated_by: initiatedBy, request_message: message ?? null, responded_at: null });

    const recipientPhone = initiatedBy === 'farm' ? marketUserDoc.data()?.phone : farmUserDoc.data()?.phone;
    const senderName = initiatedBy === 'farm' ? farm.name : market.name;
    if (recipientPhone) {
      const msgNote = message ? `\n\n"${message}"` : '';
      await sendSms({ env, to: recipientPhone, body: `FarmLink: ${senderName} wants to connect!${msgNote}\n\nReply YES to accept.` }).catch(() => null);
    }
    return { success: true, rel_id: existingSnap.docs[0].id, message: `Connection request re-sent.` };
  }

  const relId = uuid();
  await db.collection('farm_market_rels').doc(relId).set({
    farm_id: farmId, market_id: marketId, priority: 50, notification_delay_min: 0,
    active: false, status: 'pending', initiated_by: initiatedBy, request_message: message ?? null,
    responded_at: null, created_at: new Date(),
  });

  const recipientPhone = initiatedBy === 'farm' ? marketUserDoc.data()?.phone : farmUserDoc.data()?.phone;
  const senderName = initiatedBy === 'farm' ? farm.name : market.name;
  if (recipientPhone) {
    const msgNote = message ? `\n\n"${message}"` : '';
    await sendSms({ env, to: recipientPhone, body: `FarmLink: ${senderName} wants to connect!${msgNote}\n\nReply YES to accept.` }).catch(() => null);
  }

  return { success: true, rel_id: relId, message: `Connection request sent to ${initiatedBy === 'farm' ? market.name : farm.name}.` };
}

export async function connectionRespond(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env } = ctx;
  const relId = input.rel_id as string;
  const accept = input.accept as boolean;

  const ref = db.collection('farm_market_rels').doc(relId);
  const doc = await ref.get();
  if (!doc.exists) return { error: 'Connection request not found.' };

  const rel = doc.data()!;
  if (rel.status !== 'pending') return { error: 'This request has already been resolved.' };

  await ref.update({ status: accept ? 'active' : 'declined', active: accept, responded_at: new Date() });

  const farmDoc = await db.collection('farms').doc(rel.farm_id).get();
  const marketDoc = await db.collection('markets').doc(rel.market_id).get();
  const farmUserDoc = await db.collection('users').doc(farmDoc.data()!.user_id).get();
  const marketUserDoc = await db.collection('users').doc(marketDoc.data()!.user_id).get();

  const requesterPhone = rel.initiated_by === 'farm' ? farmUserDoc.data()?.phone : marketUserDoc.data()?.phone;
  const responderName = rel.initiated_by === 'farm' ? marketDoc.data()?.name : farmDoc.data()?.name;

  if (requesterPhone && responderName) {
    const smsBody = accept
      ? `${responderName} accepted your connection on FarmLink!`
      : `${responderName} declined your connection request.`;
    await sendSms({ env, to: requesterPhone, body: smsBody }).catch(() => null);
  }

  return {
    success: true,
    status: accept ? 'active' : 'declined',
    message: accept ? `Connected! ${responderName} has been notified.` : `Declined.`,
  };
}

export async function pendingConnections(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) return { pending: [] };

  const userDoc = await db.collection('users').doc(userId).get();
  const role = userDoc.data()?.role;

  const farmSnap = (role === 'farmer' || role === 'both')
    ? await db.collection('farms').where('user_id', '==', userId).limit(1).get()
    : null;
  const marketSnap = (role === 'market' || role === 'both')
    ? await db.collection('markets').where('user_id', '==', userId).limit(1).get()
    : null;

  const farmId = farmSnap && !farmSnap.empty ? farmSnap.docs[0].id : null;
  const marketId = marketSnap && !marketSnap.empty ? marketSnap.docs[0].id : null;

  const results: any[] = [];

  if (farmId) {
    const snap = await db.collection('farm_market_rels').where('farm_id', '==', farmId).where('status', '==', 'pending').get();
    for (const d of snap.docs) {
      const r = d.data();
      const mDoc = await db.collection('markets').doc(r.market_id).get();
      results.push({ rel_id: d.id, farm: { name: farmSnap!.docs[0].data().name }, market: { name: mDoc.data()?.name, location: mDoc.data()?.location }, initiated_by: r.initiated_by, message: r.request_message });
    }
  }
  if (marketId) {
    const snap = await db.collection('farm_market_rels').where('market_id', '==', marketId).where('status', '==', 'pending').get();
    for (const d of snap.docs) {
      const r = d.data();
      const fDoc = await db.collection('farms').doc(r.farm_id).get();
      results.push({ rel_id: d.id, farm: { name: fDoc.data()?.name, location: fDoc.data()?.location }, market: { name: marketSnap!.docs[0].data().name }, initiated_by: r.initiated_by, message: r.request_message });
    }
  }

  return { pending: results };
}
