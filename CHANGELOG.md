# Changelog

All notable changes to this project. Format follows Keep a Changelog; dates are
America/Chicago.

## [Unreleased] — SJCA rework, Step 1 (2026-09-20)

### Added
- `CLAUDE.md` — conventions, commands and ground rules for the rework.
- `docs/SPEC.md` — full SJCA market-management spec, refined by a repo audit; includes
  the archive plan, Firestore/Storage migration plan, security findings and the list of
  open decisions awaiting owner approval.
- This changelog.

### Audit findings recorded (no code changed)
- The stack described in `README.md` (Postgres/Kysely/BullMQ/Twilio) was retired on
  2026-05-31 (`ee2ab6a`); production is Firebase Cloud Functions + Firestore + voip.ms.
- Production is deployed at HEAD (`8c4cfea`, 2026-07-06). The triage log's "deploy still
  pending" entries from Jun 29–Jul 28 were never verified and are wrong.
- Real pilot data exists in Firestore and Storage; the owner's stop-before-dropping rule
  applies. Firestore has no PITR, no backups and no delete protection.
- Three Cloud Scheduler jobs are live and firing daily; `freshnessAlerts` is timing out
  (504) yet still texting one producer every morning.
- Every functions deploy has packaged `.env`, `service-account.json` (Owner-role key) and
  `.claude/settings.local.json` (containing API keys) into the GCF source bucket.
- The live voip.ms inbound webhook is unauthenticated; the WhatsApp route accepts
  unsigned payloads; the Cloud Tasks queue has never executed.

## [Unreleased] — SJCA rework, Phase 1 (2026-09-20)

Owner approved Phase 1 on 2026-09-20 with decisions D1, D3 (deferred), D5, D6, D8 and D9
(see `docs/SPEC.md` §9). On 2026-09-21 the owner confirmed all v1 users were test accounts,
withdrawing D14 (no transition text, no 30-day hold) and answering D18 (SJCA operates on
farmlink.us). Branch `rework/phase-1-retire` was merged to `main` as `b2678d9` and the
retirement deploy began.

### Frozen and backed up (on `main`)
- Tag `farmlink-v1-final` = `8c4cfea`, the exact deployed v1 bundle; branch `archive/farmlink-v1`.
- Firestore point-in-time recovery and delete protection enabled (7-day retention).
- Full Firestore export (483 documents — every collection and subcollection), the 17
  Storage uploads and orders/feedback CSVs at
  `gs://arkansaslocalfoodnetwork-exports/pre-sjca-2026-09-20/`. Zero seed-signature docs found.
- Owner's Jul 7–28 triage runs committed (`ed78dde`).

### Removed (branch `rework/phase-1-retire`)
- Ordering/buyer routes: farms, markets, inventory, orders, recurring-orders, deliveries,
  products, relationships, directory, analytics; `src/config/depot.ts`.
- Services: conversation (the Claude SMS assistant), order-notifications, recurring-orders,
  freshness-alerts, lfm-sync, produce-photo, imagen; `src/utils/freshness.ts`; all of `src/tools/`.
- Function exports `processRecurringOrders`, `freshnessAlerts`, `sendNotification` (the live
  functions and their scheduler jobs are deleted when this deploys) and `@google-cloud/tasks`.
- Telnyx and WhatsApp channels (archived; voip.ms only per D5); the web chat, history and
  conversations endpoints; v1 signup, farm/market profile routes and ownership middleware;
  the produce-photo upload flow and `view-link.ts`; the production seed script; the dead
  PR-preview workflow; `web/tsconfig.tsbuildinfo` from git.
- Web: farmer/market dashboards, AI chat widget, upload-photo and signup pages, the
  marketing landing and about pages, the service-worker "nuke" script, the 15.9 MB
  overview video (archived).

### Added / changed
- `src/app.ts` `buildApp()` — one route list shared by `functions.ts` and `server.ts`;
  `GET /api/health` reachable through Hosting.
- Inbound stopgap `src/services/inbound.ts`: STOP/START/HELP keywords, one courtesy reply
  per 24 h, every inbound and outbound text logged to the new `messages` collection;
  reminders and admin broadcast honour `users.sms_opt_out_at`.
- `POST /api/uploads` now requires authentication; `/api/view/:token` always returns 410.
- Interim web app: `/` transition notice, `/changed`; retired URLs 301 → `/changed`;
  admin-only OTP login; PWA rebranded (cache `sjca-v1`, SW nuke removed).
- `firebase.json → functions.ignore` excludes `.env*`, service-account keys, `.claude`,
  `.firebase`, `.github`, docs, tests, src, archive and media; hosting redirects added.
- `.github/workflows/ci.yml` — typecheck + tests + web typecheck on push; never deploys.
- `archive/` — v1 design package, prototype, postgres-era code and BullMQ workers,
  Telnyx/WhatsApp channels, AI harness, web pages, redacted triage log with a correction
  note, monitoring snapshot, Firestore schema snapshot (`archive/README.md`).
- README and `.env.example` rewritten for the surviving stack; `build` now cleans `dist/`;
  `vitest.config.ts` limits collection to `tests/**`.
- Post-review hygiene: the inbound handler is `handleInboundText` (the v1 name
  `processInboundMessage` is gone); send-and-log records `sent` even if the log write
  fails after a successful send (retried once), so the 24 h reply-once check cannot be
  defeated; `@fastify/auth` (unused) removed; admin users table trimmed to fields the API
  still returns; `GET /api/auth/me` uses the shared `authenticate` middleware (a deleted
  user's token now gets 401, not 404).
- `web/public/privacy.html` and `terms.html` rewritten for St. Joseph Center of Arkansas
  on farmlink.us (D18): the farmers-market service, the real processors, STOP/START/HELP,
  retention-while-active plus deletion on request, the public market lineup disclosed,
  sales estimates stated as admin-only and aggregate-only. `firestore.indexes.json` emptied
  (all ten v1 composite indexes retired; no surviving query needs one).

### Deferred
- D11 (move functions to `functions/`, drop the inert `frameworksBackend`) → Phase 2; the
  ignore-list hardening was applied instead.
- Retired-collection deletion (SPEC §4.5; check-in #2 given 2026-09-21) and the index
  deploy run as part of the retirement deploy sequence, after the functions deploy.
