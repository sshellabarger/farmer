# FarmLink — Technical Architecture & Specification

## Overview

FarmLink is a text-first platform connecting small and mid-size farms with markets (grocers, restaurants, co-ops, farmers markets). The primary interface is conversational SMS powered by an AI assistant, backed by web dashboards for deeper management. The system handles inventory listing, pricing, order management, delivery coordination, recurring orders, notifications, and analytics.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Runtime** | Node.js 20+ / TypeScript | Single language across stack; excellent Twilio SDK; fast async I/O for SMS webhooks |
| **API Framework** | Fastify | Performance, schema validation, plugin ecosystem |
| **Database** | PostgreSQL 16 + PostGIS | Relational integrity for orders/inventory; PostGIS for delivery radius/routing |
| **Cache / Queue** | Redis 7 + BullMQ | Conversation state caching, delayed notification queue, job scheduling |
| **AI Engine** | Anthropic Claude API | Tool-calling for structured actions; natural conversation; reliable intent parsing |
| **SMS Provider** | Twilio Programmable Messaging | Proven SMS API; webhook-based; phone number management; MMS support |
| **Web Frontend** | Next.js 14 (App Router) | SSR for SEO, React for dashboards, API routes for BFF pattern |
| **Auth** | Phone-based OTP (Twilio Verify) + session tokens | SMS-native auth; no passwords to manage |
| **Object Storage** | Cloudflare R2 or AWS S3 | Product images, documents, export files |
| **Hosting** | Railway or Render (initially), AWS ECS (scale) | Simple deploy initially, container-based for growth |
| **Monitoring** | Sentry + PostHog | Error tracking + product analytics |

---

## Core Architecture Decisions

### 1. Conversation AI Engine (the heart of the product)

The AI engine uses Claude's tool-calling capability to turn natural language SMS into structured actions. Each inbound message triggers this pipeline:

**Step 1 — Context Assembly**
Load from Redis/Postgres: user profile, farm or market record, conversation history (last 20 messages), current conversation state (what the AI was asking about), active inventory, pending orders.

**Step 2 — LLM Call with Tools**
Send the assembled context + new message to Claude API with a defined tool set:

```
Tools available to the LLM:
├── inventory_add(product, qty, unit, price?, harvest_date?)
├── inventory_update(inventory_id, fields_to_update)
├── price_set(product, price, unit)
├── notify_markets(inventory_id, market_ids?, delay_minutes?)
├── order_create(market_id, items[])
├── order_update(order_id, status | items)
├── order_query(filters: date?, status?, market?)
├── delivery_schedule(order_id, type, time)
├── delivery_query(date?)
├── recurring_order_create(market_id, farm_id, items[], frequency, days)
├── recurring_order_update(recurring_id, fields)
├── market_query(filters?)
├── inventory_query(filters: farm?, category?, status?)
├── analytics_summary(period: today | week | month)
└── suggest_bundle(inventory_ids[], market_id?)
```

**Step 3 — Tool Execution**
The LLM returns tool calls which the server executes against Postgres. Multiple tool calls can chain (e.g., `inventory_add` → `price_set` → `notify_markets`).

**Step 4 — Response Composition**
The LLM composes a natural language response incorporating tool results. The system prompt instructs it to: confirm what was done, surface relevant context proactively, and suggest a logical next action.

**Step 5 — Side Effects**
After responding: update DB, queue delayed notifications, schedule recurring tasks, log the interaction.

**Proactive Messages (the "smart" in smart assistant):**
A scheduled job (BullMQ cron) triggers proactive outbound messages:
- Morning harvest reminder if recurring orders are due
- Standing order confirmation 24h before fulfillment
- Low inventory alerts when remaining < 20%
- Cross-farm bundle suggestions when a market orders complementary items
- Weekly sales summary every Sunday evening
- Price change alerts if competing farms adjust pricing

### 2. SMS Integration (Twilio)

```
Inbound flow:
  Farmer/Market phone → Twilio → Webhook POST /api/sms/inbound
  → Parse sender → Load conversation → AI Engine → Respond

Outbound flow:
  System event → BullMQ job → Twilio Messages API → Farmer/Market phone
```

**Phone Number Strategy:**
- One Twilio number per deployment (initially)
- Users are identified by their registered phone number
- Support for multiple phone numbers per user (personal + business)
- Conversation threading by phone number

**Message Handling:**
- Rate limit: max 1 outbound message per second per number (Twilio limit)
- Delivery receipts tracked via status callbacks
- Failed message retry: 3 attempts with exponential backoff
- MMS support for product photos (farmers can text a photo with inventory)

### 3. Notification Priority System

The priority/delay system is a key differentiator. When a farmer lists new inventory:

```
Farm → "notify ABC first, everyone else in an hour"

System creates notification jobs:
  Job 1: market_id=ABC, delay=0min, status=pending
  Job 2: market_id=River, delay=60min, status=pending
  Job 3: market_id=Hillcrest, delay=60min, status=pending

BullMQ processes each at scheduled time:
  → Check inventory still available (may have sold)
  → If available: send SMS to market
  → If sold out: skip notification, mark as cancelled
```

Default behavior (if farmer doesn't specify): use the priority order from `farm_market_rels.priority` with configurable delays per tier (e.g., Priority 1 = immediate, Priority 2 = 30 min, Priority 3+ = 60 min).

### 4. Order State Machine

```
                    ┌──── cancelled
                    │
  pending → confirmed → in_transit → delivered
    │                      │
    └──── cancelled         └──── failed
```

State transitions trigger:
- `pending → confirmed`: SMS to both farmer + market
- `confirmed → in_transit`: SMS to market ("Your order is on its way")
- `in_transit → delivered`: SMS to farmer ("Delivery confirmed")
- Any → `cancelled`: SMS to affected party with reason

### 5. Recurring Order Engine

Standing orders are templates, not active orders. A cron job processes them:

```
Every day at midnight (farm's timezone):
  1. Query recurring_orders WHERE next_delivery = today AND active = true
  2. For each:
     a. Check inventory availability
     b. If available: create real order, send confirmation SMS
     c. If unavailable: alert farmer, notify market of substitution options
     d. Calculate next_delivery based on frequency + schedule_days
     e. Update recurring_order.next_delivery
```

### 6. Multi-Farm Aggregation (Market View)

Markets can browse across all connected farms. The query:

```sql
SELECT i.*, p.name, p.category, f.name as farm_name, f.location
FROM inventory i
JOIN products p ON i.product_id = p.id
JOIN farms f ON i.farm_id = f.id
JOIN farm_market_rels fmr ON f.id = fmr.farm_id AND fmr.market_id = $1
WHERE i.status IN ('available', 'partial')
  AND i.remaining > 0
  AND fmr.active = true
ORDER BY p.category, i.harvest_date DESC;
```

Via SMS, markets text "what's available?" and get a consolidated list grouped by farm.

---

## API Design

### REST Endpoints

```
Authentication:
  POST   /api/auth/otp/request     # Send OTP to phone
  POST   /api/auth/otp/verify      # Verify OTP, return token
  POST   /api/auth/logout

SMS Webhooks:
  POST   /api/sms/inbound          # Twilio webhook
  POST   /api/sms/status            # Delivery receipt callback

Farms:
  GET    /api/farms/:id
  PUT    /api/farms/:id
  GET    /api/farms/:id/inventory
  GET    /api/farms/:id/orders
  GET    /api/farms/:id/analytics

Inventory:
  GET    /api/inventory              # With filters
  POST   /api/inventory
  PUT    /api/inventory/:id
  DELETE /api/inventory/:id

Markets:
  GET    /api/markets/:id
  PUT    /api/markets/:id
  GET    /api/markets/:id/available   # Multi-farm browse
  GET    /api/markets/:id/orders

Orders:
  GET    /api/orders                  # With filters
  POST   /api/orders
  PUT    /api/orders/:id
  PATCH  /api/orders/:id/status

Recurring Orders:
  GET    /api/recurring-orders
  POST   /api/recurring-orders
  PUT    /api/recurring-orders/:id
  DELETE /api/recurring-orders/:id

Deliveries:
  GET    /api/deliveries              # With date filter
  PUT    /api/deliveries/:id/status

Relationships:
  GET    /api/farms/:id/markets       # Farm's connected markets
  PUT    /api/farm-market-rels/:id    # Update priority, delay
  POST   /api/farm-market-rels       # Connect new farm-market pair

Analytics:
  GET    /api/analytics/revenue       # ?period=week|month|quarter
  GET    /api/analytics/top-products  # ?period=week|month
  GET    /api/analytics/market-breakdown
```

---

## AI System Prompt Structure

The conversation AI needs a carefully structured system prompt. Key sections:

```
ROLE: You are FarmLink, a smart agricultural sales assistant.
You help farmers list inventory and manage orders via text.
You help markets discover and order from local farms.

PERSONALITY:
- Warm, efficient, proactive
- Confirm actions clearly with emoji indicators
- Suggest logical next steps
- Use structured formatting for lists (emoji bullets, line breaks)
- Keep messages concise — this is SMS, not email

TOOLS: [structured tool definitions]

CONTEXT FORMAT:
- User: {name, role, phone}
- Farm/Market: {name, location, preferences}
- Recent messages: [last 20]
- Active inventory: [current listings]
- Pending orders: [today's orders]
- Standing orders: [recurring templates]
- Conversation state: {last_topic, pending_confirmation, awaiting_field}

PROACTIVE BEHAVIORS:
1. If farmer lists inventory without a price, check price_list first
2. If a product complements another farm's recent listing, suggest a bundle
3. If it's morning, lead with standing order reminders
4. After completing an action, suggest what's logical next
5. Surface quick stats when they'd be useful context

CONFIRMATION PATTERNS:
- Always confirm quantities, prices, and recipients before executing
- Use numbered options for multi-choice (1️⃣ 2️⃣ 3️⃣)
- Accept shorthand (y/n, numbers, first-name references to markets)
```

---

## Deployment Architecture (Phase 1 — Launch)

```
Railway / Render:
  ├── api-server (Fastify, 2 instances)
  ├── worker (BullMQ processor, 1 instance)
  ├── web (Next.js, 1 instance)
  ├── postgres (managed)
  └── redis (managed)

External:
  ├── Twilio (SMS)
  ├── Anthropic (Claude API)
  └── R2/S3 (storage)
```

**Estimated monthly costs at launch (< 50 farms, < 200 markets):**
- Railway/Render hosting: ~$40-80/mo
- Twilio SMS: ~$50-150/mo (depends on volume, ~$0.0079/msg)
- Claude API: ~$30-100/mo (depends on message volume)
- Postgres: included in hosting
- Domain + DNS: ~$15/yr
- **Total: ~$120-350/mo**

---

## Data Migration & Onboarding

New farmer onboarding via SMS:

```
Farmer texts the FarmLink number: "Hey I want to sign up"

App: Welcome to FarmLink! 🌱 Let's get you set up.
     What's your farm name?
Farmer: Green Acres Farm
App: Love it! Where are you located?
Farmer: Scott, AR
App: And what do you grow?
Farmer: Mostly heirloom tomatoes, peppers, herbs, and berries
App: Perfect! I've set up Green Acres Farm in Scott, AR.
     You can text me anytime to list inventory, manage orders, or check sales.
     Try it: "I've got 50lb of tomatoes at $3/lb"
```

Market onboarding follows a similar conversational flow, ending with a connection request to nearby farms.

---

## Security Considerations

- **Phone verification**: All accounts require verified phone numbers
- **API authentication**: JWT tokens with 24h expiry, refresh via OTP
- **SMS spoofing**: Validate Twilio webhook signatures on all inbound
- **Rate limiting**: Per-phone-number rate limits (10 messages/minute)
- **Data encryption**: At rest (Postgres) and in transit (TLS)
- **PII handling**: Phone numbers and names are PII; minimize logging, encrypt at rest
- **Role-based access**: Farmers see only their inventory/orders; markets see only their connected farms
- **Audit trail**: All order state changes logged with timestamp and actor

---

## Future Considerations (Phase 2+)

- **Payment integration**: Stripe Connect for farm-to-market payments
- **Route optimization**: PostGIS-powered delivery route planning across multiple drops
- **Photo AI**: Farmers text a photo of produce → AI estimates quantity and quality
- **Market demand signals**: Markets can broadcast "looking for 50lb heirloom tomatoes" to all connected farms
- **Co-op mode**: Multiple farms aggregate into a single virtual farm for larger market contracts
- **USDA compliance**: Organic certification tracking, food safety documentation
- **Weather integration**: Proactive alerts when weather events may affect harvest or delivery
- **QuickBooks/Xero sync**: Automated invoicing from confirmed orders
