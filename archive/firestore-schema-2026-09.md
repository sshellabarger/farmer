# Firestore schema snapshot — arkansaslocalfoodnetwork (default)

Generated 2026-09-20T22:52:34.979Z during SJCA rework Phase 1, before any deletion. Field names and types only; no document values.

## users

- documents: **5** (seed-signature: 0, real: 5)

| field | type |
|---|---|
| `created_at` | timestamp |
| `email` | string|null |
| `fcm_tokens` | array |
| `logo_url` | string |
| `name` | string |
| `phone` | string |
| `role` | string |
| `updated_at` | timestamp |

## farms

- documents: **2** (seed-signature: 0, real: 2)

| field | type |
|---|---|
| `active` | boolean |
| `billing_address` | null |
| `contacts` | array |
| `created_at` | timestamp |
| `delivery_schedule` | array |
| `description` | null |
| `email` | string |
| `location` | string |
| `logo_url` | string |
| `name` | string |
| `phone` | string |
| `physical_address` | null |
| `specialty` | string |
| `timezone` | string |
| `updated_at` | timestamp |
| `user_id` | string |

## markets

- documents: **2** (seed-signature: 0, real: 2)

| field | type |
|---|---|
| `active` | boolean |
| `contacts` | array |
| `created_at` | timestamp |
| `delivery_pref` | string |
| `email` | string |
| `location` | string |
| `name` | string |
| `phone` | string |
| `type` | string |
| `updated_at` | timestamp |
| `user_id` | string |

## products

- documents: **12** (seed-signature: 0, real: 12)

| field | type |
|---|---|
| `category` | string |
| `created_at` | timestamp |
| `default_price` | number |
| `farm_id` | string |
| `image_url` | string |
| `name` | string |
| `seasonal` | boolean |
| `unit` | string |

## inventory

- documents: **20** (seed-signature: 0, real: 20)

| field | type |
|---|---|
| `farm_id` | string |
| `harvest_date` | timestamp |
| `image_url` | string |
| `listed_at` | timestamp |
| `price` | number |
| `product_id` | string |
| `quantity` | number |
| `remaining` | number |
| `status` | string |

## farm_market_rels

- documents: **3** (seed-signature: 0, real: 3)

| field | type |
|---|---|
| `active` | boolean |
| `created_at` | timestamp |
| `farm_id` | string |
| `initiated_by` | string |
| `market_id` | string |
| `notification_delay_min` | number |
| `priority` | number |
| `request_message` | null|string |
| `responded_at` | timestamp |
| `status` | string |

## orders

- documents: **4** (seed-signature: 0, real: 4)

| field | type |
|---|---|
| `created_at` | timestamp |
| `delivery_type` | string |
| `farm_id` | string |
| `market_id` | string |
| `notes` | null |
| `order_date` | timestamp |
| `order_number` | string |
| `scheduled_delivery_at` | null |
| `status` | string |
| `total` | number |
| `updated_at` | timestamp |

## recurring_orders

- documents: **0** (seed-signature: 0, real: 0)

| field | type |
|---|---|


## deliveries

- documents: **0** (seed-signature: 0, real: 0)

| field | type |
|---|---|


## conversations

- documents: **5** (seed-signature: 0, real: 5)

| field | type |
|---|---|
| `context` | string |
| `created_at` | timestamp |
| `last_message_at` | timestamp |
| `phone_number` | string |
| `user_id` | string |

## notifications

- documents: **119** (seed-signature: 0, real: 119)

| field | type |
|---|---|
| `channel` | string |
| `created_at` | timestamp |
| `farm_id` | string |
| `inventory_id` | string |
| `market_id` | string |
| `order_id` | string |
| `reminder_id` | string |
| `scheduled_for` | timestamp |
| `sent_at` | timestamp |
| `status` | string |
| `type` | string |
| `user_id` | string |

## feedback

- documents: **10** (seed-signature: 0, real: 10)

| field | type |
|---|---|
| `admin_notes` | null|string |
| `created_at` | timestamp |
| `description` | string |
| `priority` | string |
| `resolution` | string |
| `source` | string |
| `status` | string |
| `title` | string |
| `type` | string |
| `updated_at` | timestamp |
| `user_id` | string |

## reminders

- documents: **6** (seed-signature: 0, real: 6)

| field | type |
|---|---|
| `active` | boolean |
| `created_at` | timestamp |
| `frequency` | string |
| `last_sent_date` | string |
| `schedule_days` | string |
| `time` | string |
| `title` | string |
| `updated_at` | timestamp |
| `user_id` | string |

## otps

- documents: **0** (seed-signature: 0, real: 0)

| field | type |
|---|---|


## view_links

- documents: **8** (seed-signature: 0, real: 8)

| field | type |
|---|---|
| `created_at` | timestamp |
| `expires_at` | timestamp |
| `role` | string |
| `tab` | string |
| `userId` | string |

## upload_links

- documents: **5** (seed-signature: 0, real: 5)

| field | type |
|---|---|
| `created_at` | timestamp |
| `expires_at` | timestamp |
| `inventory_id` | string |
| `product_name` | string |

## invites

- documents: **4** (seed-signature: 0, real: 4)

| field | type |
|---|---|
| `created_at` | timestamp |
| `invited_by` | string |
| `invited_name` | string |
| `invited_phone` | string |
| `inviter_business` | string |

## admin_broadcasts

- documents: **0** (seed-signature: 0, real: 0)

| field | type |
|---|---|


## error_alerts

- documents: **2** (seed-signature: 0, real: 2)

| field | type |
|---|---|
| `last_seen_at` | timestamp |
| `last_sent_at` | timestamp |
| `suppressed` | number |

## (subcollection) order_items

- documents: **6**

| field | type |
|---|---|
| `inventory_id` | string |
| `line_total` | number |
| `product_name` | string |
| `quantity` | number |
| `unit` | string |
| `unit_price` | number |

## (subcollection) recurring_order_items

- documents: **0**

| field | type |
|---|---|


## (subcollection) messages

- documents: **270**

| field | type |
|---|---|
| `ai_metadata` | object |
| `body` | string |
| `created_at` | timestamp |
| `direction` | string |
| `source` | string |

## users breakdown

```json
{
  "total": 5,
  "by_role": {
    "market": 2,
    "admin": 1,
    "<UNKNOWN>": 1,
    "farmer": 1
  },
  "real_e164_phone": 5,
  "seed": 0,
  "shadow_market_placeholder": 0,
  "missing_or_malformed_phone": 0,
  "opted_out": 0
}
```
