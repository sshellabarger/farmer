# SJCA Market Manager — Specification

**Version:** Step 1 draft, 2026-09-20. Supersedes the FarmLink v1 design (`README.md`,
`farmlink_architecture.md`) which will move to `archive/`.
**Status (2026-09-21): Phase 1 complete and deployed** from `main` `f966cc8`. FarmLink v1
is retired in production: functions `processRecurringOrders`, `freshnessAlerts` and
`sendNotification` deleted; `api` and `processReminders` redeployed from the retired code
base; hosting released with the transition pages and the SJCA legal pages; all ten v1
composite indexes deleted; the eleven retired collections deleted (§4.6). **Phase 2 built
and merged 2026-09-21** — markets with configurable schedules, producers and applications,
roles, the structural test mode, the admin web app and the survey importer
(`docs/phase2-contract.md`, `CHANGELOG.md`) — **deployed 2026-09-22** with the 2026 WLRFM
survey history imported (D20: 39 producers, 23 dates, 508 check-ins, no phone numbers).
**Phase 3 built, merged and deployed 2026-09-23** — check-in links and texts, reminders,
deadline flagging, STOP/HELP/YES/NO, quiet hours, the `/checkin` page and the market-date
admin page (`docs/phase3-contract.md`, `CHANGELOG.md`); the first engine tick processed
the one in-window date silently, as designed. The same
day `farmlink.us` was reconnected to Firebase Hosting (it had been parked at the registrar;
production `APP_URL` had been the `web.app` address) and a hotfix shipped for Firestore
`Timestamp` reads (`src/utils/dates.ts`).
Items marked **⚠ OPEN** are proposals with a default, not settled facts.

---

## 0. How to read this

§1–§5 are what the audit found and what must happen *before* feature work. §6–§8 are the
product spec (the owner's brief, refined). §9 is the consolidated list of decisions the
owner must make. Nothing in §3–§5 is executed until §9 is answered and Phase 1 approved.

---

## 1. Current state — corrected

> §1 is the audit snapshot of **2026-09-20**, kept as the record of what v1 was. v1 was
> retired in production on 2026-09-21 — see §4.6 for what is deployed now.

### 1.1 What the repo actually is

The owner's brief described the stack as Node 20, Fastify 5, PostgreSQL 16 + PostGIS,
Kysely, BullMQ + Redis 7, Telnyx/Twilio, with 14 SQL tables. That description was copied
from `README.md` (Mar 24 2026) and is **stale**. Commit `ee2ab6a` (2026-05-31, "Code
change to run on firebase") deleted `src/db/database.ts`, `src/db/migrate.ts`, six
migrations, `src/db/seed.ts` and three BullMQ worker files. The initial commit `e7b9431`
(2026-03-23) contained `src/services/twilio.ts`, replaced by Telnyx one day later.

| Brief said | Reality (verified in code and in the live project) |
|---|---|
| Node 20 | Node 22 (`firebase.json`, `package.json engines`, commit `094f9f1`) |
| Standalone Fastify server on :3000 + worker | Fastify mounted inside **one** Cloud Function v2 `api` (`src/functions.ts:121-146`); `src/server.ts` is dev-only |
| PostgreSQL + PostGIS + Kysely, 14 tables | **Firestore**, schemaless, admin SDK only. 19 top-level collections + 3 subcollections referenced in code (§1.4). No migrations exist. |
| BullMQ + Redis 7 | Cloud Scheduler (`onSchedule`, 3 jobs) + a Cloud Tasks path that **has never executed in production** (§1.6) |
| Telnyx / Twilio | `SMS_PROVIDER=voipms` in prod. Telnyx code present but no keys deployed (route rejects everything). WhatsApp code present, unconfigured (verify handshake always 403s). Twilio: gone since Mar 24. |
| Docker | `docker-compose.yml` (Postgres+Redis) is referenced by nothing. **Nothing is deployed via Docker.** |
| "Firebase config in the repo" | Firebase **is** the deployment: Functions + Hosting (static) + Firestore + Storage, project `arkansaslocalfoodnetwork`. |

### 1.2 What is deployed (verified with gcloud on 2026-09-20)

- **Functions (all ACTIVE, GEN_2, deployed 2026-07-06 13:41 UTC):** `api`,
  `processRecurringOrders`, `freshnessAlerts`, `processReminders`, `sendNotification`.
- **The deployed bundle is byte-identical to HEAD (`8c4cfea`).** Both "undeployed" fixes
  in the triage log (`d8fca5e`, `8c4cfea`) shipped within minutes of being committed. The
  triage log entries from Jun 29 to Jul 28 repeated an unchecked claim.
- **Cloud Scheduler jobs, all ENABLED and firing today:**
  `firebase-schedule-processRecurringOrders-us-central1` (00:00 CT, 0 active orders — no-op),
  `firebase-schedule-freshnessAlerts-us-central1` (07:00 CT — **times out at 120 s with a
  504 on 9/18 and 9/20 but still texts one producer daily about two expired items**),
  `firebase-schedule-processReminders-us-central1` (every 15 min, 6 active reminders, healthy).
- **Cloud Tasks queue** `sendNotification` (RUNNING, 0 tasks, never used).
- **Hosting:** static export (56 files). `frameworksBackend` in `firebase.json` is inert.
- **Storage bucket** `arkansaslocalfoodnetwork.firebasestorage.app`: 17 objects under `uploads/`.
- **Firestore (`nam5`, native):** PITR **disabled**, delete protection **disabled**,
  **no backup schedules, no backups**, version retention 1 hour.
- **CI:** `.github/workflows/firebase-hosting-pull-request.yml` is dead — pull_request-only
  (no PR has ever existed), project id misspelled `arkansaslocaldfoodnetwork`, runs the
  root `tsc` instead of the web build. All deploys are manual from the owner's machine.
- **Deploy status of local tooling:** `gcloud` and the Firebase CLI both authenticated as
  of 2026-09-20.

### 1.3 Live pilot — the stop-and-tell-me rule fires

FarmLink v1 is a **live pilot with real users and real data**, confirmed by three
independent refuters (documentary evidence; Firestore was not queried by the audit):

- A real order placed by a real buyer to a real producer (order number format
  `ORD-XXXXXXXX`, not the seed's `ORD-DEMO*`), real inventory rows hand-corrected on Jul 6,
  13 real feedback docs (Jun 1–Jul 3), 6 real reminders that fire every Sunday,
  2 `error_alerts`, ~113 `notifications` (85 reminder, 17 new_inventory, 10 order_update,
  1 new_order), FCM push tokens, real conversation transcripts, 17 uploaded photos.
- Real and seed data **may be commingled**: `src/db/seed-firestore.ts` hardcodes the
  production project id and is wired as `npm run seed`. Seed rows are identifiable
  (`+15551000xxx` phones, `ORD-DEMO001/002`, `inventory_id: 'demo'`).
- Last logged user activity: Jul 3–6 2026. The pilot may be dormant; its data is not.
- `uploads/` at the repo root is **not** production data (git-ignored, Mar 22–23 dev
  test files, three byte-identical duplicates).

**Consequence:** no collection or Storage object is deleted before a verified export, PITR
is enabled first, and the owner approves the delete step explicitly (§4).

### 1.4 Firestore collections actually referenced in code

`src/db/firestore.ts`'s `collections` map is **dead code** (zero importers) and lists 12
of these. The authoritative list comes from `.collection('…')` literals:

| Collection | Verdict | Real data? | Notes |
|---|---|---|---|
| `users` | **adapt** | yes | roles `farmer\|market\|both\|admin`; `fcm_tokens`; phone is the identity key |
| `farms` | **adapt → `producers`** (⚠ OPEN D3) | yes | the pilot's real producers are these docs |
| `markets` | **retire** (export, delete) | yes | **buyers** (grocer/restaurant/…). Must not be reused. |
| `products`, `inventory`, `farm_market_rels`, `orders` (+`order_items`), `recurring_orders` (+`recurring_order_items`), `deliveries`, `upload_links` | **retire** (export, delete) | yes | ordering domain |
| `conversations` (+`messages`) | **archive** (⚠ OPEN D9) | yes | v1 AI-chat transcript log; not a full send log |
| `notifications` | **archive** (export, delete) | yes | three doc shapes keyed to retired entities |
| `view_links` | **retire**; pattern reused as `link_tokens` | transient | 24 h TTL by field, never cleaned |
| `otps` | **keep** | transient | |
| `reminders` | **keep** (⚠ OPEN D6) | yes | 6 live docs |
| `feedback` | **keep** | yes | 5 open items |
| `invites` | **keep** | yes | |
| `admin_broadcasts` | **keep** | yes | |
| `error_alerts` | **keep** | yes | |

Composite indexes: **all 10 in `firestore.indexes.json` are unused** (code sorts in
memory); 9 belong to retired collections. The one index `products.ts` needs is missing.
Only the `conversations` index is worth keeping if that collection stays.

### 1.5 Security findings (independent of the rework — see §5)

1. **Secrets are in every deployed functions bundle.** `firebase.json → functions.ignore`
   is only `[node_modules, web, .git, uploads]`; firebase-tools does not read `.gitignore`.
   The live archive in `gs://gcf-v2-sources-…` (10 versions) contains `.env`
   (Anthropic key, JWT secret, voip.ms password, Resend key), `service-account.json`
   (an **Owner-role** service-account private key, created 2026-06-07, no expiry, never
   read by deployed code), and `.claude/settings.local.json` (two Anthropic API keys,
   the voip.ms password, two dev JWTs). Every Cloud Run revision (49+) retains a copy.
   Exposure today is limited to project Owner/Editor/Viewer principals; the GitHub
   remote is public but history is clean.
2. **`JWT_SECRET` has not been rotated since March 2026.** Anyone with the archive can
   mint an admin token. Rotating it logs out all pilot users.
3. **The only live inbound channel is unauthenticated.** `/api/sms/voipms/inbound`
   (GET and POST, reachable on two hostnames) runs warn-and-accept because
   `VOIPMS_WEBHOOK_SECRET` is unset. Anyone can drive the AI tool loop as any registered
   user, trigger `email_send` to arbitrary addresses from the farmlink.us sender, and
   cause welcome texts to any number (SMS pumping).
4. **WhatsApp POST accepts unsigned payloads** (`META_APP_SECRET` unset) and runs mutating
   tools before the reply fails.
5. **Ten deployed v1 endpoints are unauthenticated writes or PII reads** (deliveries
   status, products, recurring-orders CRUD, farm-market-rels, directory/connect which
   texts arbitrary users, open image upload; public `GET /api/farms|markets|directory/*`
   spread phone/email/addresses; `/api/analytics` exposes any farm's revenue). All are
   on the retire list — retirement is also the fix.
6. **Rate limiting is probably one global bucket.** `@fastify/rate-limit` keys on
   `req.ip`, but requests arrive through `fastify.inject` with `127.0.0.1`; 100 req/min
   from anyone throttles everyone, including voip.ms callbacks (which retry).
7. **`.claude/settings.local.json`** (git-ignored, but deployed — see 1) holds a 375-entry
   allowlist including `firebase firestore:delete --all-collections --force`,
   `npm run:*`, `firebase deploy *`, `git push *`, and `Read(//Users/…/**)`.
8. **Legal pages promise what nothing implements** (`web/public/privacy.html`,
   `terms.html`, live): STOP/HELP/START opt-out, 12-month retention, deletion on request,
   Telnyx as processor (voip.ms/Resend/Google unnamed). `farmlink.us` is a parking page.
   A 30-day change-notice clause constrains the cutover timeline. This is live TCPA
   exposure on a live SMS program and **is not fixed by retiring features** — the
   surviving reminder/broadcast plumbing still sends.
9. Secrets are plain env vars on all five functions; four Secret Manager secrets exist
   but nothing binds them (abandoned `defineSecret` migration).
10. `email_send` tool lets the model choose `to_email` and body — a phishing vector via
    finding 3. Retiring the AI flow removes it.

### 1.6 Things the brief assumed that are not true

- **"Keep the queue."** The Cloud Tasks path (`src/tools/notifications.ts` →
  `sendNotification`) has never executed: `CLOUD_FUNCTIONS_URL` is unset everywhere, so
  the enqueue branch is dead; zero task attempts and zero requests since May; all 17
  `new_inventory` notifications were sent directly. Even if enabled it is triple-broken
  (targets queue `notifications`, the real one is `sendNotification`; raw body instead of
  the `{data}` envelope; no OIDC token). **The queue worth keeping is Cloud Scheduler
  (`processReminders` is a working template).** Delayed sends, if ever needed, are a
  rebuild on `getFunctions().taskQueue().enqueue()`.
- **"Reuse the message log tables."** There is no transport-level log. `sendSms` writes
  nothing; OTP, welcome, invite, freshness, recurring-order and alert texts are logged
  nowhere; `notifications` stores neither body nor phone nor provider id; the
  `/api/sms/status` delivery callback is a stub. **The message log is a build (§7.2).**
- **"Development must never send real texts."** No guard exists. `sendSms` always hits
  the carrier; `NODE_ENV` only relaxes OTP checking and webhook verification.
  `src/config/env.ts` runs `dotenv.config({ override: true })` at import in 24 modules,
  so tests run with production credentials in `process.env`; the four existing tests
  are safe only because they `vi.mock` the send functions. **Test mode is a build (§7.3).**
- **Quiet hours / timezone:** `America/Chicago` is hard-coded in four places; the
  `farms.timezone` field is never read; no quiet-hours logic exists anywhere.
- **STOP/HELP handling:** none on any channel. voip.ms cannot do it for you.
- **Admin role:** exists and is honored, but no API path assigns it — the production admin
  was hand-edited in Firestore.

---

## 2. Audit verdicts — reuse, adapt, retire, archive

Consolidated across 22 agents and first-hand review; conflicts resolved as noted.

### 2.1 Backend — `src/`

| Path | Verdict | Reason |
|---|---|---|
| `functions.ts` | **adapt** | Keep the `onRequest`→Fastify bridge (raw body passthrough, error handler before routes, timestamp hook, rate limit) and the `onSchedule` wrapper. Remove retired route registrations, the `/api/view/:token` farmer/market redirect, `processRecurringOrders`, `freshnessAlerts`, `sendNotification`. |
| `server.ts` | **adapt** | Dev runner; prune to the same route list. Extract a shared `buildApp()`. |
| `config/env.ts` | **adapt** | Keep the zod loader. Drop `LFM_*`, `CLOUD_TASKS_*`, `CLOUD_FUNCTIONS_URL`, Telnyx/WhatsApp blocks (⚠ D5), hard-coded `STORAGE_BUCKET`/`FROM_EMAIL` defaults. Add test-mode flags. Stop `override: true`. |
| `config/depot.ts` | **retire** | Single-depot delivery logistics. |
| `db/firestore.ts` | **adapt** | Keep `getDb()`. Replace the dead `collections` map with the real list. |
| `db/seed-firestore.ts` | **retire** | Seeds retired collections into **production**. Replace with an emulator-guarded SJCA seeder. |
| `middleware/rbac.ts` | **adapt** | Keep `authenticate` + `requireRole`; remove the farm/market lookups (3 reads/request) and the five ownership helpers. New roles (§6.9). |
| `routes/auth.ts` | **adapt** | Keep `/otp/request`, `/otp/verify`, `/me`, `/check-phone`. Replace `/signup` (creates farm/market docs) with the application intake. |
| `routes/sms.ts` | **adapt** | Keep `captureRawBody`, `timingSafeEqualStrings`, `normalizePhone`/`ownsPhone`, the voip.ms handler and its secret check. Replace `processInboundMessage` with the new inbound handler (§7.4). Telnyx/WhatsApp handlers → archive (⚠ D5). Rewrite `/conversations`. |
| `routes/admin.ts` | **adapt** | Broadcast + `admin_broadcasts` audit log is the most reusable v1 feature. Strip order/inventory counters; batch the loop. |
| `routes/profile.ts` | **adapt** | Keep `GET /`, `PUT /user`; drop farm/market; use shared `authenticate`. |
| `routes/invite.ts` | **adapt** | Invite-by-text is on-mission; swap the business lookup. |
| `routes/push.ts`, `routes/errors.ts`, `routes/feedback.ts` | **keep** | Generic. |
| `routes/reminders.ts` | **keep** (⚠ D6) | Generic; not in the brief either way. |
| `routes/uploads.ts` | **adapt** (⚠ D7) | Generic upload is reusable for logos/booth photos **only after adding auth** (currently open to the internet). `/produce/:token` flow retires. |
| `routes/farms.ts`, `markets.ts`, `inventory.ts`, `orders.ts`, `recurring-orders.ts`, `deliveries.ts`, `products.ts`, `relationships.ts`, `directory.ts`, `analytics.ts` | **retire** | Ordering/buyer domain; several are unauthenticated write/PII surfaces. |
| `services/sms.ts` | **keep** | The one choke point (14 importers). Add: uniform log write, console provider, real-send guard, hoist the GSM-7/UCS-2 splitter from `voipms.ts`. |
| `services/voipms.ts` | **keep** | Live outbound path. |
| `services/telnyx.ts`, `services/whatsapp.ts` | **archive** (⚠ D5) | Correct, tested verifiers; unconfigured in prod. |
| `services/otp.ts` | **keep** | Switch to `crypto.randomInt`; add per-phone send throttle; rebrand the message. |
| `services/push.ts` | **adapt** | Keep `notifyByPhoneSmsFirst`; delete push-first `notifyByPhone` (the Jun 7 bug). |
| `services/email.ts` | **adapt** | Keep `sendEmail`/`baseLayout`; drop the three report builders. |
| `services/error-notify.ts`, `support-notify.ts`, `storage.ts` | **keep** | Update prompt/strings. |
| `services/reminders.ts` | **keep** (⚠ D6) | Cleanest example of the SMS-authoritative + audit-row pattern; template for the check-in scheduler. |
| `services/conversation.ts` | **retire** (⚠ D8) | Prompt, context builder and `MUTATING_TOOLS` are all ordering. The tool-loop harness (history load, tool loop, hallucination guard, date injection, `ai_metadata`) is documented in `archive/` as extractable if an assistant is ever wanted. |
| `services/order-notifications.ts`, `recurring-orders.ts`, `freshness-alerts.ts`, `lfm-sync.ts`, `produce-photo.ts`, `imagen.ts` | **retire** | Ordering/inventory. `imagen.ts` never worked (Vertex AI API not enabled). |
| `tools/index.ts` | **adapt** (pattern) / **retire** (content) | Registry shape is reusable; 20 of 28 tools retire. |
| `tools/feedback.ts`, `tools/reminders.ts` | **keep** | Domain-neutral (only matter if an assistant survives — ⚠ D8). |
| `tools/signup.ts` | **retire** | Unreachable by real texters (the route bounces unknown numbers first). |
| `tools/inventory.ts`, `orders.ts`, `recurring.ts`, `delivery.ts`, `markets.ts`, `notifications.ts`, `analytics.ts`, `connections.ts`, `email.ts` | **retire** | Ordering domain; `email.ts` is also a phishing vector. |
| `types/schema.ts` | **adapt** | Keep the string-union + const-array pattern. Retire `MARKET_TYPES`, all order/inventory/delivery enums, roles `market`/`both`. It is documentation, not enforcement, and already disagrees with stored data. |
| `types/fastify.d.ts` | **keep** | |
| `utils/jwt.ts` | **keep** | Use `crypto.timingSafeEqual` when touched. |
| `utils/http-error-handler.ts`, `serialize.ts`, `sort.ts`, `errors.ts` | **keep** | |
| `utils/view-link.ts` | **retire**; pattern → `link_tokens` (§7.5) | `Math.random` tokens, mints a 7-day session, tab names are retired. |
| `utils/freshness.ts` | **retire** | Inventory aging. |

### 2.2 Web — `web/`

| Path | Verdict | Reason |
|---|---|---|
| `lib/api.ts` | **adapt** | Keep `request<T>()` and the auth/profile/feedback/admin/push/invite helpers; drop ~60% of the rest. |
| `lib/auth-context.tsx`, `app/login/page.tsx` | **adapt** | OTP login is right; remove role pick and farmer/market redirects. |
| `app/admin/page.tsx` | **adapt** | Best template in the repo (auth guard, tabs, sortable table, confirm-before-send broadcast). |
| `app/settings/page.tsx` | **adapt** | Generic form kit (`Field`, `SelectField`, `AddressForm`, `ContactList`, `SaveBar`, `SectionCard`) is reusable; farm/market tabs retire. |
| `app/feedback/page.tsx`, `components/error-reporter.tsx`, `components/icons.tsx`, `app/globals.css`, `next.config.ts`, `package.json` | **keep** | |
| `app/layout.tsx`, `components/header.tsx`, `components/pwa-register.tsx`, `public/manifest.webmanifest`, `public/sw.js` | **adapt** | Rebrand; remove the inline "nuke every service worker" script that fights `pwa-register` (defeats offline cache, destabilises FCM); change cache name so installed PWAs update. |
| `app/signup/page.tsx` | **adapt** (⚠ D4) | Step scaffolding reusable; content becomes the public application form. |
| `lib/constants.ts` | **adapt** | Keep the number + `smsHref`; drop `DEPOT_ADDRESS`. |
| `lib/firebase-push.ts` | **keep** (⚠ D10) | Only if push stays. |
| `components/reminders-card.tsx` | **keep** (⚠ D6) | |
| `app/page.tsx`, `app/about/page.tsx` | **archive** content, rewrite | Markets the retired product to live pilot users; the seven-channel copy is SJCA institutional knowledge. |
| `components/phone-sms.tsx` | **archive** | Marketing prop. |
| `app/farmer/page.tsx`, `app/market/page.tsx`, `components/dashboard.tsx` (1743 lines), `components/chat-widget.tsx`, `app/upload-photo/page.tsx`, `lib/food-rescue.ts` | **retire** | v1 dashboards and AI chat. Free `/market` and do not reuse it. |
| `public/privacy.html`, `public/terms.html` | **adapt** (rewrite, same deploy as retirement) | See §1.5(8). |
| `public/farmlink-overview.mp4` (15.9 MB) | **archive** (move out of hosting) | Demos the retired product; ships in every deploy. |
| `tsconfig.tsbuildinfo` | **retire** from git | Tracked build cache. |

### 2.3 Config, tooling, tests

| Path | Verdict | Reason |
|---|---|---|
| `firebase.json` | **adapt** | Keep hosting/rewrite/rules. **Fix `functions.ignore`** (§5) or move functions to `functions/`. Remove inert `frameworksBackend` (⚠ D11). |
| `.firebaserc` | **adapt** (⚠ D1) | Add an alias if SJCA gets its own project. |
| `firestore.rules`, `storage.rules` | **keep** | Deny-all is correct for admin-SDK-only access. |
| `firestore.indexes.json` | **adapt** | Prune to what the new queries need. |
| `package.json` | **adapt** | Drop `@google-cloud/tasks`; make `build` clean `dist/`; guard/replace `seed`. |
| `tsconfig.json`, vitest defaults, `tsx`, `zod` | **keep** | Consider type-checking `tests/`. |
| `.env.example` | **adapt** | Fix drift (`PORT`→`LOCAL_PORT`; missing `STORAGE_BUCKET`, `FIREBASE_CONFIG`); voip.ms first; add test-mode flags; drop retired blocks. |
| `.github/workflows/firebase-hosting-pull-request.yml` | **retire** (⚠ D12) | Dead and misconfigured. |
| `docker-compose.yml` | **archive** | Unused since May. |
| `tests/sms-webhook-auth.test.ts` | **adapt** | Keep voip.ms cases; flip the "no secret configured" case once enforcement is on; Telnyx cases archive with `telnyx.ts`. |
| `tests/whatsapp-signature.test.ts` | **archive** (with `whatsapp.ts`) | |
| `tests/validation-error-handler.test.ts` | **adapt** | Re-point at a surviving route. |
| `tests/signup-market-types.test.ts` | **retire** | Tests the old buyer enum. |
| `docs/MONITORING.md` | **adapt** | Lists 3 of 5 functions; contains the owner's phone/email as examples. |
| `docs/interface-review-2026-06-12.md` | **archive** | Its "SMS channel robustness" checklist is a ready requirements list for §7.4. |
| `docs/triage-log.md` | **archive** (⚠ D13) | Commit the 12 uncommitted runs first; add a correction note; stop or retarget the daily task that reads it. |
| `README.md`, `farmlink_architecture.md`, `farmlink_v2.jsx`, both SVGs, the ERD | **archive**; README rewritten | Source of the stale spec. |
| `uploads/`, `dist/`, `.firebase/`, `.DS_Store`, empty `src/plugins/`, `src/db/seeds/` | **delete / ignore** | Not data, not code. |
| `.env`, `service-account.json` | **keep local, exclude from deploys**; rotate the SA key (§5) | |
| `.claude/settings.local.json` | **owner scrubs** (§5) | Not a repo file; contains secrets and destructive allows. |

---

## 3. Archive plan

Everything below is reference only; nothing in `archive/` is imported by the application.
`archive/` is added to `firebase.json → functions.ignore` so it never ships.

```
archive/
  README.md                       # the paragraph below
  design-2026-03/
    README-original.md            # current README.md, verbatim
    farmlink_architecture.md
    farmlink_system_architecture.svg
    farmlink_ai_conversation_engine_flow.svg
    farmlink_entity_relationship_diagram.html
    docker-compose.yml
  prototype/
    farmlink_v2.jsx               # single-file React click-through mock (never wired to the API)
  postgres-era/                   # recovered from git history
    migrations/001_initial_schema.ts … 006_add_feedback.ts   (git show ee2ab6a^:src/db/migrations/…)
    database.ts, migrate.ts, seed.ts                          (ee2ab6a^)
    workers/index.ts, notification-queue.ts, proactive-jobs.ts (ee2ab6a^)  ← the real "BullMQ"
    services/twilio.ts                                        (git show e7b9431:src/services/twilio.ts)
  v1-web/                         # retired dashboards, for design reference
    dashboard.tsx, chat-widget.tsx, page.tsx (landing), about/page.tsx, phone-sms.tsx
  v1-ai-harness/
    conversation.ts, tools-index.ts    # the tool-calling loop, kept as a pattern reference
    NOTES.md                          # what is generic (loop, hallucination guard, date injection) vs domain
  v1-channels/
    telnyx.ts, whatsapp.ts + their tests   # decision D5: voip.ms only
  v1-web-links/
    view-link.ts                    # the texted /api/view/<token> pattern; reborn as link_tokens (§7.5)
  reviews/
    interface-review-2026-06-12.md
  ops-log/
    triage-log-2026-06-07_to_2026-07-28.md   # with a correction note re. deploy claims
    MONITORING-2026-06.md                     # snapshot before rewrite
  firestore-schema-2026-09.md     # generated in Phase 1: every collection, sampled field map, doc counts
```

**`archive/README.md`:** "This folder preserves the pre-SJCA history of FarmLink, a
text-first farm-to-buyer ordering platform piloted in Little Rock, AR (Mar–Jul 2026).
`design-2026-03/` holds the original design package written for a Fastify + PostgreSQL +
BullMQ/Redis stack that was replaced by Firebase Cloud Functions and Firestore on
2026-05-31 (commit `ee2ab6a`); the 14 entity names in the ERD survived as Firestore
collection names. `postgres-era/` is that original code, recovered from git history — it
is where the Postgres/BullMQ/Twilio description in later planning documents came from.
`prototype/` is a click-through mock never wired to the API. `v1-web/` and
`v1-ai-harness/` are the retired dashboards and the Claude tool-calling loop, kept as
design reference. `reviews/` and `ops-log/` are the June 2026 interface review and the
daily pilot triage log (its 'deploy still pending' entries from Jun 29 on were wrong —
production was at HEAD). Do not reuse the buyer-facing 'market' concept described here:
in the SJCA tool a market is a farmers-market event. The final v1 code is tagged
`farmlink-v1-final`; branch `archive/farmlink-v1`."

**Not in git:** the Firestore and Storage exports go to a GCS bucket, never into the repo
(PII). PII in archived docs (owner phone/email in MONITORING.md, producer and buyer names
in the triage log) is scrubbed at archive time (⚠ D13).

---

## 4. Migration plan (Phase 1) — Firestore, Storage, functions, indexes

Firestore has no schema migrations. "Drop old tables through a proper migration" means:
**export → verify → delete, scripted, in this order, with two explicit owner check-ins.**

### 4.0 Prerequisites
- `firebase login --reauth` (gcloud is already authenticated).
- Owner answers §9 D1–D13 (D1, D3, D5, D6, D8, D9 gate this plan).
- Commit the 12 uncommitted triage-log runs (owner) so nothing is lost by branch work.
- **Enable Firestore PITR** (`gcloud firestore databases update --enable-pitr`) and
  **enable delete protection**. This is the only rollback beyond one hour.

### 4.1 Freeze the past
1. `git tag -a farmlink-v1-final 8c4cfea` — matches the deployed bundle exactly.
2. `git branch archive/farmlink-v1 farmlink-v1-final`. Push both.

### 4.2 Export (nothing deleted yet)
3. `gcloud firestore export gs://arkansaslocalfoodnetwork-exports/pre-sjca-2026-MM-DD/`
   for the **whole database**, plus a second export with an explicit
   `--collection-ids` list that names the subcollections (`order_items`,
   `recurring_order_items`, `messages`) — the exporter matches subcollections by id only
   when listed.
4. `gcloud storage cp -r gs://arkansaslocalfoodnetwork.firebasestorage.app/uploads/ gs://…/pre-sjca-…/storage/`.
5. Generate `archive/firestore-schema-2026-09.md`: per collection, `count()`, a sampled
   field map, and which docs match the seed signatures.
6. Export `orders` (+items) and `feedback` to CSV for SJCA's records (Storage, not git).
7. **Check-in #1:** show the owner the counts table (real vs seed per collection) and the
   export manifest before anything is removed.

### 4.3 Stop the live automation — hold lifted 2026-09-21 (all users are test accounts; D14 withdrawn)
8. Remove the `processRecurringOrders`, `freshnessAlerts` and `sendNotification` exports
   from `src/functions.ts` (and `processReminders` if D6 = retire). `rm -rf dist &&
   npm run deploy:functions` — the CLI prompts to delete each missing function **and
   removes its Cloud Scheduler job**. Console deletion would leave the jobs behind.
9. Verify `gcloud scheduler jobs list` and `gcloud tasks queues list`; delete the
   `sendNotification` queue if it survives.
10. **Legal timing (⚠ D14):** the published terms promise 30 days' notice of material
    changes. Decide whether a transition text to pilot users precedes this step.

### 4.4 Retire code (each step a labeled commit, tsc + tests green) — **DONE on `rework/phase-1-retire` (2026-09-20)**; merge/deploy held for D14
11. Routes → services → tools → web pages/components → tests → `schema.ts`/`env.ts`
    cleanup → `firebase.json` ignore list → `README.md` rewrite. Message format:
    `Retire <what>, replaced by <what>. See tag farmlink-v1-final.`
12. Replace the v1 texted-link landing spots (`/farmer`, `/market`, `/upload-photo`,
    `/api/view/:token`) with an intentional "this program has changed" page, not a 404.
13. Rewrite `privacy.html` / `terms.html` **in the same hosting deploy** as the retirement.

### 4.5 Delete data
14. Purge identifiable seed docs first (`+15551000*` phones, `ORD-DEMO*`,
    `inventory_id == 'demo'`) across all collections — by content, never by collection.
15. (D3 deferred) `users` are not migrated in Phase 1; `rbac.ts` drops its farm/market
    lookups in §4.4 so deleting `markets` cannot break admin login.
16. **Check-in #2:** owner confirms the exact collection list.
17. `db.recursiveDelete()` per retired collection (subcollections go with the parent):
    `markets`, `products`, `inventory`, `farm_market_rels`, `orders`, `recurring_orders`,
    `deliveries`, `upload_links`, `view_links`, `notifications`, `conversations` (D9: yes).
    **Not in Phase 1:** `farms` and `users` stay untouched until the post-testing
    `producers` migration (D3). Deletion also waits for check-in #2 and the D14 window.
18. Prune `firestore.indexes.json`; `npm run deploy:firestore` (accept index deletions).

### 4.6 Verify — results, 2026-09-21 (~12:25 UTC)
19. **Functions:** `firebase deploy --only functions --force` from `main` `f966cc8`: `api`
    and `processReminders` updated; `sendNotification`, `processRecurringOrders`,
    `freshnessAlerts` deleted (CLI-confirmed). Bundle 152 KB (was 17 MB): `.env`,
    the service-account key and `.claude/` are no longer packaged. Smoke: function
    `/health` 200; Hosting `/api/health` 200; `/api/view/<token>` 410; `/api/farms` 404.
    **Hosting + Firestore:** released; `firestore: Deleting 10 indexes` succeeded; rules
    unchanged. **Data (§4.5):** all eleven retired collections and their subcollections
    at 0; kept collections unchanged (users 5, farms 2, reminders 6, feedback 10, invites 4,
    error_alerts 2, otps 0, admin_broadcasts 0, messages 0). Storage untouched (17 objects).
    **Not yet confirmed via gcloud** (token expired mid-run): scheduler jobs removed with
    their functions; whether the empty `sendNotification` Cloud Tasks queue survived —
    delete it if so. **Known follow-up:** `processReminders` still writes its audit row to
    `notifications`, so that collection reappears on the next reminder send; Phase 2 moves
    the write to `messages`. OTP login and the voip.ms inbound stopgap are exercised by the
    owner's Phase 1 demo checklist rather than by an automated check.
20. `CHANGELOG.md` "Deployed" entry written; this §1 marked as the 2026-09-20 snapshot.

---

## 5. Day-one security actions (owner-side, before or alongside Phase 1)

These do not depend on any product decision and each is cheap.

| # | Action | Why |
|---|---|---|
| S1 | Rotate **both** Anthropic keys, the voip.ms API password, the Resend key. Update `.env`, redeploy functions (rotation without redeploy takes the live SMS assistant down). | In deployed bundles and in `settings.local.json`. |
| S2 | Rotate `JWT_SECRET` (schedule it — logs out every pilot user, voids outstanding view links). | Unchanged since March; in the bundles. |
| S3 | **Delete the `littlehelper` service-account key** (Owner + infrastructureAdmin, no expiry). Deployed code never reads it. Recreate a narrow-scope key outside the repo if local scripts need one. | In 10 bundle versions. |
| S4 | Extend `firebase.json → functions.ignore`: `.env*`, `*service-account*.json`, `.claude`, `.firebase`, `.github`, `docs`, `tests`, `archive`, `*.md`, `*.svg`, `*.jsx`, `uploads`, `.DS_Store`, `web` (keep), `node_modules`. Better: move functions to `functions/` (allow-listed by construction) — ⚠ D11. | Stops the leak. |
| S5 | After S1–S3: `gsutil rm -a gs://gcf-v2-sources-…/**` and delete non-serving Cloud Run revisions. | Old copies persist until purged. |
| S6 | Scrub `.claude/settings.local.json`: remove the ~25 secret-bearing entries, the `firestore:delete --all-collections --force` allow, `npm run:*`, `firebase deploy *`, `git push *`, wide `Read(...)` allows; drop the ~80 trader-project entries. Consider a committed read-only `.claude/settings.json`. | Prompt-free destructive commands against the live DB. |
| S7 | voip.ms portal: set the callback URL to `…/api/sms/voipms/inbound?secret=<value>` **first**, then set `VOIPMS_WEBHOOK_SECRET`, then deploy. (Pending since 2026-06-12.) | Closes §1.5(3). Order matters or inbound texts are rejected. |
| S8 | Remove the WhatsApp inbound route (or set `META_APP_SECRET`). | §1.5(4). |
| S9 | Enable Firestore PITR + delete protection. | No rollback exists today. |
| S10 | Move secrets to Secret Manager / `defineSecret()` during Phase 2. | Plain env vars readable by any viewer. |

---

## 6. Product specification

### 6.1 What SJCA does today, manually
Two farmers markets run with a Google Form, email and Zeffy:
- **West Little Rock Farmers Market (WLRFM)** at Breckenridge Village. Food only.
  Currently Saturdays 8:00–12:00, mid-April through October.
- **Argenta** market, North Little Rock. Currently Thursday nights. This will change.

Some producers sell at both. Each market has its own approval list. After each market,
producers must complete a weekly status form within 3 days so SJCA can plan and promote
the next one; non-responders cannot hold their spot. Once responses are in, SJCA assigns
booths, builds a Mailchimp campaign, and updates the `/thisweek` page on the market
website (Duda).

### 6.2 Principles
- **Text-first.** Producers never need to log in: every touchpoint is a text with a
  personal link to a short mobile form. Every other surface promotes the text channel.
- **Nothing publishes without an admin click.** Drafts (booth map, Mailchimp campaign,
  `/thisweek` content) are always reviewed.
- **Sales figures are admin-only and reported only in aggregate.** We promise producers this.
- **Schedules are data.** No day, time, offset, timezone or quiet-hour window is ever
  hard-coded; a Thursday-night market and a Saturday-morning market run on the same logic.
- **Two markets now, built for more.**

### 6.3 Core data (proposed Firestore collections — ⚠ OPEN D2 for names)

Field names `snake_case`; ids uuid v4; timestamps stored as Firestore Timestamps; all
market-local times stored as ISO strings *and* resolved UTC instants.

| Collection | Purpose | Key fields |
|---|---|---|
| `farmers_markets` | a market SJCA runs (WLRFM, Argenta) | `name`, `slug`, `location{name,address}`, `timezone` (default `America/Chicago`), `schedule` (6.4), `workflow` (6.5), `quiet_hours{start,end}`, `booth_layout` (6.7), `website{duda_site_id, thisweek_page_id, vendor_collection_id}`, `mailchimp{audience_id, template_id}`, `active` |
| `market_dates` | one record per market per occurrence, **materialized** from the schedule | `market_id`, `date` (YYYY-MM-DD local), `start_at`, `end_at` (UTC), `status: collecting\|lineup_final\|published\|cancelled`, `sponsor_id?`, `schedule_version`, `actions{checkin_sent_at?, reminders_sent:[…], deadline_at, deadline_processed_at?, drafts_generated_at?, approved_at?, booth_texts_sent_at?}`, `cancellation_reason?`, `extra_questions[]` (`{key, prompt, type: text\|choice\|yes_no, options?}` — the rotating weekly question and one-off polls such as winter-season interest) |
| `producers` | a vendor business | `business_name`, `contact_name`, `phone?` (E.164, unique when present — imported producers have none until they apply), `email` (primary), `emails[]` (every address seen; the identity key for imports), `aliases[]` (name variants seen on forms), `products[]`, `category`, `documents[]`, `sms_consent{status, at, source}`, `sms_opt_out_at?`, `user_id?`, `legacy_farm_id?`, `notes` |
| `producer_memberships` | one per producer per market | `producer_id`, `market_id`, `status: applied\|under_review\|approved\|active\|inactive`, `usual_booth_id?`, `fee_plan: weekly\|season\|both`, `approved_at?`, `approved_by?`, `history[]` |
| `applications` | public intake (replaces the Google Form) | page-1: `email`, `business_name`, `contact_person`, `phone`; `markets_applied[]`; page-2 fields from the owner's CSV (⚠ D15); `status: new\|under_review\|approved\|declined`, `reviewed_by?`, `producer_id?` |
| `checkins` | weekly status per producer per market date | `producer_id`, `market_id`, `market_date_id`, `estimated_sales` (**admin-only field**; parsed number + raw text), `transactions_estimate` (parsed int + raw), `sold_out_items[]`, `unsold_items[]`, `attending_next: bool`, `bringing_next[]`, `feedback`, `extra_answers{key: value}` (answers to that date's `extra_questions`), `source: form\|import`, `submitted_at`, `token_id?` |
| `booths` | booth map per market | `market_id`, `label`, `position{x,y,w,h}`, `attributes{power, corner, size}`, `active` |
| `booth_assignments` | per market date | `market_date_id`, `booth_id`, `producer_id`, `source: usual\|suggested\|manual`, `assigned_by`, `assigned_at`, `superseded_by?` (history is append-only) |
| `sponsors` | | `name`, `contact{name,email,phone}`, `logo_url`, `website`, `tier_id`, `active` |
| `sponsor_tiers` | **data, not code** | `id`, `name`, `benefits{website_logo, sandwich_board, weekly_mention}`, `sort_order` (seeded: `weekly`, `major`) |
| `sponsor_dates` | | `market_date_id`, `sponsor_id` |
| `payments` | Zeffy payments | `zeffy_id`, `amount`, `currency`, `paid_at`, `payer_email`, `payer_name`, `kind: booth_fee\|sponsorship\|donation\|unknown`, `producer_id?`, `sponsor_id?`, `covers{market_date_ids[]? , season_id?}`, `match_status: auto\|manual\|unmatched`, `raw` |
| `messages` | **every** text sent and received (§7.2) | `direction`, `to`, `from`, `body`, `provider`, `provider_message_id?`, `status: queued\|sent\|delivered\|failed\|received\|simulated`, `status_at`, `error?`, `kind` (`checkin\|reminder\|booth\|broadcast\|otp\|inbound\|…`), `producer_id?`, `market_date_id?`, `sent_by?` |
| `link_tokens` | no-login links (§7.5) | `token` (32 random bytes, base64url), `purpose: checkin\|application\|…`, `producer_id`, `market_date_id?`, `expires_at`, `used_at?`, `max_uses` |
| `users` | admin accounts (adapted) | `name`, `phone`, `email`, `role: admin\|market_manager`, `assigned_market_ids[]`, `fcm_tokens[]`, `active` |
| `audit_log` | admin actions | `actor_id`, `action`, `target{collection,id}`, `before?`, `after?`, `at` |
| kept from v1 | `otps`, `feedback`, `invites`, `admin_broadcasts`, `error_alerts`, `reminders` (D6) | |

### 6.4 Schedule model (per market, admin-editable)

```
schedule: {
  versions: [{
    effective_from: "2026-04-15",           // new versions never rewrite past market_dates
    season_start: "2026-04-18", season_end: "2026-10-31",
    days_of_week: ["saturday"],             // one or more
    start_time: "08:00", end_time: "12:00", // market-local
  }],
  skipped_dates:  [{ date, reason }],       // holidays, weather
  special_dates:  [{ date, start_time, end_time, note }],   // one-offs
}
```

`market_dates` are **generated** (idempotently, by `(market_id, date)`) from the active
version for a rolling window (e.g. 8 weeks). A mid-season change adds a schedule version;
regeneration touches only future dates whose `status = collecting` and whose check-in has
not been sent. Past dates and their check-ins, assignments and messages are never altered.
Cancelling a date sets `status = cancelled` and suppresses its workflow.

### 6.5 Workflow timing (per market; all offsets from `market_date.end_at`)

```
workflow: {
  checkin_offset_min: 60,                 // text goes out 1 h after the market ends
  reminder_offsets_min: [1440, 2880],     // 1 d and 2 d after end, non-responders only
  deadline_offset_min: 4320,              // 3 days (default)
  drafts_offset_min: 4380,                // generate drafts shortly after deadline
}
```

A single Cloud Scheduler job (`processMarketDates`, every 5 min) scans `market_dates`
with `status = collecting` and performs any action whose instant has passed and whose
`actions.*` flag is unset — the proven `processReminders` shape. Every send respects the
market's `quiet_hours` (deferred to the window's end, never dropped) and the producer's
opt-out.

### 6.6 Workflow per market date
1. **After the market ends:** each `active` producer for that market receives a text with
   a personal no-login link (§7.5) to the check-in form, pre-filled with their name. A
   producer in both markets gets one check-in per market.
2. **Reminders** go to non-responders only, at the configured offsets.
3. **At the deadline:** non-responders are flagged `spot_not_held` on that market date;
   admins get a summary (text + email).
4. **Draft step:** the app suggests booth assignments from `usual_booth_id` and
   `attending_next`; the admin adjusts on the map. The app builds a **draft** Mailchimp
   campaign and **draft** `/thisweek` content: lineup, what producers are bringing, and
   that date's sponsor with logo.
5. **Admin reviews and approves.** Nothing publishes without the click.
6. **After approval:** producers get a text with their booth number.

### 6.7 Booths and assignments
A booth map per market (simple grid/positions; a visual editor in the admin app). Each
membership records the producer's usual spot. Assignments are per market date with
append-only history (`superseded_by`).

### 6.8 Sponsors, fees, payments
Two tiers seeded as data: **weekly sponsor** and **major sponsor** (logo on the main
website and permanently on the sandwich board). Booth fees per week, per season, or both.
Zeffy payments are stored and linked to a producer (booth fees) or a sponsor
(sponsorships/donations) with the market dates or season they cover; unmatched payments
go to a manual match queue. Producer and sponsor lists show paid/unpaid status.

### 6.9 Roles and admin users
- `admin` — everything.
- `market_manager` — scoped to `assigned_market_ids`.
- Producers are **not** users; they act through tokens. (An optional producer login can
  come later.)
- Admin accounts are created by an admin (invite by text → OTP). No self-service admin
  signup. Every admin action writes `audit_log`.
- v1 users with role `farmer` map to producers where they are real vendors; `market`/
  `both` users are buyers and are retired (⚠ D3).

### 6.10 Admin screens
Dashboard (response progress per market for the current date) · market settings and
schedule editor · producer list · application review queue · booth map · sponsor
calendar · payments and match queue · message log · admin user management · season report
(aggregate sales trends, attendance).

---

## 7. Design decisions from the audit

### 7.1 Auth: keep OTP + JWT, extend it
Keep `otps`, `sendOtp`/`verifyOtp`, `signJwt`/`verifyJwt`, `authenticate`, `requireRole`.
Add `assigned_market_ids` to the JWT claims or resolve on request; add `requireMarket(id)`.
Remove the farm/market lookups from `authenticate`. Harden: `crypto.randomInt`,
timing-safe JWT compare, per-phone OTP throttle, a dedicated `OTP_DEV_BYPASS` flag instead
of `NODE_ENV`. ⚠ D16: Firebase Auth is not needed and would force a rules rewrite.

### 7.2 Message log: build `messages`
Wrap `sendSms()` so every outbound write creates a `messages` row *before* the provider
call and updates it after (with `provider_message_id`). Log every inbound in the webhook.
Implement the voip.ms delivery-status callback (`/api/sms/status` is a stub today). v1's
`conversations/messages` is archived, not extended.

### 7.3 Test mode: structural, not conventional
- `SMS_PROVIDER=console` and `EMAIL_PROVIDER=console` log the message and write a
  `messages` row with `status = simulated`.
- Real providers are selectable **only** when `NODE_ENV=production && ALLOW_REAL_SENDS=true`;
  otherwise `sendSms` throws. `.env.example` ships with console providers.
- `env.ts` stops using `override: true`; tests set env explicitly.
- A vitest setup file asserts the console provider before any test runs.

### 7.4 Inbound texting: keyword handler, not an AI loop (⚠ D8)
The check-in flow is link-based, so inbound texts are rare. New handler order:
1. verify webhook secret → 2. log to `messages` → 3. **STOP/UNSUBSCRIBE/CANCEL/END/QUIT**
→ set `producers.sms_opt_out_at`, confirm once, suppress all automated sends;
**START/UNSTOP** → clear it; **HELP** → canned help → 4. `YES/NO` while a check-in is open
→ record `attending_next` → 5. anything else → forward to the market managers'
notification channel and reply with the check-in link if one is open. This also makes the
published privacy/terms promises true.

### 7.5 No-login links: adapt the pattern, not the code
`link_tokens`: 32 random bytes (`crypto.randomBytes`), base64url; scoped to one
`purpose` + one producer (+ one market date); expiry; `used_at`/`max_uses`; **never mints
a session JWT**. The page it opens is server-rendered from the token and pre-filled.
Short enough for SMS via `${APP_URL}/c/<token>`.

### 7.6 Scheduling: Cloud Scheduler only
All timed work is `onSchedule` polling with idempotent action flags on the target doc.
No Cloud Tasks (§1.6). `processReminders` is the template.

### 7.7 Naming
New collections avoid every v1 name that meant "buyer": `farmers_markets` (not `markets`),
`market_dates`, `producers` (not `farms`). The `/market` URL is retired, not reused. The
`market` and `both` user roles are removed before `markets` is deleted.

### 7.8 Local dev
`src/server.ts` stays as the dev runner (or the Firebase emulator — ⚠ D17). A shared
`buildApp()` removes the duplicated route list.

### 7.9 Importing form history: identity by email, never by name
The 2026 weekly-survey export shows why: one producer appears under a business name, a
person's name and three or four spellings, and under several addresses (a business
domain, a personal address, typos). The importer resolves identity with a union of
(normalized email, non-generic email domain, first significant word of the name), records
every variant in `producers.aliases[]` / `emails[]`, maps each response to the latest
market Saturday on or before its timestamp, keeps the raw text beside every parsed number,
and writes `source: import`. The rotating "fun" question and one-off polls become
`extra_questions` on the market date. Sales figures stay admin-only. The export itself
lives in the private bucket (`imports/`), never in the repository.

---

## 8. Build phases

Each phase ends with passing `npm run typecheck` + `npm test`, a `CHANGELOG.md` entry,
and a short demo checklist for the owner.

1. **Audit, archive and migration** — §3, §4, §5. Demo: tag exists; `archive/` builds;
   export manifest; retired functions gone from `gcloud`; prod smoke green.
2. **Markets, producers, applications, admin roles** — schedule model + `market_dates`
   generator, producer/membership CRUD, public application form + review queue, roles and
   `audit_log`, test mode (§7.3), `messages` log (§7.2), secrets to Secret Manager, and the
   form-history importer (§7.9) run once against the 2026 WLRFM weekly survey to seed
   `producers`, `producer_memberships`, `market_dates` and `checkins` as realistic test
   data (⚠ D20). Imported producers have no phone, so nothing can text them.
   Demo: create both markets with real schedules; generate dates; skip a date; submit an
   application; approve at one market only; console-provider sends visible in the log.
3. **Check-ins and text reminders** — `link_tokens`, check-in form, `processMarketDates`,
   reminders, deadline flagging, admin summary, STOP/HELP (§7.4), quiet hours,
   delivery-status callback. Demo: a Thursday-night and a Saturday-morning market both
   produce correct send times from the same code; opt-out works; nothing sends in dev.
   **Built 2026-09-22** (`docs/phase3-contract.md`). Finding: voip.ms offers no outbound
   delivery receipts, so `messages.status` is terminal at `sent` and the callback is a
   documented no-op. Engine sends are idempotent per recipient (the `messages` row is the
   lock), every step — and the admin close — takes an atomic `workflow_locks` claim, and
   every write names field paths inside `actions` rather than the map, so overlapping
   scheduler runs, a manual close and the nightly generator cannot text anyone twice,
   email twice or lose each other's flags (three adversarial verification rounds,
   `CHANGELOG.md`).
4. **Booth assignment** — booth map editor, suggestions, history, booth-number texts.
5. **Sponsors and Zeffy** — tiers as data, sponsor calendar, Zeffy webhook + nightly sync
   (≤100 req/min), email matching, manual match queue, paid/unpaid on lists.
6. **Mailchimp and Duda drafts** — draft campaign from template; audience sync with
   approved producers; Duda vendor collection + `/thisweek` draft; approve-to-publish.
7. **Reports and Google Forms import** — season report (aggregate only), one-time CSV
   import of past weekly responses and applications.

---

## 9. Open decisions (owner) — with defaults

**Decided 2026-09-20 (Phase 1 approved):** D1 existing project · D3 **deferred** — the
real `farms` → `producers` migration happens after the new tool is tested, so Phase 1
leaves `farms` and `users` untouched · D5 voip.ms only · D6 keep reminders, repurposed to
remind producers to report · D8 no AI · D9 export + delete v1 transcripts · D14 send one
transition text, start the 30-day clock, retire automation after. Remaining: D2, D4, D7,
D10–D13, D15–D19 (defaults apply unless the owner objects). **Deviation recorded:** D11's
default (move functions to `functions/`, drop `frameworksBackend`) was deferred to Phase 2;
Phase 1 applied the `functions.ignore` hardening instead.

**2026-09-21:** D14 **withdrawn** — the owner confirms all five v1 users are test accounts,
so no transition notice is sent and there is no 30-day hold; the retirement deploy and the
§4.5 data deletion proceed after check-in #2. D18 **answered** — the operator is St. Joseph
Center of Arkansas and the domain stays `farmlink.us` (SJCA-owned); the legal pages are
rewritten accordingly and ship in the same hosting deploy.

**2026-09-22 (Phase 3):** D18 follow-through — `farmlink.us` now points at Firebase
Hosting (owner fixed the registrar DNS; `www` still needs a redirect) and `APP_URL` moves to
`https://farmlink.us` at the Phase 3 deploy. Recorded by the contract, open to tightening:
**D21** sending does not require `producers.sms_consent.status === 'opted_in'` — imported
producers are `unknown`, an admin-entered phone is the consent event, and STOP is honoured
everywhere; **D22** check-in links stay valid three days past the deadline (late responses
are visible as "responded late" but stay `non_responders` at the deadline) and accept up to
25 submissions; **D23** the unknown-number auto-reply still reads "FarmLink's ordering
service has closed… A team member will follow up" — owner to supply new wording.

| # | Decision | Default / recommendation |
|---|---|---|
| **D1** | Build in the existing Firebase project (live pilot, voip.ms webhooks, users) or a new one? | **Existing project.** Retirement and rework in place; the number and webhooks carry over. A second project doubles the secret/webhook surface. |
| **D2** | Collection names `farmers_markets` / `market_dates` / `producers`? | **Yes** (§7.7). |
| **D3** | Are v1 `farms` the SJCA producers? Copy real farm docs into `producers` (mapped fields) and retire `farms`; retire `market`/`both` users. | **Copy, then retire.** Show the mapping at check-in #1. |
| **D4** | Self-service application form (public) vs admin-created producers only? | **Public form** (the brief says it replaces the Google Form). |
| **D5** | Keep only voip.ms, or also keep Telnyx (unconfigured) / WhatsApp (unconfigured)? | **voip.ms only; archive the other two** (with their tests). Re-add a provider later is a 30-line file. Confirm whether Telnyx/Twilio accounts still bill. |
| **D6** | Keep the personal reminders feature (`reminders`, `processReminders`, 6 live docs)? | **Keep, repurposed** as producer/staff reminders; it is the scheduler template anyway. |
| **D7** | Photo uploads (logos, booth photos)? | **Yes, behind auth**; keep `storage.ts`; retire produce photos and Imagen. |
| **D8** | Any AI text assistant in v1 of the SJCA tool? | **No.** Keyword handler (§7.4). The harness is archived for later. `ANTHROPIC_API_KEY` stays only for error-alert diagnosis (or drop that too). |
| **D9** | v1 `conversations/messages` transcripts: keep live, or export + delete? | **Export + delete**; the new `messages` log starts clean. |
| **D10** | Keep FCM web push? | **Keep** (cheap, already installed on your phones); SMS stays authoritative. |
| **D11** | Move functions to a `functions/` subdirectory (standard layout) vs a longer ignore list? | **Move** during Phase 1 — allow-listed by construction; also drop the inert `frameworksBackend`. |
| **D12** | Delete the dead GitHub workflow, or replace with a typecheck + test gate on push? | **Replace** with a non-deploying CI gate. |
| **D13** | Triage log: commit the 12 pending runs, stop the daily triage task, scrub PII, archive? | **Yes to all four.** |
| **D14** | Transition notice to pilot users (terms promise 30 days) before the retirement deploy? | **Send one text** ("FarmLink is changing…") and start the 30-day clock; retire automation after. |
| **D15** | Page-2 application fields — owner supplies the CSV export. | Needed before Phase 2. |
| **D16** | Stay on custom OTP+JWT (not Firebase Auth)? | **Yes.** |
| **D17** | Local dev: `src/server.ts` runner or Firebase emulator? | **Keep `server.ts`** for now. |
| **D18** | Operator identity for the rewritten legal pages (SJCA vs "FarmLink") and the domain (`farmlink.us` is parked; `stjosephcenter.org`?). | Needed before the Phase 1 hosting deploy. |
| **D19** | Who receives `privacy@` / `support@farmlink.us` today? | Unknown; likely nobody. |
| **D20** | Seed Phase 2 with the 2026 WLRFM weekly-survey history (≈335 responses, Apr 18–Sep 20) as test data? | **Yes** — real names, real dates, no phones. The export sits in the private bucket, never in git; Phase 7 re-runs the same importer against the authoritative Google export. |
| **D15 (still open)** | Page-2 application-form fields. | The weekly survey is not it; the application form ships with page-1 fields until the CSV arrives. |

---

## 10. Ground rules (restated)
Secrets only in env vars (`.env.example` kept current). Development never sends real
texts or emails. `CHANGELOG.md` and this file stay current. Descriptive commit messages,
especially for removals. When the brief conflicts with the code, surface it and propose
an option — do not guess. Real production data is never deleted without a verified export
and explicit approval for that step.
