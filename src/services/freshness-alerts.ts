import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { sendSms } from './sms.js';
import { classifyFreshness } from '../utils/freshness.js';

/**
 * Daily freshness sweep: finds inventory that is aging (sell/discount soon)
 * or past its estimated shelf life (donate/compost), and texts each farmer
 * a summary for their farm. Only items with stock remaining are considered.
 */
export async function sendFreshnessAlerts(db: Firestore, env: Env): Promise<{ farmsAlerted: number; agingItems: number; pastItems: number }> {
  const invSnap = await db.collection('inventory').get();

  // farm_id → { aging: string[], past: string[] }
  const byFarm = new Map<string, { aging: string[]; past: string[] }>();
  let agingItems = 0;
  let pastItems = 0;

  for (const doc of invSnap.docs) {
    const inv = doc.data();
    if (!['available', 'partial'].includes(inv.status)) continue;
    if (!inv.remaining || inv.remaining <= 0) continue;

    const productDoc = await db.collection('products').doc(inv.product_id).get();
    const product = productDoc.data() || {};
    const f = classifyFreshness(inv.harvest_date, product.category, product.name);
    if (!f || f.freshness === 'fresh') continue;

    const entry = byFarm.get(inv.farm_id) || { aging: [], past: [] };
    const line = `${inv.remaining} ${product.unit || ''} ${product.name || 'item'} (${f.age_days}d old, ~${f.shelf_life_days}d shelf life)`.replace(/\s+/g, ' ');
    if (f.freshness === 'past') {
      entry.past.push(line);
      pastItems++;
    } else {
      entry.aging.push(line);
      agingItems++;
    }
    byFarm.set(inv.farm_id, entry);
  }

  let farmsAlerted = 0;
  for (const [farmId, { aging, past }] of byFarm) {
    const farmDoc = await db.collection('farms').doc(farmId).get();
    if (!farmDoc.exists) continue;
    const farm = farmDoc.data()!;
    const userDoc = await db.collection('users').doc(farm.user_id).get();
    const phone = userDoc.data()?.phone;
    if (!phone) continue;

    const parts: string[] = ['🥬 FarmLink freshness check:'];
    if (past.length > 0) {
      parts.push(`\nPast shelf life — donate or compost:\n• ${past.slice(0, 5).join('\n• ')}${past.length > 5 ? `\n…and ${past.length - 5} more` : ''}`);
    }
    if (aging.length > 0) {
      parts.push(`\nAging — sell or discount soon:\n• ${aging.slice(0, 5).join('\n• ')}${aging.length > 5 ? `\n…and ${aging.length - 5} more` : ''}`);
    }
    parts.push('\nUpdate inventory on your dashboard or reply here.');

    await sendSms({ env, to: phone, body: parts.join('\n') }).catch(() => null);
    farmsAlerted++;
  }

  return { farmsAlerted, agingItems, pastItems };
}
