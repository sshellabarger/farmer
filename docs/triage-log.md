# FarmLink Feedback Triage Log

Items listed here have been triaged. The daily scheduled task should only report feedback IDs not present in this file.

## Run: 2026-06-25 (daily triage)

- `fd6648b0-0f54-47d7-8d71-ff748edc249e` — ORD-MQS2AO6R not delivered to farmer (bug, web, Jun 25; re: Cory Babb / Firelight Farm) — NEW. Root cause: new-order creation never notifies the farmer. Both creation paths (`routes/orders.ts` POST and `tools/orders.ts` orderCreate) write the order as `status='pending'` and call no notify function; `sendOrderStatusNotification` only handles confirmed/in_transit/delivered/cancelled and only runs from `PATCH /:id/status`. Verified live: ORD-MQS2AO6R (id eca583d1, order placed by The Little Farm Stop) still `pending`, 0 docs in `notifications`; Cory has phone on file, 0 fcm_tokens. Recommend (no code change this run): add a new-order farmer alert to `sendOrderStatusNotification` and call it best-effort from both creation paths, SMS-authoritative (mirrors Jun 7 reminders fix). IMPLEMENTED Jun 25 (Option 1, live session): new `sendNewOrderNotification` in `services/order-notifications.ts` — best-effort push + authoritative SMS + `notifications` audit row (`type='new_order'`); wired best-effort (try/catch) into `routes/orders.ts` POST and `tools/orders.ts` orderCreate. `tsc --noEmit` passes; NOT yet deployed. Close `fd6648b0` after deploy + a test order to Cory confirms SMS receipt.
- No change to previously triaged items: feature requests `4ccfa6a7` (potluck food rescue) and `d15c0f00` (auto-update ALFN) both still `open`; `8ec8e02e` (Sunday reminders) resolved-but-still-`open`, dedupe of 6 near-duplicate reminders still pending. Error alerts `054210f7` (last sent Jun 7 18:43 UTC) and `34521a55` (Jun 1 01:25 UTC) unchanged — no new sends since last run (Jun 23).

## Run: 2026-06-23 (daily triage)

- No new items. All 3 open feedback already triaged: `4ccfa6a7` (potluck food rescue donation, web, Jun 8) and `d15c0f00` (auto-update ALFN/Local Food Marketplace, web, Jun 8) both still `open`; `8ec8e02e` (Sunday reminders, sms, Jun 12) verified resolved Jun 15 but still shows `open` in Firestore. Error alerts `054210f7` (last sent Jun 7 18:43 UTC) and `34521a55` (Jun 1 01:25 UTC) unchanged — identical last_sent_at to prior runs, no new sends since the last run (Jun 15). Carryover (no code change): recommend closing `8ec8e02e` as resolved and deduping the 6 near-duplicate Sunday reminders in a live session. No action needed; no code change.

## Run: 2026-06-15 (daily triage)

- No new items. All 3 open feedback already triaged (`4ccfa6a7` potluck food rescue, `8ec8e02e` Sunday reminders, `d15c0f00` auto-update ALFN); error alerts `054210f7` (last sent Jun 7 18:43 UTC) and `34521a55` (Jun 1 01:25 UTC) unchanged — no new sends since last run. VERIFICATION of `8ec8e02e`: Jun 14 was the first Sunday after setup and all 6 weekly reminders fired and delivered via SMS — `notifications` shows 6 reminder/sms sends (status=sent) at 20:30 (15:30 CDT), 21:00 (16:00 CDT), and 4× ~21:30 UTC (16:30 CDT), and all 6 reminders now carry last_sent_date=2026-06-14. The Jun 7 SMS-authoritative fix works on a real Sunday; original root cause was "no Sunday had elapsed," not a code defect → recommend closing `8ec8e02e` as resolved. Remaining (non-bug): 6 duplicate/near-duplicate reminders (4× identical "Call your mom" 16:30, "call my mon" 16:00, "remind me to call dad" 15:30) send 4 identical texts each Sunday — recommend dedupe in a live session (data cleanup, no code change). No code change this run.

## Run: 2026-06-14 (daily triage)

- No new items. All 3 open feedback already triaged: `4ccfa6a7` (potluck food rescue donation, Jun 8), `8ec8e02e` (Sunday reminders not delivered, Jun 13), `d15c0f00` (auto-update ALFN/Local Food Marketplace, Jun 8). Error alerts `054210f7` (last sent Jun 7 18:43 UTC) and `34521a55` (Jun 1 01:25 UTC) unchanged — no new sends since the last run. Note: today (Jun 14) is the first Sunday since the `8ec8e02e` reminder setup; reminders fire this afternoon (15:30–16:30 CDT, not yet fired as of 08:13 CDT) — the Jun 13 "verify after Jun 14 fire + dedupe the 6 near-duplicate Sunday reminders" recommendation is now actionable in a live session. No action needed; no code change.

## Run: 2026-06-13 (daily triage)

- `8ec8e02e-3c71-4286-b375-235361cece41` — Sunday reminders not being delivered (bug, sms, Jun 12; reporter Scott +15016266100) — NOT a new code bug. The Jun 7 SMS-authoritative fix is deployed and works (a real SMS + `notifications` doc went out Jun 7 16:30 CDT), and the weekly matcher handles "Sunday"/"sun" correctly. Root cause of "didn't receive": no Sunday has occurred between setup and the Jun 12 report — Jun 8–13 are Mon–Sat; next Sunday is Jun 14. The user has 6 near-duplicate Sunday reminders (4× "Call your mom" 16:30, 1× "call my mon" 16:00, 1× "remind me to call dad" 15:30); 3 show last_sent_date=2026-06-07, 3 are null (created after Jun7's window). The two earlier 15:30/16:00 Jun-7 "sent" marks have no notification doc → those were the ORIGINAL push-only misses, already fixed. Recommend: verify after Jun 14 fire + dedupe the 6 reminders (4 identical "Call your mom" texts will fire Sunday 16:30). No code change made this run.

## Run: 2026-06-09 (daily triage)

- No new items. Open feedback `4ccfa6a7` (potluck food rescue donation) and `d15c0f00` (auto-update ALFN/Local Food Marketplace) both already triaged Jun 8 and still `open` in Firestore. Error alerts `054210f7` (last seen Jun 7 18:43 UTC) and `34521a55` (Jun 1) unchanged — no new sends since last run. No action needed.

## Run: 2026-06-08 (daily triage)

- `4ccfa6a7-5997-49c6-9867-d53c3e086680` — Option to donate food to potluck food rescue (feature, web, Jun 8) — Wants in-app donation flow that currently requires admin.foodrescuehero.org/donations/intake/potluck. Implementation surface: new outbound integration (Food Rescue Hero API, if exists) following telnyx.ts fetch+env-key pattern; new tool in src/tools/ + route + web action. Blocked on Food Rescue Hero API availability/credentials (unconfirmed by submitter).
- `d15c0f00-39d0-489c-b804-4fedcaeb3539` — Auto-update ALFN/Local Food Marketplace with available produce (feature, web, Jun 8) — Wants inventory (status='available') auto-pushed to littlerock.localfoodmarketplace.com instead of manual login. Implementation surface: outbound sync reading inventory collection, likely a new onSchedule job in functions.ts (mirrors processReminders/freshnessAlerts) + field mapping product/quantity/price. Blocked on Local Food Marketplace public API availability/credentials (unconfirmed).

## Run: 2026-06-08 (earlier)

- No new items. Open feedback `ce8ea6ca` (reminders not delivered) already triaged + FIXED Jun 7 night; status in Firestore still `open` (not yet resolved). Error alerts `054210f7` (Jun 7 18:43 UTC) and `34521a55` (Jun 1) both predate the last run; no new alerts since.

## Run: 2026-06-07 (night)

- `ce8ea6ca-30da-47a1-97a9-1eb61b2576ec` — Reminders not being delivered, set via web (bug, sms, Jun 7) — Scheduler ran and marked 2 of 3 Sunday reminders sent (last_sent_date=2026-06-07); failure is delivery. notifyByPhone prefers push since Scott has 2 fcm_tokens; FCM accepted the message (successCount>0) so it returned 'push' and skipped SMS, but FCM acceptance ≠ device display (closed browser / stale-but-registered token / OS permission). No SMS fallback fires and reminder sends are not logged to notifications collection. Recommended: send reminders via SMS (or push+SMS) and log sends. FIXED Jun 7: SMS now authoritative channel (marked sent only on SMS success), push kept best-effort, sends logged to notifications collection. Deployed to processReminders.

## Run: 2026-06-07 (evening)

- `c4936ed5-4f95-42c7-9c81-68ec57170d7b` — Delete inventory item gives Bad Request popup (bug, web, Jun 7) — Root cause: web/src/lib/api.ts request() always sets Content-Type: application/json; bodyless DELETEs trigger Fastify's FST_ERR_CTP_EMPTY_JSON_BODY 400. Affects all DELETE endpoints (inventory, recurring orders, reminders, feedback). Fix = only set header when body present. FIXED + deployed Jun 7, verified by Scott, ticket closed.
- `13839a41-c0ee-4afc-8d8b-b8e90f575ec2` — Reminders System Daily/Weekly (feature, sms, Jun 7) — Duplicate of 00829528 (triaged Jun 7). Feature now implemented: routes/reminders.ts CRUD, processReminders onSchedule (15 min), web reminders-card.tsx. Recommend close as duplicate/implemented.
- `9ca8c851-f29c-4a01-8ab8-513afbe11995` — Standing/Recurring Orders (feature, sms, Jun 7) — Duplicate of 5b5e42f5 (triaged Jun 7). Backend + daily processor + live RecurringPanel UI with create form now exist. Recommend close as duplicate/implemented. Note: web delete of standing orders hit by same Content-Type bug as c4936ed5.
- Error alert `054210f7…` last seen Jun 7 ~18:43 UTC (suppressed=0); docs carry only dedupe hash + timestamps, no message — content must come from the alert email/text. 5xx-only alerting, so unrelated to the 400 delete bug.

## Run: 2026-06-07

- `3a87c033-052d-46a3-a38e-3cb6b052428a` — Web interface not working (bug, Jun 3) — Site healthy as of Jun 7 (home/login 200, API auth OK). Reported 1 day after Jun 2 deploy; likely transient or fixed by Jun 5 redeploy. No client-side error reporting exists to diagnose.
- `5b5e42f5-2bbd-47de-a792-cbab0fa0781a` — Standing/Recurring Orders for Markets (feature, Jun 7) — Backend fully built (routes/recurring-orders.ts + daily processor in functions.ts). Web component recurring-orders.tsx uses demo data; "+ New Standing Order" button dead. Work = wire UI to API + create/edit form.
- `00829528-6c87-4ea8-b792-80d7c388eb60` — Reminders System with Custom Schedule (feature, Jun 7) — Notification infra exists ('reminder' NotificationType, sms/email/push channels, onSchedule pattern). Work = reminders collection + CRUD API + scheduler + web UI + SMS tool.
- `9a9e37b2-6e12-470f-8995-3d57e1a6e16c` — aging produce (feature, Jun 1) — inventory already stores harvest_date. Work = shelf-life thresholds, aging computation, alerts, dashboard view.
