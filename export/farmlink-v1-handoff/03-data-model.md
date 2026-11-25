# 03 — v1 data model (Firestore)

Field names and types from the pre-deletion snapshot of 2026-09-20. Counts are pilot
documents. No values are included. Ids are uuid v4; field names are snake_case.

## Identity

**`users`** (5): `name`, `phone` (E.164, the identity key), `email`, `role`
(`farmer | market | both | admin`), `logo_url`, `fcm_tokens[]`, `created_at`, `updated_at`.
The admin role was set by hand in Firestore; no API assigns it.

**`otps`** (transient): doc id = phone; `code` (plain text, `Math.random`), `expires_at`
(5 min). No attempt limit. Any 6-digit code works outside production.

## Sellers and buyers

**`farms`** (2): `user_id`, `name`, `phone`, `email`, `location`, `specialty`,
`description`, `logo_url`, `physical_address`, `billing_address` (`{street, city, state,
zip, country}`), `contacts[]` (`{name, role, phone?, email?}`), `delivery_schedule[]`
(`{day, time_window, areas?}`), `timezone` (never read), `active`.

**`markets`** = buyers (2): `user_id`, `name`, `type` (`farmers_market | restaurant |
grocery | co_op | food_hub | food_bank | food_pantry | school | other`), `phone`, `email`,
`location`, `contacts[]`, `delivery_pref` (`pickup | delivery | either`), `active`.

**`farm_market_rels`** = connections (3): `farm_id`, `market_id`, `status` (`pending |
active | declined`), `initiated_by` (`farm | market`), `request_message`, `responded_at`,
`priority` (lower is notified first), `notification_delay_min`, `active`.

## Catalog and stock

**`products`** = a farm's price list (12): `farm_id`, `name`, `category`, `unit` (lb,
bunch, pint, dozen…), `default_price`, `seasonal`, `image_url`.

**`inventory`** = a harvest lot (20): `farm_id`, `product_id`, `quantity`, `remaining`,
`price`, `harvest_date`, `listed_at`, `status` (`available | partial | reserved | sold`),
`image_url`.

## Orders

**`orders`** (4): `order_number` (`ORD-XXXXXXXX`), `farm_id`, `market_id`, `status`
(`pending | confirmed | in_transit | delivered | cancelled`), `delivery_type`
(`pickup | delivery`), `order_date`, `scheduled_delivery_at`, `total`, `notes`.
Subcollection **`order_items`** (6): `inventory_id`, `product_name`, `quantity`, `unit`,
`unit_price`, `line_total`.

**`recurring_orders`** (0): farm, market, `frequency` (`daily | twice_weekly | weekly |
biweekly | monthly`), `schedule_days`, `active`. Subcollection `recurring_order_items`.

**`deliveries`** (0): status `scheduled | in_transit | completed | failed`.

## Messaging

**`conversations`** (5): `user_id`, `phone_number`, `context` (`inventory | order |
delivery | general`), `last_message_at`. Subcollection **`messages`** (270): `direction`
(`inbound | outbound`), `source` (`sms | web | system`), `body`, `ai_metadata` (tool calls,
tokens).

**`notifications`** (119): `type` (`new_inventory | price_change | order_update |
reminder`), `channel` (`sms | email | push`), `status` (`pending | sent | delivered |
failed`), `user_id`, `farm_id`, `market_id`, `inventory_id`, `order_id`, `reminder_id`,
`scheduled_for`, `sent_at`. It stores neither the body nor the phone. **v1 had no real
send log.**

**`reminders`** (6): `user_id`, `title`, `frequency` (`daily | weekly`), `schedule_days`,
`time`, `last_sent_date`, `active`.

**`admin_broadcasts`** (0): audit of admin bulk texts.

## Links and misc

**`view_links`** (8): `userId`, `role`, `tab`, `expires_at` (24 h; never cleaned up).
**`upload_links`** (5): `inventory_id`, `product_name`, `expires_at`.
**`invites`** (4): `invited_by`, `invited_name`, `invited_phone`, `inviter_business`.
**`feedback`** (10): `user_id`, `type` (`feature_request | bug_report`), `title`,
`description`, `priority` (`low | medium | high | critical`), `status`, `admin_notes`,
`resolution`, `source`.
**`error_alerts`** (2): `last_seen_at`, `last_sent_at`, `suppressed`.

## Relationships

```
users 1─1 farms ─┐                ┌─ markets 1─1 users
                 ├─ farm_market_rels (priority, delay) ─┤
farms 1─* products 1─* inventory ──── order_items *─1 orders *─1 markets
farms 1─* recurring_orders *─1 markets
users 1─* conversations 1─* messages;  users 1─* reminders;  users 1─* feedback
```
