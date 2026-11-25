import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let app: App | undefined;
let db: Firestore | undefined;

/** Emulator-only project id. The `demo-` prefix can never resolve to a real Firebase project. */
export const DEV_PROJECT_ID = 'demo-farmlink';

/**
 * Decide which database a process may open (handoff 05 #16: v1 had one project,
 * so `npm run dev` and `npm run seed` hit production).
 *
 *   production deploy  → the real project, and never an emulator
 *   everything else    → the local Firestore emulator only; without
 *                        FIRESTORE_EMULATOR_HOST the process refuses to start
 */
export function resolveDbTarget(env: NodeJS.ProcessEnv = process.env): { projectId?: string } {
  const emulator = env.FIRESTORE_EMULATOR_HOST;
  if (env.NODE_ENV === 'production') {
    if (emulator) throw new Error('FIRESTORE_EMULATOR_HOST is set in a production process. Remove it from the deploy environment.');
    return {};
  }
  if (!emulator) {
    throw new Error(
      'Refusing to open Firestore outside production without the emulator. ' +
        'Start it with `npm run emulators` and use `npm run dev` / `npm run seed`, which set FIRESTORE_EMULATOR_HOST.',
    );
  }
  return { projectId: DEV_PROJECT_ID };
}

export function getDb(): Firestore {
  if (!db) {
    const target = resolveDbTarget();
    app = getApps().length === 0 ? initializeApp(target) : getApps()[0];
    db = getFirestore(app);
  }
  return db;
}

export const collections = {
  users: 'users',
  farms: 'farms',
  markets: 'markets',
  products: 'products',
  inventory: 'inventory',
  farmMarketRels: 'farm_market_rels',
  orders: 'orders',
  orderItems: (orderId: string) => `orders/${orderId}/order_items`,
  recurringOrders: 'recurring_orders',
  recurringOrderItems: (roId: string) => `recurring_orders/${roId}/recurring_order_items`,
  deliveries: 'deliveries',
  conversations: 'conversations',
  messages: (convoId: string) => `conversations/${convoId}/messages`,
  notifications: 'notifications',
  feedback: 'feedback',
} as const;
