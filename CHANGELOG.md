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

## [Unreleased] — SJCA rework, Phase 2: markets, producers, applications, roles, test mode, importer (2026-09-21)

Built by five parallel executors against a written contract (`docs/phase2-contract.md`),
merged as `rework/phase-2` in a green order (19 commits, 83 files, 186 tests) and checked
by three adversarial verifiers: no blockers.

### Added
- `farmers_markets` with a versioned, admin-editable schedule — season, weekdays, hours,
  timezone, skipped and special dates, workflow offsets from the market's end time, quiet
  hours, extra questions — and `market_dates` materialised by an idempotent generator
  (`src/services/market-dates.ts`; Intl-based local↔UTC conversion tested across both
  2026 DST transitions; past or acted-on dates are never rewritten; nightly
  `rollMarketDates` scheduler).
- Roles `admin` and `market_manager` with `assigned_market_ids`, `requireMarketAccess`,
  an `audit_log` of admin actions, admin-user invites by text, `GET /api/dashboard`.
- `producers` (identity by email, business domain and name key — `emails[]`, `aliases[]`),
  `producer_memberships` with applied → under_review → approved → active → inactive
  transitions, `applications` (public, rate-limited `POST /api/applications`; approving
  upserts the producer by email, never by name), check-in reads.
- **Structural test mode.** `SMS_PROVIDER` and `EMAIL_PROVIDER` default to `console`; a
  real provider can be constructed only when `NODE_ENV=production` and
  `ALLOW_REAL_SENDS=true`, otherwise `sendSms` throws `SendsDisabledError`. Every send —
  OTP, reminders, broadcasts, invites, inbound replies — goes through the one logged
  `sendSms` and writes a `messages` row (`status: simulated` in test mode). `env.ts` no
  longer overrides the process environment from `.env`; a vitest setup file asserts
  console mode before any test; `GET /api/admin/providers` shows the live configuration.
- Admin web app: dashboard, markets list and detail with the schedule editor and dates
  table, producers list and detail, applications inbox, staff users, and the public
  `/apply` form (page-1 fields; page-2 pending D15). Fully static build.
- `scripts/import-survey.mjs` (`npm run import:survey -- --source <path|gs://…> --market
  wlrfm --dry-run|--write`): imports Google-Form weekly-survey history into producers,
  memberships, market dates and check-ins, idempotently, printing only counts and
  business names. 57 tests of its own.
- `docs/phase2-contract.md` (the contract, verbatim) and `docs/phase2/notes-D.md`.

### Changed
- `authenticate()` rejects `active: false` users; `/api/auth/me` returns
  `assigned_market_ids`. `trustProxy: true` so rate limiting keys on the real client IP.
- `firebase.json`: `scripts/` excluded from the functions bundle. CI runs in console test
  mode. `.env.*` ignored: production sends are enabled by a project-scoped
  `.env.arkansaslocalfoodnetwork` (non-secret keys) that the Firebase CLI merges at deploy
  and dotenv never reads.

### Deviations and follow-ups
- Dashboard `next_date` counts any non-cancelled upcoming date (the contract said
  `collecting` only) — kept deliberately; revisit when Phase 3 adds the other statuses.
- Full-collection scans in `GET /api/audit-log` (no `actor_id`), `GET /api/producers` (no
  `market_id`) and `upsertProducerByEmail` — fine at this scale.
- Executors A1/A2/B/C's release notes live in the run results, not `docs/phase2/`: an
  orchestration rule forbade writing there. This entry is the fold-in.
- Still deferred: D11 (`functions/` subdirectory), S10 Secret Manager (done with the
  owner), D15 page-2 application fields.

### Deployed — 2026-09-22 (~00:25 UTC, from `main` `9298699`)
- Functions: `api` and `processReminders` updated, `rollMarketDates` created. The CLI
  loaded `.env` + `.env.arkansaslocalfoodnetwork`, so production sends are enabled
  (pre-flight resolved `voipms` / `resend` / `ALLOW_REAL_SENDS=true`). Bundle 237 KB.
- Hosting: 17 static routes released. `/apply` and every `/admin/*` page answer 200;
  every protected API route answers 401; `POST /api/applications {}` → 400, nothing written.
- Survey import (D20): `farmers_markets/wlrfm` (Saturdays 08:00–12:00 America/Chicago,
  2026-04-18 → 2026-10-31), 23 `market_dates`, 39 `producers` (none with a phone number),
  39 active `producer_memberships`, 508 `checkins` (512 responses; the 4 same-producer,
  same-Saturday duplicates resolved latest-wins). A second dry run against the live
  database matched all 39 producers and 23 dates and proposed no writes. `users` and
  `farms` untouched.
- CI green on `3843a4d`, `8cd7c34`, `9298699`.
- Noted, not caused by this deploy: the `reminders` collection went from 6 documents to 0
  on 2026-09-21 between 12:34:16 and 12:34:22 UTC — six authenticated
  `DELETE /api/reminders/:id` requests from the settings page (Cloud Logging), i.e. the
  owner removing test reminders while verifying Phase 1. Confirmed by point-in-time reads
  (6 at 12:30Z, 0 at 13:00Z).

### Hotfix — Firestore Timestamps (2026-09-22)

- **Broken:** the first production run of `rollMarketDates` (triggered manually at
  01:10 UTC) threw `doc.end_at.getTime is not a function` and hit the 120 s request
  timeout; it created none of WLRFM's upcoming Saturdays. The same pattern sat in
  `GET /api/dashboard`, `GET /api/markets/:id`, the date cancel/uncancel route, the
  application duplicate check and the producer check-in summary. The owner received the
  automatic alert text.
- **Cause:** the admin SDK returns `Timestamp` for every stored date; Phase 2 code cast
  documents to interfaces typed `Date` and compared with `.getTime()`. The test fake
  returned the `Date` objects it was given, so 186 tests could not see it.
- **Fix:** `src/utils/dates.ts` (`toDate`, `toDateOrEpoch`, `toMillis`);
  `marketDateFromData()` is now the one way to turn a `market_dates` snapshot into a
  `MarketDateDoc`; the routes above read through it or `toDate()`. `tests/helpers/fake-db.ts`
  now hands back `Timestamp` instances on every read, exactly like production (`dump()`
  stays raw), and `tests/firestore-timestamps.test.ts` replays the production case:
  an imported past date is frozen and the six remaining Saturdays are created, twice,
  idempotently. 191 tests. The error notifier's Anthropic call is bounded (15 s, no
  retries) so it can never hold a scheduler invocation open.
- Phase 1 leftovers closed with `gcloud`: only the two expected scheduler jobs remain;
  the orphaned `sendNotification` Cloud Tasks queue is deleted.

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

### Deployed — 2026-09-21 (~12:25 UTC, from `main` `f966cc8`)
- Functions: `api` and `processReminders` updated; `sendNotification`,
  `processRecurringOrders` and `freshnessAlerts` deleted. Bundle 152 KB (was 17 MB).
- Hosting: transition landing, `/changed`, 301s for `/farmer` `/market` `/signup`
  `/upload-photo`, rewritten privacy and terms, rebranded manifest and service worker.
- Firestore: all 10 composite indexes deleted; rules unchanged. Data: the eleven retired
  collections and their subcollections deleted (178 documents + 6 order items + 270
  messages); kept collections unchanged; Storage untouched.
- Smoke tests green: `/health` (function), `/api/health` (Hosting), `/api/view/<token>` → 410,
  retired routes → 404. Pending a gcloud check: scheduler jobs removed, Cloud Tasks queue gone.

### Deferred
- D11 (move functions to `functions/`, drop the inert `frameworksBackend`) → Phase 2; the
  ignore-list hardening was applied instead.
- `processReminders` still logs to `notifications`; Phase 2 moves that write to `messages`.
- Retired-collection deletion (SPEC §4.5; check-in #2 given 2026-09-21) and the index
  deploy run as part of the retirement deploy sequence, after the functions deploy.
