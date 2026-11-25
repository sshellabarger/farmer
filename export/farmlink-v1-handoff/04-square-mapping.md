# 04 — Rebuilding FarmLink on Square

**Verify every Square API detail below against developer.squareup.com before building.**
This mapping was written from general knowledge of Square's APIs, not tested against a
Square account. Build against the **Sandbox** first.

## Decision 1 (make it before anything else): whose Square account?

v1 is a marketplace: each farm sells directly to each buyer, and the depot is only a
hand-off point. Square is built around **one seller (a merchant) with its own catalog**.
There are two ways to fit FarmLink into it:

| | A. SJCA is the seller (hub) — **recommended** | B. Every farm has its own Square account |
|---|---|---|
| Shape | SJCA's Square account holds one catalog. Farms are **Vendors**, buyers are **Customers**, the depot is a **Location**. SJCA sells to buyers and pays farms out (consignment or wholesale). | FarmLink is a Square **OAuth platform app**. Each farm connects its account, and orders are created in the farm's account. |
| Fits | The depot model as it is today, and how Little Farm Stop already runs on Square with vendors | True farm-to-buyer sales, where each farm is the seller of record |
| Money | One merchant. Farm payouts happen outside Square (bank/bill pay) | Each farm is paid directly, with an optional app fee |
| Cost to build | Low: one access token, one catalog | High: OAuth, per-merchant tokens, cross-account queries, every farm onboarding to Square |
| Risk | SJCA becomes the seller of record (tax, liability, payouts) | Farms without Square can't take part |

The rest of this file assumes **A**. Under B the same objects apply, but per merchant.

## Entity mapping

| v1 (Firestore) | Square | Notes / gaps |
|---|---|---|
| `farms` | **Vendors API** `Vendor` (name, address, contacts, status, note) | Farm phone/specialty can go in the vendor note or contacts. `delivery_schedule` has no Square home → app DB. |
| `markets` (buyers) | **Customers API** `Customer` + **Customer Groups** for buyer type (restaurant, food bank…) | `delivery_pref`, `type` → customer **custom attributes**. Phone on the Customer is the join key to texting. |
| `users` | No Square equivalent | Keep in the app DB: phone, role, login, `square_customer_id` / `square_vendor_id`. |
| `products` | **Catalog API** `ITEM` + `ITEM_VARIATION` (+ `CATEGORY`, `MEASUREMENT_UNIT`, `IMAGE`) | One item per farm-product. Link the variation to the farm vendor via the catalog's item-variation vendor info. Price per unit = variation price; unit = measurement unit (lb, bunch, pint, dozen). |
| `inventory` (harvest lots) | **Inventory API** counts per variation at the depot **Location**; `remaining` = `IN_STOCK` quantity; changes as `ADJUSTMENT` / `PHYSICAL_COUNT` | **Gap:** Square doesn't track lots or harvest dates. Options: (1) keep `harvest_date` per lot in the app DB and let Square hold only the count; (2) a variation per harvest week (clutters the catalog). Recommend (1). Freshness alerts read the app DB. |
| `inventory.status` | Derived: count > 0 → available; 0 → sold | `reserved` = Square's `RESERVED_FOR_SALE` state once an order is open. |
| `orders` + `order_items` | **Orders API** `Order` with `line_items` (catalog object id, quantity) and a **`PICKUP` fulfillment** at the depot Location, `pickup_at` = drop-off date | v1 statuses → Square: `pending` = order `OPEN`, fulfillment `PROPOSED`; `confirmed` = `RESERVED`; `in_transit` = `PREPARED` (at the depot, ready); `delivered` = `COMPLETED`; `cancelled` = `CANCELED`. `order_number` → the order `reference_id`. The farm per line item = the variation's vendor. |
| Paying for orders | **Invoices API** (net terms for restaurants and grocers) or **Payments API** / payment links | v1 never took payment. Food banks and pantries may be $0 orders or discounts. |
| `recurring_orders` | **Subscriptions API** with an order template, *or* keep the schedule in the app DB and create Square orders from a nightly job | Square subscriptions are built around billing plans. A nightly job that creates orders is simpler and matches v1. Recommend the job. |
| `farm_market_rels` (connections, priority, delay) | No equivalent | App DB. Customer custom attribute is too flat for many-to-many with priority. |
| Drop-off schedule, depot | **Locations API** for the depot; schedule in the app DB | Bookings API is for appointments, not drop-off windows. |
| `analytics` | **Orders API** `SearchOrders` (by location, date, state), grouped by vendor | Square Dashboard reports cover sales by item and category. |
| Photos | Catalog `IMAGE` objects (upload via the Catalog image endpoint) | Replaces Firebase Storage for product photos. |
| `conversations`/`messages`, `notifications`, `reminders`, `otps`, `invites`, `feedback`, `view_links`, `upload_links`, `admin_broadcasts`, `error_alerts` | No equivalent | App DB. **Square has no API for sending arbitrary SMS**; keep voip.ms. |

## Proposed architecture

```
 Farmers / buyers ──text──► voip.ms ──webhook──► FarmLink API (Cloud Functions or similar)
                                                   │  Claude tool loop (tools call Square)
        web app (OTP login) ───────────────────────┤
                                                   ├──► Square: Catalog, Inventory, Orders,
                                                   │            Customers, Vendors, Invoices
                                                   ├──► app DB: users, texting log, connections,
                                                   │            schedules, lots, reminders, feedback
 Square webhooks (order.updated, inventory.count.updated, customer.updated) ──► FarmLink API
```

- **Square is the source of truth** for catalog, stock counts, orders, buyers, vendors and
  money. The app DB stores Square ids, not copies of Square data. Read Square when you need it.
- **Webhooks keep texts in step.** An order changed in Square POS or the Dashboard (e.g. staff
  marks a pickup complete) fires `order.updated`, and FarmLink texts the buyer. Verify the
  webhook signature header on every call (v1 left its SMS webhook unauthenticated; see 05).
- **AI tools become thin Square wrappers.** `inventory_add` upserts a catalog item and
  adjusts inventory. `order_create` creates an Order with a pickup fulfillment.
  `order_update` updates the fulfillment state. `inventory_query` searches the catalog
  and retrieves counts. The prompt, date rules and hallucination guard carry over.
- **Idempotency.** Every Square write takes an `idempotency_key`. Derive it from the
  inbound message id, so a voip.ms retry never creates a second order.
- **App DB choice:** keeping Firestore (the existing project) is cheapest. The v1 code for
  auth, texting, reminders and feedback can be reused nearly as is.

## Build order

1. Square **Sandbox** app, plus the guard so dev can never text or email anyone (05 #1).
2. Locations (depot), categories, measurement units; import the 2 farms as Vendors and the
   2 buyers as Customers (from the export, `06-current-state.md`).
3. Catalog + inventory tools; the farmer can list stock by text and it appears in Square.
4. Orders with pickup fulfillments + status texts via webhooks.
5. Connections + priority notifications (app DB), then invoices/payments.
6. Standing orders, freshness alerts, reminders, feedback, admin broadcast.
7. Production Square token, real sends turned on deliberately.

## Open questions for SJCA

- A or B above, and if A: consignment (pay farms after sale) or wholesale (SJCA buys first)?
- Who pays for what: do food banks and pantries pay, and are invoices net-15/30?
- Is the depot still the Rodney Parham location, and is it one Square Location or several?
- Should Little Farm Stop's existing Square catalog and vendors be the same account?
  If so, wholesale items need their own category or location so they don't show at the register.
