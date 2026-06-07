# FarmLink Feedback Triage Log

Items listed here have been triaged. The daily scheduled task should only report feedback IDs not present in this file.

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
