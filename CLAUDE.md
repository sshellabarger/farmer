# CLAUDE.md — SJCA Market Manager (formerly FarmLink)

Farmers-market management tool for St. Joseph Center of Arkansas (SJCA). This code base is
the retired **FarmLink v1** (a text-first farm-to-buyer ordering platform, piloted in Little
Rock, AR, Mar–Jul 2026) with the v1 product removed and the reusable plumbing kept. The
spec, audit, archive plan, migration plan and decision log live in **`docs/SPEC.md`**. Read
it before touching anything. The v1 code is preserved at tag `farmlink-v1-final` and branch
`archive/farmlink-v1`; reference material is under `archive/` (see `archive/README.md`).

## Status — read this first

- **Phase 1 is complete and deployed (2026-09-21).** Production runs `main` (`f966cc8`
  or later): functions `api` + `processReminders` only; the eleven v1 collections and all
  ten v1 indexes are deleted; hosting serves the transition pages and the SJCA legal pages.
  `main` is what production runs again — deploy from `main` only.
- **Phase 2 is deployed (2026-09-22) and seeded with the 2026 WLRFM survey history:** `farmers_markets` + `market_dates` with a
  versioned schedule and an idempotent generator, roles/audit log, `producers`,
  `producer_memberships`, `applications`, the structural send guard, the admin web app and
  the survey importer. The contract every executor built against is
  `docs/phase2-contract.md`; the changelog has the fold-in. Hotfix 2026-09-22: every read
  of a Firestore date field now goes through `src/utils/dates.ts` (see Conventions).
  **Phase 3 is next** (SPEC §8): check-in links and texts, reminders, deadline flagging,
  STOP/HELP, quiet hours.
- **Production sends are opt-in.** `SMS_PROVIDER`/`EMAIL_PROVIDER` default to `console`;
  real providers exist only with `NODE_ENV=production` and `ALLOW_REAL_SENDS=true`. Those
  keys live in `.env.arkansaslocalfoodnetwork` (git-ignored, non-secret), which the
  Firebase CLI merges over `.env` at deploy and dotenv never reads — so `npm run dev` and
  tests cannot text anyone even with production credentials in `.env`.
- Data left in Firestore on purpose: `users` (the admin login), `farms` (D3 — migrated to
  `producers` after Phase 2 testing), `reminders`, `feedback`, `invites`, `error_alerts`,
  and the 17 Storage photos. The pre-Phase-1 export is at
  `gs://arkansaslocalfoodnetwork-exports/pre-sjca-2026-09-20/`; PITR is enabled.
- Real production data exists (users, farms, orders, conversations, photos). Never delete a
  collection or Storage object without a verified export and the owner's explicit approval
  for that step. The pre-Phase-1 export is at
  `gs://arkansaslocalfoodnetwork-exports/pre-sjca-2026-09-20/`; Firestore PITR is enabled.

## The stack

| Layer | Actual |
|---|---|
| Runtime | Node 22, TypeScript 5.7, ESM |
| API | Fastify 5 built by **`src/app.ts` `buildApp()`**, mounted inside one Firebase Cloud Function v2 `api` (`src/functions.ts`) via `fastify.inject`; `src/server.ts` runs the same app locally |
| Data | **Firestore** (admin SDK only; `firestore.rules` / `storage.rules` deny all client access). No SQL, no migrations. |
| Scheduled work | Cloud Scheduler via `onSchedule`: `processReminders` (every 15 min) and `rollMarketDates` (nightly; regenerates each market's rolling date window) |
| SMS | **voip.ms only** (`src/services/voipms.ts` behind `src/services/sms.ts`). Telnyx and WhatsApp were archived to `archive/v1-channels/`. Cloud Tasks was retired (it never ran in prod). |
| Inbound texts | `src/services/inbound.ts` — a keyword stopgap (STOP/START/HELP + one courtesy reply per 24 h), logs every message to the `messages` collection. The Phase 3 check-in workflow replaces it. |
| Email | Resend (`src/services/email.ts`) |
| AI | `@anthropic-ai/sdk` is used only by `src/services/error-notify.ts` to draft alert diagnoses. There is no AI assistant (decision D8). |
| Web | Next.js 15 / React 19 / Tailwind 4 in `web/`, deployed by Firebase Hosting's web-frameworks integration (current output is fully static); `/api/**` rewrites to the `api` function; retired v1 URLs 301 to `/changed` |
| Auth | Phone OTP (`otps` collection) → hand-rolled HS256 JWT (`src/utils/jwt.ts`), 7-day expiry; roles are still the v1 enum until the D3 migration |
| Project | Firebase/GCP `arkansaslocalfoodnetwork`, `us-central1` (Firestore `nam5`). One project for pilot data and the new tool (decision D1). |

## Commands

```bash
npm run dev            # local Fastify on LOCAL_PORT (default 3000) via tsx watch
npm run dev:web        # Next dev server on :3001 (proxies /api to :3000)
npm run typecheck      # tsc --noEmit (tests/ are not type-checked by this)
npm test               # vitest run — tests/** only (vitest.config.ts excludes archive/)
npm run build          # rm -rf dist && tsc   (dist/ is what deploys; the clean step matters)
npm run import:survey -- --source <path|gs://…> --market wlrfm --dry-run   # Google-Form history → Firestore; add --write to persist
npm run deploy:functions   # prompts to DELETE functions whose exports are gone (add --force non-interactively); that is how scheduler jobs are removed
npm run deploy:hosting     # builds web/ via the frameworks integration and ships it, legal pages included
npm run deploy:firestore   # rules + indexes
```

There is no seed script any more. Local tests need a dummy `.env` (git-ignored):
`ANTHROPIC_API_KEY=test JWT_SECRET=test-secret SMS_PROVIDER=console EMAIL_PROVIDER=console NODE_ENV=test`
(`tests/setup/test-mode.ts` forces console mode regardless and fails fast otherwise).
CI (`.github/workflows/ci.yml`) runs typecheck + tests + web typecheck on every push and
never deploys. Deploys need both `firebase login --reauth` and `gcloud auth login`, and an
explicit owner go-ahead in the session — never on the strength of an allowlist entry.

## Repo map

```
src/app.ts               buildApp(): plugins, error handler (before routes), /health + /api/health, route list
src/functions.ts         exports: api (onRequest), processReminders + rollMarketDates (onSchedule)
src/server.ts            local runner over the same buildApp()
src/routes/              auth, sms, admin, admin-users, audit-log, dashboard, markets, producers, memberships,
                         applications, checkins, profile, invite, push, errors, feedback, reminders, uploads
src/services/            sms (+voipms, console) — the ONE logged send; inbound (stopgap), markets, market-dates
                         (generator), producers, identity, audit, otp, push, email, error-notify, support-notify,
                         storage, reminders
src/middleware/          rbac.ts (authenticate, requireRole), market-scope.ts (requireStaff, requireMarketAccess)
src/utils/               tz (Intl local↔UTC), dates (Firestore Timestamp → Date), jwt, http-error-handler, serialize, sort, errors
scripts/import-survey.mjs   the Google-Form history importer (excluded from the functions bundle)
src/types/schema.ts      shared string-union types (documentation, not enforcement)
src/db/firestore.ts      getDb() + the list of collections the code uses
web/src/app/             /  /changed  /apply (public)  /login  /admin (dashboard)  /admin/markets  /admin/producers
                         /admin/applications  /admin/users  /feedback  /settings
archive/                 v1 design package, prototype, postgres-era code, channels, AI harness, web pages, ops log, Firestore schema snapshot
docs/                    SPEC.md, MONITORING.md
```

## Conventions (match the existing code)

- ESM imports with explicit `.js` suffixes.
- Validate every request body with **zod** at the route boundary; `createErrorHandler`
  turns zod failures into 400s and alerts on 5xx.
- Routes are Fastify plugins registered with a prefix **only in `src/app.ts`**.
- Firestore through `app.db` / `getDb()`; fields `snake_case`; ids `uuid` v4; timestamps
  `new Date()` (the `preSerialization` hook converts them in responses).
- **Firestore returns `Timestamp`, not `Date`.** Never call `.getTime()` / `.toISOString()`
  / `<` on a raw document field: read every date through `toDate()` / `toDateOrEpoch()`
  (`src/utils/dates.ts`) or a normaliser such as `marketDateFromData()`.
  `tests/helpers/fake-db.ts` hands Timestamps back on every read (`dump()` stays raw), so a
  missed conversion fails in a test instead of in production — the nightly
  `rollMarketDates` run died on exactly this on 2026-09-22.
- Query pattern: one equality filter at the DB, then filter/sort in memory
  (`src/utils/sort.ts`) so `firestore.indexes.json` stays minimal.
- **Every outbound text goes through `sendSms()`** and is logged to `messages`
  (`direction`, `to`, `from`, `body`, `provider`, `provider_message_id`, `status`, `kind`,
  `created_at`). SMS is the authoritative channel; push is best-effort. Sends must honour
  `users.sms_opt_out_at`.
- **Never hard-code a day, time, timezone or quiet-hour window for a market.** Every market
  carries its own schedule and workflow offsets (SPEC §6.4–6.5).
- **Never reuse the v1 names `markets`, `farms`, the `market` role or the `/market` URL for
  the new farmers-market meaning.** New collections are `farmers_markets`, `market_dates`,
  `producers` (SPEC §7.7). `farms` and `users` data are untouched until the D3 migration.
- Tests: vitest in `tests/` against `tests/helpers/fake-db.ts` (equality `where`, `limit`,
  `get/set/update/delete/add`; no `orderBy`/`in`/batch — keep production queries inside
  that envelope). Sends need no mocking: the console provider is structural.
- Firestore query envelope: one equality filter at the DB, everything else in memory —
  `firestore.indexes.json` stays empty by construction.

## Ground rules

1. **Secrets only in environment variables.** Add every new key to `.env.example` with a
   comment. Never print `.env`, `service-account.json`, or `.claude/settings.local.json`.
2. **Development must never send real texts or emails.** Enforced in code since Phase 2
   (console providers by default; `ALLOW_REAL_SENDS=true` only in the deploy-time env
   file). Never set `ALLOW_REAL_SENDS` in a local `.env`.
3. **Keep `CHANGELOG.md` current** and update `docs/SPEC.md` when a decision changes.
4. **Commit messages are descriptive, especially for removals:**
   `Retire <what>, replaced by <what>. See tag farmlink-v1-final.`
5. **The repo root is the Cloud Functions source directory.** `firebase.json →
   functions.ignore` now excludes secrets, docs, tests, src and archive; keep it that way.
   Moving functions to a `functions/` subdirectory is deferred to Phase 2 (D11).
6. **Real production data exists.** See Status.
7. Redact phone numbers and personal names in docs, logs and commit messages.

## Where things are

- `docs/SPEC.md` — spec, audit, archive plan, migration plan, decisions
- `CHANGELOG.md` — what changed and why
- `docs/MONITORING.md` — error-alert pipeline (updated for the surviving functions)
- `archive/README.md` — what each archived folder is; `archive/ops-log/` holds the v1
  triage log (redacted, with a correction note) and the June monitoring snapshot
- `archive/firestore-schema-2026-09.md` — every collection, field map and count before Phase 1 deletion
- `web/scripts/gen-icons.mjs` — regenerates PWA icons from `web/public/icon.svg`
