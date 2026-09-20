# CLAUDE.md — FarmLink → SJCA Market Manager

Farmers-market management tool for St. Joseph Center of Arkansas (SJCA). This repo is
being reworked from **FarmLink v1** (a text-first farm-to-buyer ordering platform,
piloted in Little Rock, AR, Mar–Jul 2026). The full spec, audit findings, archive plan
and migration plan live in **`docs/SPEC.md`**. Read it before touching anything.

**Status (2026-09-20):** Step 1 (audit + plans + these docs) is complete. **Phase 1
(archive, tag, retire, migrate) has NOT started and requires owner approval.** See the
"Open decisions" section of `docs/SPEC.md`.

## The real stack (not what README.md says)

README.md and `farmlink_architecture.md` describe a Postgres/Kysely/BullMQ/Twilio design
that was replaced on 2026-05-31 (commit `ee2ab6a`). Do not trust them. Reality:

| Layer | Actual |
|---|---|
| Runtime | Node 22, TypeScript 5.7, ESM |
| API | Fastify 5 mounted inside **one Firebase Cloud Function v2** `api` (`src/functions.ts`) via `fastify.inject`; `src/server.ts` is the local-dev runner only |
| Data | **Firestore** (admin SDK only; `firestore.rules` / `storage.rules` deny all client access). No SQL, no migrations. |
| Scheduled work | Cloud Scheduler via `onSchedule` exports in `src/functions.ts` |
| Delayed sends | Cloud Tasks code exists but **has never run in prod** (see SPEC §4). Do not build on it. |
| SMS | `src/services/sms.ts` provider switch. **Production is voip.ms only** (`SMS_PROVIDER=voipms`). Telnyx and WhatsApp code exists but is unconfigured in prod. |
| Email | Resend (`src/services/email.ts`) |
| AI | Claude via `@anthropic-ai/sdk`. The SMS ordering assistant is being retired; `error-notify.ts` still uses Claude for alert diagnosis. |
| Web | Next.js 15 / React 19 / Tailwind 4 in `web/`, served **static** by Firebase Hosting; `/api/**` rewrites to the `api` function |
| Auth | Phone OTP (`otps` collection) → hand-rolled HS256 JWT (`src/utils/jwt.ts`), 7-day expiry, stored in `localStorage` |
| Project | Firebase/GCP `arkansaslocalfoodnetwork`, `us-central1` (Firestore `nam5`). **This is the live pilot with real user data.** |

## Commands

```bash
npm run dev            # local Fastify on LOCAL_PORT (default 3000) via tsx watch
npm run dev:web        # Next dev server on :3001 (proxies /api to :3000)
npm run typecheck      # tsc --noEmit (tests/ are NOT type-checked — excluded in tsconfig)
npm test               # vitest run (27 tests, all pass at HEAD)
npm run build          # tsc → dist/   (⚠ never cleans dist/; rm -rf dist first when retiring files)
npm run deploy:functions   # firebase deploy --only functions  (prompts to DELETE any function whose export was removed — this is how scheduled jobs are removed)
npm run deploy:hosting     # firebase deploy --only hosting
npm run deploy:firestore   # rules + indexes
npm run seed           # ⚠ WRITES FAKE DATA INTO PRODUCTION. Do not run. (Being replaced in Phase 1.)
```

Deploys need **both** `firebase login --reauth` and `gcloud auth login`. Deploying from a
Claude session requires an explicit owner go-ahead in that session — never on the strength
of an allowlist entry.

## Conventions (match the existing code)

- ESM imports with explicit `.js` suffixes (`import { x } from './y.js'`).
- Validate every request body with **zod** at the route boundary; `createErrorHandler`
  turns zod failures into 400s and alerts on 5xx.
- Routes are Fastify plugins registered with a prefix in **both** `src/functions.ts` and
  `src/server.ts` (they must stay identical; a shared `buildApp()` is planned).
- Firestore access through `app.db` / `getDb()`; fields are `snake_case`; ids are
  `uuid` v4; timestamps are `new Date()` (the `preSerialization` hook converts them to
  ISO strings in responses).
- Query pattern: one equality filter at the DB, then filter/sort in memory
  (`src/utils/sort.ts`) so `firestore.indexes.json` stays minimal.
- **Every outbound text goes through `sendSms()`** and (from Phase 3) must write a
  `messages` log row. SMS is the authoritative channel; push is best-effort.
- **Never hard-code a day, time, or timezone for a market.** Every market carries its own
  schedule, workflow offsets, quiet hours and timezone (default `America/Chicago`).
- **Never reuse the `markets` collection, the `market` user role, or the `/market` URL
  for the new farmers-market-event meaning.** In FarmLink v1 those all mean *buyer*.
  New names are proposed in SPEC §6.
- Tests: vitest in `tests/`; any test that imports a route must `vi.mock` the send
  functions (`sendSms`, `sendOtp`, `processInboundMessage`). `src/config/env.ts` loads the
  real `.env` with `override: true` on import — there is no structural send guard yet.

## Ground rules

1. **Secrets only in environment variables.** Add every new key to `.env.example` with a
   comment. Never print `.env`, `service-account.json`, or `.claude/settings.local.json`.
2. **Development must never send real texts or emails.** Until the `SMS_PROVIDER=console`
   / `ALLOW_REAL_SENDS` guard ships (Phase 2), do not keep production credentials in a
   dev machine's `.env`.
3. **Keep `CHANGELOG.md` current** and update `docs/SPEC.md` when a decision changes.
4. **Commit messages are descriptive, especially for removals:** e.g.
   `Retire order and delivery routes, replaced by market management tool. See tag farmlink-v1-final.`
5. **The repo root is the Cloud Functions source directory.** Anything dropped at the root
   ships in every functions deploy unless it is in `firebase.json → functions.ignore`.
6. **Real production data exists.** Never delete a Firestore collection or Storage object
   without a verified export first, and never without the owner's explicit approval for
   that step.
7. Redact phone numbers and personal names in docs, logs and commit messages.

## Where things are

- `docs/SPEC.md` — the spec, audit, archive plan, migration plan, open decisions
- `CHANGELOG.md` — what changed and why
- `docs/MONITORING.md` — error-alert pipeline (partly stale; lists 3 of 5 functions)
- `docs/triage-log.md` — v1 pilot ops log (to be archived; deploy claims from Jun 29 on are wrong)
- `archive/` — (after Phase 1) v1 design package, prototype, recovered SQL migrations and workers
- `web/scripts/gen-icons.mjs` — regenerates PWA icons from `web/public/icon.svg` (needs `sharp`, present transitively via Next)
