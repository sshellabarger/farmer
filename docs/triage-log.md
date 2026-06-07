# FarmLink Feedback Triage Log

Items listed here have been triaged. The daily scheduled task should only report feedback IDs not present in this file.

## Run: 2026-06-07

- `3a87c033-052d-46a3-a38e-3cb6b052428a` — Web interface not working (bug, Jun 3) — Site healthy as of Jun 7 (home/login 200, API auth OK). Reported 1 day after Jun 2 deploy; likely transient or fixed by Jun 5 redeploy. No client-side error reporting exists to diagnose.
- `5b5e42f5-2bbd-47de-a792-cbab0fa0781a` — Standing/Recurring Orders for Markets (feature, Jun 7) — Backend fully built (routes/recurring-orders.ts + daily processor in functions.ts). Web component recurring-orders.tsx uses demo data; "+ New Standing Order" button dead. Work = wire UI to API + create/edit form.
- `00829528-6c87-4ea8-b792-80d7c388eb60` — Reminders System with Custom Schedule (feature, Jun 7) — Notification infra exists ('reminder' NotificationType, sms/email/push channels, onSchedule pattern). Work = reminders collection + CRUD API + scheduler + web UI + SMS tool.
- `9a9e37b2-6e12-470f-8995-3d57e1a6e16c` — aging produce (feature, Jun 1) — inventory already stores harvest_date. Work = shelf-life thresholds, aging computation, alerts, dashboard view.
