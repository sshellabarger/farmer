# Wholesale on Square (LFPP)

How FarmLink runs SJCA wholesale orders on Square. Design agreed Nov 26, 2026.

## Order flow

| Step | FarmLink status | What happens |
|---|---|---|
| Buyer orders | pending | Square order at the wholesale location, pickup or delivery, one farm per order. Tax certificate checked first. Per-order buyer fees added. Terms saved to `wholesale_orders/{orderId}`. |
| Farm confirms | confirmed | No invoice yet. |
| Drop-off and check-in | in_transit | Short items fixed (`received_items`), once-per-day delivery fee added, then the invoice is created and texted. |
| Pickup or delivery | delivered | Recorded in order metadata; Square completes the order once it is paid. |
| Tuesday payout | | Sold list per farm for orders completed the Tuesday to Monday before. Draft only. |

## Settings

| Setting | Where | Value |
|---|---|---|
| Wholesale location | `SQUARE_LOCATION_ID` | [wholesale location id: create the location in Square first] |
| Taxes blocked on wholesale lines | `SQUARE_EXEMPT_BLOCK_TAX_IDS` | [the seller's catalog tax ids, comma separated] |
| Taxes charged on buyer fees | `SQUARE_FEE_TAX_IDS` | Leave blank: fees are not taxed (SJCA is a nonprofit) |
| Invoice terms | `INVOICE_NET_DAYS` | Days after pickup or delivery |
| Fees | `fee_rules` collection, `PUT /api/admin/wholesale/fee-rules/:id` | [amounts set later] |

A fee rule: `name`, `code`, `percent` and/or `flat_cents`, `payer` (buyer or farmer), `applies_to` (all or delivery), `per` (order, or buyer_delivery_day for a delivery fee charged once per buyer per day), optional `farm_id`/`buyer_id` override, `effective_from`/`effective_to`, `active`. A rule with no amounts is a placeholder and is skipped.

## Staff routes (admin only, under `/api/admin/wholesale`)

| Route | Use |
|---|---|
| `GET /fee-rules`, `PUT /fee-rules/:id` | See and set fee rules |
| `POST /buyers/:id/tax-exempt` | Record a buyer's certificate (ST-391, SST-F0003 or out-of-state permit) and mark it verified |
| `GET /buyers/tax-exempt` | Buyers who cannot order, or whose certificate lapses within a month |
| `POST /payouts/run` | Build the payout draft (also runs Tuesdays 6am CT) |
| `GET /payouts/:payDay`, `PUT /payouts/:payDay/status` | Review it; mark reviewed or paid (then never rebuilt) |

## Still open

- Whether a restaurant's food purchases count as resale, and certificate retention (rule GR-79).
- Refund policy: refunds are listed on the payout for staff to decide; nothing is deducted automatically.
- Whether fee income counts as LFPP program income.
- To test in the Square sandbox: DELIVERY fulfillments, service charges on invoices, line `blocked_taxes`, LINE_ITEM taxes on service charges, and editing line quantities before the invoice.
