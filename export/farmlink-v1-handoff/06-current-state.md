# 06 — Current state (2026-11-25)

## Code

| Ref | What |
|---|---|
| tag `farmlink-v1-final` (`8c4cfea`) | The last v1 code, byte-identical to what ran in production Jul 6 – Sep 21 2026 |
| branch `revert/farmlink-v1` | v1 tree restored on top of the rework history, plus this folder |
| tag `sjca-rework-final`, branch `archive/sjca-rework` (`52f45b3`) | The SJCA farmers-market manager rework (Phases 1–4) |
| branch `archive/farmlink-v1` | Same commit as the v1 tag |

## Production (Firebase project `arkansaslocalfoodnetwork`) — unchanged by the revert

- **It runs the SJCA rework, not v1.** Phase 3 is deployed: functions `api`,
  `processMarketDates`, `processReminders`, `rollMarketDates`. Phase 4 was merged but
  never deployed. `farmlink.us` serves the rework's pages.
- **Do not deploy v1 over it.** v1 expects collections that no longer exist, and it has no
  send guard (see 05 #1).
- v1 Cloud Functions `processRecurringOrders`, `freshnessAlerts` and `sendNotification`
  were deleted on 2026-09-21.

## Where the v1 data is

- **Full Firestore export before any deletion:**
  `gs://arkansaslocalfoodnetwork-exports/pre-sjca-2026-09-20/` (whole database, plus a
  second export naming the subcollections `order_items`, `recurring_order_items` and
  `messages`). Photos were copied under `storage/` in the same folder. PITR is enabled on
  the live database.
- **Deleted from live Firestore on 2026-09-21** (only in the export now): `markets`,
  `products`, `inventory`, `farm_market_rels`, `orders` (+`order_items`),
  `recurring_orders`, `deliveries`, `upload_links`, `view_links`, `notifications`,
  `conversations` (+`messages`).
- **Still live:** `users` (5), `farms` (2), `reminders` (6), `feedback` (10), `invites`
  (4), `error_alerts` (2), and the 17 Storage photos. The rework also added its own
  collections (`farmers_markets`, `producers`, `messages`, …).

## Getting the data into Square

The pilot data is small: 2 farms, 2 buyers, 12 products, 4 orders. Re-key it by hand or
with a one-off script rather than building a migration:

1. Import the export into a **scratch** Firebase project
   (`gcloud firestore import gs://…/pre-sjca-2026-09-20/` against that project, never
   production), or read the export files locally.
2. Farms → Square Vendors, buyers → Customers, products → Catalog items. Skip inventory:
   stock from July is stale. Historical orders → keep as CSV records rather than recreate
   them in Square.
3. Moving data out of the Google project needs the owner's go-ahead. It contains real
   people's names, phones and conversation transcripts.

## People and accounts

- The voip.ms number, the Resend sender (`farmlink.us`), the Anthropic key and the Firebase
  project all belong to the current account owner. Decide which of them move to SJCA.
- Owner-side security items from the audit that may still be open: rotate the keys and
  JWT secret that shipped in old bundles, delete the old Owner-role service-account key,
  purge old function source archives, and set the voip.ms webhook secret.
