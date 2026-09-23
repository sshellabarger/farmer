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
- **Measured while diagnosing:** the failed run's five-segment alert text spent ~2 minutes
  inside voip.ms (~25 s per segment; the request had no timeout). `src/services/voipms.ts`
  now aborts a request after 45 s, so a hung provider fails the send (`messages` row
  `failed`, `SmsSendError`) instead of holding a 120 s function open. Phase 3's engine is
  briefed to treat every send as interruptible: per-recipient idempotency through the
  `messages` log and a per-run wall-clock budget.
- Phase 1 leftovers closed with `gcloud`: only the two expected scheduler jobs remain;
  the orphaned `sendNotification` Cloud Tasks queue is deleted.
- **S5 purge (owner-approved 2026-09-22):** the six retired v1 source bundles
  (`freshnessAlerts/`, `processRecurringOrders/`, `sendNotification/` — two 16 MB versions
  each, every one packaging `.env`, the service-account key and `.claude/settings.local.json`)
  deleted from the functions source bucket, and every non-serving Cloud Run revision deleted
  (`api` 51, `processreminders` 19, `rollmarketdates` 1). The container registry already
  held only the current images (the superseded ones had been garbage-collected), so no
  secret-bearing artifact remains in the project — key rotation (S1–S3) is still due because
  the old bundles were downloadable until today.
- **Deployed 2026-09-22 12:26 UTC** (functions only, from `main` `1bcd13b`; the CLI login
  had expired, so the deploy authenticated with the project service account through
  `GOOGLE_APPLICATION_CREDENTIALS` in an isolated CLI config). Env keys verified on the
  deployed `api` (`NODE_ENV=production`, `ALLOW_REAL_SENDS=true`, `voipms`, `resend`).
  A manual `rollMarketDates` run then logged `1 markets, created=6 updated=0 cancelled=0`
  in about a second: `wlrfm_2026-09-26` … `wlrfm_2026-10-31` exist, the 23 imported
  dates are untouched, no alert fired. The 03:15 CT scheduled run had failed once more on
  the old code (one more alert text to the owner) before the deploy.

## [Unreleased] — SJCA rework, Phase 3: check-in links and texts, reminders, deadline flagging, STOP/HELP, quiet hours (2026-09-22)

Built by three parallel executors against a written contract (`docs/phase3-contract.md`),
merged as `rework/phase-3` in the contract's order (A engine → B messaging → C web, green
at every merge point: 256 → 292 tests), checked by three adversarial verifiers, then
hardened in a follow-up (`rework/p3-fix`, below) for the one blocker they found.

### Added
- **The check-in workflow engine** (`src/services/checkin-workflow.ts`, scheduler
  `processMarketDates` every 5 minutes, 300 s timeout). For every `collecting` date whose
  end is within the last 7 days it computes the schedule from *that market's* workflow
  offsets and quiet hours (`src/utils/quiet-hours.ts`, `nextAllowedInstant`, tested across
  both DST transitions and a second timezone): check-in text after the market ends,
  reminders only to producers with no check-in, deadline flagging (`non_responders`,
  `spot_not_held`, counts), then one staff summary by text (admins and the market's
  managers, phones only, opt-outs honoured) and email (`ALERT_EMAIL`). Recipients are
  active memberships → producers with an E.164 phone and no opt-out; everyone else is
  listed as excluded with a reason. Older `collecting` dates are ignored forever (the
  admin `close` route handles them); a date with zero recipients is processed silently —
  which is what keeps the 23 imported WLRFM dates quiet at deploy time. Templates are
  ASCII and fit two GSM-7 segments; no text promises a call-back or a held spot.
- **Link tokens** (`link_tokens`, `src/services/link-tokens.ts`): 32 random bytes
  base64url, one producer + one date, expiring three days after the deadline, re-openable
  up to 25 submissions (latest wins); never mints a session (test-enforced: the token
  modules cannot import `jwt.ts`).
- **Public check-in** `GET`/`POST /api/checkin/:token` (rate-limited, zod-validated; the
  producer and date come from the token, never the body; 404 unknown, 410 expired) and
  the mobile-first page `/checkin?t=…` (no login, `noindex`, plain 404/410 states,
  thank-you screen, "SJCA staff only, reported in aggregate" on the sales field). Form
  check-ins are written with `source: 'form'`, `token_id`, `submissions`, `partial`,
  `flags` and the importer's parsing rules (`src/services/checkins-submit.ts`).
- **Staff routes** `GET /api/market-dates/:id/status` (recipients, responded, excluded,
  actions timeline with scheduled vs effective instants), `POST …/resend-checkin`
  (fresh token, audited), `POST …/close` (admin; manual deadline processing with an
  optional summary) and the page `/admin/market-dates?id=…`; market detail rows link to it
  with `✓ link / N rem. / ✓ deadline` glyphs; the dashboard's collecting date links to it;
  producer detail shows source, bringing and feedback per check-in.
- **Inbound texts** (`src/services/inbound.ts`): STOP/START now record on `producers`
  too (`sms_opt_out_at`, `sms_consent`); for a known producer HELP replies with the open
  check-in link, YES/NO records `attending_next` (creating a minimal `source: 'sms'`,
  `partial` check-in when none exists) and replies with the link, and anything else is
  forwarded once to the market's staff as "Text from <business> (<market>): …" followed by
  the once-per-24 h courtesy reply. Unknown numbers keep the Phase 1 behaviour.
- `messages.kind` gains `checkin_link`, `checkin_reminder`, `deadline_summary`,
  `forwarded_inbound`; `market_dates.actions` gains `checkin_recipients`, `checkin_failed`,
  `summary_sent_at`, `summary_skipped`, `claims`, and `reminders_sent` entries become
  `{ offset_min, sent_at, recipients, failed, skipped }`.
- Tests: link tokens, submit parsing, engine timelines (a Saturday 08–12 and a Thursday
  17–20 market from the same code, quiet-hours deferral, past-date guard, excluded
  producers, superseded reminders, overlapping runs), public routes, staff routes, inbound
  YES/NO/HELP/forward/STOP, quiet hours, the `/status` no-op.

### Findings recorded
- voip.ms has no outbound delivery-receipt callback, so `messages.status` is terminal at
  `sent` and `POST /api/sms/status` is a documented no-op kept for a future provider.
- The contract's America/New_York quiet-hours example was off by one hour (EDT, not CDT);
  the test asserts the value re-derived from `Intl` and every other example matched.

### Deviations from the contract (each recorded in `docs/phase3/notes-*.md`)
- A: the engine's automatic deadline step writes the flags inline and leaves the staff
  summary to the separate, quiet-hours-aware summary step; `processDeadline(notify)` is
  used as-is only by the manual `close` route. `sendSms`'s `extra` keys land at the top
  level of `messages` rows (`token`, `offset_min`, `inbound_message_id`), as the Phase 2
  code already did. One test instant differs from the contract's worked example so both
  reminder offsets are genuinely due.
- B: YES/NO match the first word of the reply (so "no thanks" is a NO, raw text kept);
  STOP/START/HELP still match the whole keyword.
- C: the status response type is `MarketDateStatusView` (Phase 2 already exports
  `MarketDateStatus` as the lifecycle union); `CheckinForm` takes `marketName`; the
  after-deadline id lists render as chips resolved to business names.
- Executor A updated one assertion in `tests/firestore-timestamps.test.ts` for the new
  `reminders_sent` shape — outside its ownership map, correct and necessary.

### Verification and the concurrency fix (`rework/p3-fix`)
- Three adversarial verifiers (every commit green; contract + security; timeline
  behaviour) passed the branch except for one **blocker**: the engine's overlapping-run
  guard was a read-then-write, so two genuinely concurrent runs — a manual "run now"
  during a scheduled tick, or a slow run crossing one — both sent. Reproduced: two
  simultaneous runs on a date with two producers produced four `checkin_link` texts.
- **Fix — the log row is the lock.** `sendSms()` gains `dedupe_key`: the `messages` row is
  written under that deterministic id with Firestore's atomic `create()` *before* the
  provider is called, so a second caller throws `DuplicateSendError` and never reaches
  voip.ms. Every engine send carries a key (`checkin_link:<date>:<producer>`,
  `checkin_reminder:<date>:<producer>:<offset>`, `deadline_summary:<date>:<user>`); a
  duplicate counts as "already sent", never as a failure. Each engine step takes a
  `workflow_locks/<date>__<step>` lock the same way (stale after 10 minutes — longer than
  the function can live — then taken over). The staff resend route deliberately carries
  no key. `tests/helpers/fake-db.ts` gained `create()` with the SDK's `ALREADY_EXISTS`
  failure shape. The same reproduction now yields two texts, one per producer, with the
  second run reporting `skipped_claimed: 1`; five concurrent runs across the whole
  timeline, an interrupted run followed by retries, and a resend racing the engine are
  all covered in `tests/checkin-workflow-concurrency.test.ts`.
- `tests/phase3-e2e.test.ts` (the contract's §7.5 flow, owed by the integrator): boots the
  whole app, runs the engine to mint a link, exercises `GET`/`POST /api/checkin/:token`,
  the voip.ms webhook with `YES`, the reminder and deadline ticks, the staff status route
  and the `/status` no-op — twice, once per the contract's two-producer example and once
  with a lone responder.
- **Round 2 (`rework/p3-fix2`, after a second adversary):** every engine step had still
  written the *whole* `actions` map back from its claim-time snapshot, so two runs holding
  different step locks could drop each other's outcome (a lost "superseded" mark meant a
  second reminder text; an admin close's flags could be erased and its email sent again).
  Rule now: **the engine never writes the `actions` map, only fields inside it** —
  Firestore field paths (`actions.checkin_sent_at`, `actions.claims.<step>`,
  `actions.reminder_state.offset_<n>`, …); each reminder offset lives in its own field
  and `marketDateFromData()` derives the `reminders_sent` array every reader uses. The
  voip.ms inbound webhook is idempotent on the provider's message id (`messages/
  inbound:<id>` via `create()`; a redelivery returns before any reply, forward or state
  change). The fake db learned dotted-path `update()` and, like the real SDK, rejects
  `undefined` values — which exposed that the round-1 engine and the generator's revive
  path spread `undefined` optional fields into `update()` and would have failed at their
  first production tick; field-path writes fix that by construction. A transient summary
  email failure no longer holds a step lock. Clocks pinned in every route test that
  reads them (three files carried tokens expiring 2026-09-25; CI would have gone red).
- **Round 3 (integrator):** the admin close now takes the engine's own `deadline` and
  `summary` locks and emails only when it created the summary lock, so a close
  overlapping the engine's deadline tick — or two closes — cannot process a deadline
  twice or email twice (`already_processed` / `in_progress` → 409); the generator creates
  new dates with `create()` so a date another run created (and the engine acted on)
  between its scan and its write keeps its flags; a texted YES/NO creates first and
  updates on `ALREADY_EXISTS`, so a form submission landing in the same instant keeps
  every answer; `tests/markets-routes.test.ts` pins its clock (its fixture's season ends
  2026-10-31); the new inbound log lines carry the last four digits of a phone only. A
  fourth verification pass (green + a forward-clock run of the whole suite at Nov 2026 and
  Mar 2027, and a third concurrency adversary) found no blocker; from its minors: an
  early admin close now also ends the producer-facing texts for that date, and the close
  response says whether it processed the deadline (`processed`) so a close that merely
  lost the summary lock to the engine is still recorded and audited.
- Residual windows, stated plainly (`docs/phase3/notes-fix.md`, `notes-fix2.md`): a
  stale-lock takeover is itself read-then-write — harmless, every text is atomic and
  every flag write is idempotent; the summary *email* has no log row, so it is sent only
  by the run that created the summary lock, a takeover never emails, and an email
  provider failure is logged, not retried (texts are the authoritative channel); a keyed
  text that failed at the provider keeps its row, so the engine never re-attempts it —
  the resend button is the retry path for check-in texts and there is none yet for a
  failed staff summary text; `reminder_state.recipients` counts what the writing run
  sent, so after a takeover it under-reports (presence, not the count, drives the flow);
  two overlapping re-submissions of the same form are last-write-wins; a crashed engine
  run plus a `notify: false` close inside the same stale-lock takeover window can leave
  both `summary_sent_at` and `summary_skipped` set (staff were told; the flags disagree);
  `scripts/import-survey.mjs --write` still writes market dates whole and must not be
  re-run against a live season while the engine acts on those dates.
- 342 tests (32 files) after round 3; typecheck, web typecheck and the static build
  green at every commit.

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
