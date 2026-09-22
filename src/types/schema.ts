// Firestore document types — kept as TypeScript unions for reference.
// Firestore is schemaless; these document the expected shape, they do not
// enforce it. The ordering-domain enums (inventory, orders, deliveries,
// connections, buyer market types) were retired with v1; see tag
// farmlink-v1-final. New SJCA collections are specified in docs/SPEC.md §6.

// 'farmer', 'market' and 'both' are v1 roles that still exist on stored users
// until the D3 producers migration; they may still log in but every Phase 2
// route answers 403 for them (SPEC §6.7/§2.7). 'market_manager' is new in
// Phase 2 and is scoped to `assigned_market_ids` (src/middleware/market-scope.ts).
export type UserRole = 'admin' | 'market_manager' | 'farmer' | 'market' | 'both';

/** SPEC §2.2 market_dates.status. */
export type MarketDateStatus = 'collecting' | 'lineup_final' | 'published' | 'cancelled';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSource = 'sms' | 'web' | 'system';
export type NotificationType = 'new_inventory' | 'price_change' | 'order_update' | 'reminder';
export type NotificationChannel = 'sms' | 'email' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';
export type ReminderFrequency = 'daily' | 'weekly';
export type FeedbackType = 'feature_request' | 'bug_report';
export type FeedbackStatus = 'open' | 'under_review' | 'planned' | 'in_progress' | 'resolved' | 'closed';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';

// Phase 3 (contract §2.7): check-in workflow.
export type CheckinSource = 'form' | 'import' | 'sms';
export type LinkTokenPurpose = 'checkin';
export type WorkflowActionKey = 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts';

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
