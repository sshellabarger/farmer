import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
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
