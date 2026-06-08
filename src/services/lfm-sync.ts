import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';

// Local Food Marketplace (ALFN) availability sync.
//
// Goal: let a farmer push their currently-available FarmLink inventory to their
// Local Food Marketplace storefront (littlerock.localfoodmarketplace.com)
// instead of adding/updating/deleting products by hand in the LFM admin.
//
// Status: LFM's documented key-based API is reporting-oriented (pull data OUT).
// Writing availability IN likely needs an approved-partner / write endpoint.
// Until the exact path + payload are confirmed with LFM's integration team,
// this service runs in DRY-RUN mode when LFM_API_BASE / LFM_API_KEY are unset:
// it returns exactly what would be synced without making any external call.
// Once the write endpoint is confirmed, set the env vars and adjust the
// `payload` / URL in syncFarmToLfm — the rest of the wiring is ready.

const REQUEST_TIMEOUT_MS = 15000;

export interface LfmSyncItem {
  inventory_id: string;
  product_name: string;
  category: string;
  quantity: number;
  unit: string;
  price: number;
}

export interface LfmSyncResult {
  configured: boolean;
  pushed: boolean;
  farm_id: string;
  market_id: string | null;
  item_count: number;
  items: LfmSyncItem[];
  message: string;
}

// Collect a farm's currently-available inventory, shaped for LFM. Only items
// that are `available` with remaining stock above zero are included.
export async function collectAvailableForLfm(db: Firestore, farmId: string): Promise<LfmSyncItem[]> {
  const snap = await db
    .collection('inventory')
    .where('farm_id', '==', farmId)
    .where('status', '==', 'available')
    .get();

  const items = await Promise.all(
    snap.docs.map(async (doc) => {
      const inv = doc.data();
      const remaining = Number(inv.remaining ?? inv.quantity ?? 0);
      if (remaining <= 0) return null;

      const productDoc = await db.collection('products').doc(inv.product_id).get();
      const product = productDoc.data() || {};

      return {
        inventory_id: doc.id,
        product_name: product.name || 'Unknown',
        category: product.category || '',
        quantity: remaining,
        unit: product.unit || '',
        price: Number(inv.price ?? 0),
      } as LfmSyncItem;
    }),
  );

  return items.filter((x): x is LfmSyncItem => x !== null);
}

export async function syncFarmToLfm({
  db,
  env,
  farmId,
}: {
  db: Firestore;
  env: Env;
  farmId: string;
}): Promise<LfmSyncResult> {
  const items = await collectAvailableForLfm(db, farmId);
  const configured = Boolean(env.LFM_API_BASE && env.LFM_API_KEY);

  const base: LfmSyncResult = {
    configured,
    pushed: false,
    farm_id: farmId,
    market_id: env.LFM_MARKET_ID || null,
    item_count: items.length,
    items,
    message: '',
  };

  if (!configured) {
    return {
      ...base,
      message:
        `Dry run: ${items.length} available item(s) ready to sync to Local Food Marketplace. ` +
        `Live push is off — set LFM_API_BASE, LFM_API_KEY (and LFM_MARKET_ID) once a write endpoint is confirmed.`,
    };
  }

  // ── Live push ────────────────────────────────────────────────────────────
  // Payload + endpoint are a best guess; confirm with LFM's integration team
  // (info@localfoodmarketplace.com) and adjust field names / path as needed.
  const payload = {
    market_id: env.LFM_MARKET_ID || undefined,
    products: items.map((i) => ({
      name: i.product_name,
      category: i.category,
      quantity: i.quantity,
      unit: i.unit,
      producer_price: i.price,
    })),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.LFM_API_BASE.replace(/\/$/, '')}/availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LFM_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LFM sync failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    return {
      ...base,
      pushed: true,
      message: `Synced ${items.length} available item(s) to Local Food Marketplace.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
