# 01 — What FarmLink v1 does

## People

| Role | Who | How they use it |
|---|---|---|
| `farmer` | A producer selling harvest | Texts inventory, prices and photos; gets order texts; drops orders off at the depot |
| `market` | Any **buyer**: restaurant, grocery, co-op, food hub, food bank, food pantry, school, farmers market, other | Gets new-inventory texts, orders by text or web, picks up at the depot |
| `both` | Someone who grows and buys | Both of the above |
| `admin` | Platform staff | Web dashboard: users, utilization, broadcast texts, feedback queue |

"Market" in v1 means **buyer**, not a farmers market. That naming confused everyone. Use
"buyer" (or Square's "customer") in the rebuild.

## Principle

**Text is the primary interface.** Every other surface (web, email, push) should push
people back toward the text thread. A farmer should never need to open a browser to sell.

## Core flows

1. **Sign-up.** Web form (`/signup`) or by text. It creates a `users` row plus a `farms`
   or `markets` profile. Phone number is the identity.
2. **Login.** Phone OTP (6 digits, `otps` collection) → HS256 JWT, 7-day expiry.
3. **List inventory by text.** The farmer texts what they have. The AI calls
   `inventory_add` (product, quantity, unit, price, category, harvest date). It creates
   the product in the farm's price list if new, then offers a photo: reuse the one on
   file, generate one with AI (never worked; Vertex AI wasn't enabled) or upload via a
   one-time link (`upload_links`, page `/upload-photo`).
4. **Notify buyers in priority order.** `notify_markets` texts each connected buyer.
   Connections (`farm_market_rels`) carry a `priority` and a `notification_delay_min`, so
   a farm's best customers hear first and others N minutes later. Rows go to
   `notifications`.
5. **Order.** A buyer texts or uses the web. `order_create` reserves inventory
   (`remaining` drops; status `available → partial → sold`), writes `orders` +
   `order_items`, and texts both sides. Order numbers are `ORD-XXXXXXXX`.
6. **Order lifecycle.** `pending → confirmed → in_transit → delivered` (or `cancelled`).
   Every change texts the other party (`order-notifications.ts`).
7. **Central depot logistics.** No farm-to-buyer delivery. Farmers drop off at the
   FarmLink Depot (Little Rock, Rodney Parham Rd) on their drop-off schedule
   (`delivery_schedule_set`: day + time window). Buyers pick up there. Confirmations
   always include the depot address and the delivery day/window.
8. **Standing orders.** `recurring_orders` (daily, twice weekly, weekly, biweekly,
   monthly). The nightly `processRecurringOrders` job (00:00 Central) creates the day's
   orders. There were no live standing orders in the pilot.
9. **Freshness alerts.** A daily 07:00 Central job estimates shelf life from category and
   name (fresh under 60 % of shelf life, aging 60–100 %, past beyond). It texts farmers
   about aging and past stock ("donate or compost").
10. **Connections and directory.** Farms and buyers browse each other (`/api/directory`),
    request a connection, and accept or decline it. `farm_market_rels.status`:
    `pending | active | declined`.
11. **Reminders.** A user sets a recurring text reminder (daily/weekly, days, time). Runs
    every 15 minutes. This was the most-used feature in the pilot.
12. **Feedback.** Bug reports and feature requests by text or web, with an admin triage
    queue (`open → under_review → planned → in_progress → resolved/closed`).
13. **Invites.** A user invites someone by phone, who gets a welcome text.
14. **Admin broadcast.** Admin texts every user (or a role) with a confirmation step,
    logged to `admin_broadcasts`.
15. **Analytics.** Per-farm revenue, top products and order counts (`analytics_summary`,
    `/api/analytics`).
16. **Local Food Marketplace sync (dry-run only).** A planned push of a farm's available
    inventory to the ALFN Local Food Marketplace storefront. LFM's API is read-only, so
    this never went live.
17. **Error alerts.** 5xx errors email and text the operator. Claude drafts a diagnosis;
    `error_alerts` suppresses repeats.

## The AI assistant (`src/services/conversation.ts`)

- Model `claude-sonnet-4-6`, tool calling, conversation history per phone in
  `conversations/{id}/messages` (270 messages in the pilot).
- The system prompt sets a warm, short SMS style, proactive next steps and the depot rules.
  It adds date handling: resolve "the 14th" against today, never a prior year, and confirm
  harvest dates more than about 2 weeks ago. A wrong-year bug was fixed in the last v1 commit.
- A hallucination guard checks that a claimed action actually ran a mutating tool.
- **28 tools:** `user_signup`, `inventory_add`, `produce_photo`, `inventory_clear_all`,
  `inventory_update`, `inventory_query`, `order_create`, `order_update`, `order_query`,
  `market_query`, `notify_markets`, `recurring_order_create`, `recurring_order_update`,
  `delivery_schedule_set`, `delivery_query`, `analytics_summary`, `directory_search`,
  `connection_request`, `connection_respond`, `pending_connections`, `view_link`,
  `email_send`, `feedback_submit`, `feedback_query`, `feedback_update`, `reminder_set`,
  `reminder_list`, `reminder_update`.
- `view_link` texts a one-tap link that logs the user into a specific dashboard tab
  (`view_links`, 24 h).

## Web (`web/`, Next.js 15, static export)

`/` landing · `/about` · `/signup` · `/login` · `/farmer` and `/market` dashboards
(inventory, orders, connections, chat widget, analytics) · `/settings` (profile, farm or
buyer details, addresses, contacts) · `/upload-photo` · `/feedback` · `/admin`. It's a PWA
with FCM push. `public/privacy.html` and `terms.html` are the legal pages.

## Pilot facts (as of the 2026-09-20 snapshot)

5 users, 2 farms, 2 buyers, 12 products, 20 inventory rows, 4 orders (6 line items),
3 connections, 0 standing orders, 119 notifications, 6 reminders, 10 feedback items,
4 invites. Last user activity was early July 2026.
