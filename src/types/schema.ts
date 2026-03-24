import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ─── Enums ──────────────────────────────────────────────────────
export type UserRole = 'farmer' | 'market' | 'both' | 'admin';
export type MarketType = 'grocery' | 'restaurant' | 'co-op' | 'farmers_market';
export type DeliveryPref = 'pickup' | 'delivery' | 'either';
export type InventoryStatus = 'available' | 'partial' | 'reserved' | 'sold';
export type OrderStatus = 'pending' | 'confirmed' | 'in_transit' | 'delivered' | 'cancelled';
export type RecurringFrequency = 'daily' | 'twice_weekly' | 'weekly' | 'biweekly' | 'monthly';
export type DeliveryType = 'pickup' | 'delivery';
export type DeliveryStatus = 'scheduled' | 'in_transit' | 'completed' | 'failed';
export type ConversationContext = 'inventory' | 'order' | 'delivery' | 'general';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageSource = 'sms' | 'web' | 'system';
export type NotificationType = 'new_inventory' | 'price_change' | 'order_update' | 'reminder';
export type NotificationChannel = 'sms' | 'email' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';
export type FeedbackType = 'feature_request' | 'bug_report';
export type FeedbackStatus = 'open' | 'under_review' | 'planned' | 'in_progress' | 'resolved' | 'closed';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';

// ─── Table Interfaces ───────────────────────────────────────────

export interface UsersTable {
  id: Generated<string>;
  name: string;
  phone: string;
  email: string | null;
  role: UserRole;
  preferences: unknown | null;
  logo_url: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeliveryScheduleSlot {
  day: string;       // monday, tuesday, etc.
  time_window: string; // e.g. "6am-10am"
  areas?: string[];    // delivery areas/cities
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

export interface FarmsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  location: string;
  coordinates: string | null; // PostGIS point as text
  specialty: string | null;
  timezone: Generated<string>;
  active: Generated<boolean>;
  phone: string | null;
  email: string | null;
  logo_url: string | null;
  description: string | null;
  physical_address: AddressJson | null;
  billing_address: AddressJson | null;
  delivery_schedule: Generated<DeliveryScheduleSlot[]>;
  contacts: Generated<ContactJson[]>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MarketsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  location: string;
  coordinates: string | null;
  type: MarketType;
  delivery_pref: DeliveryPref;
  active: Generated<boolean>;
  phone: string | null;
  email: string | null;
  logo_url: string | null;
  description: string | null;
  physical_address: AddressJson | null;
  billing_address: AddressJson | null;
  contacts: Generated<ContactJson[]>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductsTable {
  id: Generated<string>;
  farm_id: string;
  name: string;
  category: string;
  unit: string;
  default_price: number | null;
  seasonal: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface InventoryTable {
  id: Generated<string>;
  farm_id: string;
  product_id: string;
  quantity: number;
  remaining: number;
  price: number;
  harvest_date: Date | null;
  status: Generated<InventoryStatus>;
  listed_at: Generated<Date>;
  expires_at: Date | null;
  image_url: string | null;
}

export interface FarmMarketRelsTable {
  id: Generated<string>;
  farm_id: string;
  market_id: string;
  priority: number;
  notification_delay_min: Generated<number>;
  active: Generated<boolean>;
  delivery_preferences: unknown | null;
  created_at: Generated<Date>;
}

export interface OrdersTable {
  id: Generated<string>;
  farm_id: string;
  market_id: string;
  order_number: Generated<string>;
  status: Generated<OrderStatus>;
  total: number;
  order_date: Generated<Date>;
  delivery_type: DeliveryType | null;
  scheduled_delivery_at: Date | null;
  delivery_notes: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderItemsTable {
  id: Generated<string>;
  order_id: string;
  inventory_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
}

export interface RecurringOrdersTable {
  id: Generated<string>;
  farm_id: string;
  market_id: string;
  frequency: RecurringFrequency;
  schedule_days: string; // e.g., "mon,wed,fri"
  next_delivery: Date;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface RecurringOrderItemsTable {
  id: Generated<string>;
  recurring_order_id: string;
  product_id: string;
  quantity: number;
  unit: string;
}

export interface DeliveriesTable {
  id: Generated<string>;
  order_id: string;
  type: DeliveryType;
  scheduled_at: Date;
  completed_at: Date | null;
  status: Generated<DeliveryStatus>;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  user_id: string;
  phone_number: string;
  context: Generated<ConversationContext>;
  state: unknown | null;
  last_message_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  direction: MessageDirection;
  body: string;
  source: MessageSource;
  ai_metadata: unknown | null;
  created_at: Generated<Date>;
}

export interface NotificationsTable {
  id: Generated<string>;
  market_id: string;
  inventory_id: string | null;
  order_id: string | null;
  type: NotificationType;
  channel: NotificationChannel;
  status: Generated<NotificationStatus>;
  scheduled_for: Date;
  sent_at: Date | null;
  created_at: Generated<Date>;
}

export interface FeedbackTable {
  id: Generated<string>;
  user_id: string;
  type: FeedbackType;
  status: Generated<FeedbackStatus>;
  priority: Generated<FeedbackPriority>;
  title: string;
  description: string;
  admin_notes: string | null;
  source: MessageSource;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ─── Database Interface ─────────────────────────────────────────

export interface DB {
  users: UsersTable;
  farms: FarmsTable;
  markets: MarketsTable;
  products: ProductsTable;
  inventory: InventoryTable;
  farm_market_rels: FarmMarketRelsTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  recurring_orders: RecurringOrdersTable;
  recurring_order_items: RecurringOrderItemsTable;
  deliveries: DeliveriesTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  notifications: NotificationsTable;
  feedback: FeedbackTable;
}

// ─── Convenience Types ──────────────────────────────────────────
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Farm = Selectable<FarmsTable>;
export type NewFarm = Insertable<FarmsTable>;

export type Market = Selectable<MarketsTable>;
export type NewMarket = Insertable<MarketsTable>;

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;

export type Inventory = Selectable<InventoryTable>;
export type NewInventory = Insertable<InventoryTable>;

export type Order = Selectable<OrdersTable>;
export type NewOrder = Insertable<OrdersTable>;

export type FarmMarketRel = Selectable<FarmMarketRelsTable>;
export type Notification = Selectable<NotificationsTable>;

export type Feedback = Selectable<FeedbackTable>;
export type NewFeedback = Insertable<FeedbackTable>;
export type FeedbackUpdate = Updateable<FeedbackTable>;
