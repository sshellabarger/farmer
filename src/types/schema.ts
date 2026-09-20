// Firestore document types — kept as TypeScript unions for reference.
// Firestore is schemaless; these document the expected shape, they do not
// enforce it. The ordering-domain enums (inventory, orders, deliveries,
// connections, buyer market types) were retired with v1; see tag
// farmlink-v1-final. New SJCA collections are specified in docs/SPEC.md §6.

// 'market' and 'both' are v1 buyer roles that still exist on stored users
// until the D3 producers migration; no new user gets them.
export type UserRole = 'farmer' | 'market' | 'both' | 'admin';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSource = 'sms' | 'web' | 'system';
export type NotificationType = 'new_inventory' | 'price_change' | 'order_update' | 'reminder';
export type NotificationChannel = 'sms' | 'email' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';
export type ReminderFrequency = 'daily' | 'weekly';
export type FeedbackType = 'feature_request' | 'bug_report';
export type FeedbackStatus = 'open' | 'under_review' | 'planned' | 'in_progress' | 'resolved' | 'closed';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';

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
