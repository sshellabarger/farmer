import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let app: App | undefined;
let db: Firestore | undefined;

export function getDb(): Firestore {
  if (!db) {
    if (getApps().length === 0) {
      app = initializeApp();
    } else {
      app = getApps()[0];
    }
    db = getFirestore(app);
  }
  return db;
}

/**
 * Top-level collections the application still reads or writes after the
 * Phase 1 code retirement. Documentation, not enforcement — code uses
 * `.collection('…')` literals. The v1 ordering collections (markets,
 * products, inventory, farm_market_rels, orders, recurring_orders,
 * deliveries, upload_links, conversations) are no longer referenced by code
 * and are exported + deleted in the Phase 1 data step (SPEC §4.5).
 */
export const collections = {
  /** Admin/login accounts. `farms` and `users` stay untouched until the D3 producers migration. */
  users: 'users',
  farms: 'farms',
  otps: 'otps',
  reminders: 'reminders',
  feedback: 'feedback',
  invites: 'invites',
  admin_broadcasts: 'admin_broadcasts',
  error_alerts: 'error_alerts',
  /** Every text sent or received, from Phase 1 on (SPEC §7.2). */
  messages: 'messages',
  /** v1 audit rows; reminders.ts still writes here. Data exists until Phase 1 data deletion. */
  notifications: 'notifications',
  /** v1 view-link tokens; no longer written. Data exists until Phase 1 data deletion. */
  view_links: 'view_links',
} as const;
