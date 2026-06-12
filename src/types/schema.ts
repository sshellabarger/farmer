// Firestore document types — kept as TypeScript interfaces for reference.
// Firestore is schemaless; these define the expected shape of documents.

export type UserRole = 'farmer' | 'market' | 'both' | 'admin';

// Canonical market types — single source of truth, must stay in sync with the
// web signup form options. Older market docs may carry legacy 'co-op' (hyphen);
// normalize to 'co_op' on write, tolerate on read.
export const MARKET_TYPES = [
  'farmers_market',
  'restaurant',
  'grocery',
  'co_op',
  'food_hub',
  'food_bank',
  'food_pantry',
  'school',
  'other',
] as const;
export type MarketType = (typeof MARKET_TYPES)[number];
export type DeliveryPref = 'pickup' | 'delivery' | 'either';
export type InventoryStatus = 'available' | 'partial' | 'reserved' | 'sold';
export type OrderStatus = 'pending' | 'confirmed' | 'in_transit' | 'delivered' | 'cancelled';
export type RecurringFrequency = 'daily' | 'twice_weekly' | 'weekly' | 'biweekly' | 'monthly';
export type DeliveryType = 'pickup' | 'delivery';
export type DeliveryStatus = 'scheduled' | 'in_transit' | 'completed' | 'failed';
export type ConversationContext = 'inventory' | 'order' | 'delivery' | 'general';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageSource = 'sms' | 'web' | 'system';
export type ConnectionStatus = 'pending' | 'active' | 'declined';
export type ConnectionInitiator = 'farm' | 'market';
export type NotificationType = 'new_inventory' | 'price_change' | 'order_update' | 'reminder';
export type NotificationChannel = 'sms' | 'email' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';
export type ReminderFrequency = 'daily' | 'weekly';
export type FeedbackType = 'feature_request' | 'bug_report';
export type FeedbackStatus = 'open' | 'under_review' | 'planned' | 'in_progress' | 'resolved' | 'closed';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';

export interface DeliveryScheduleSlot {
  day: string;
  time_window: string;
  areas?: string[];
}

export interface AddressJson {
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface ContactJson {
  name: string;
  role: string;
  phone?: string;
  email?: string;
}
