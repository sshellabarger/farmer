# SJCA Market Manager (formerly FarmLink)

Farmers-market management tool for the St. Joseph Center of Arkansas: weekly producer
check-ins by text, booth assignments, sponsors, and draft Mailchimp / website content
that an admin approves before anything publishes. Text is the primary interface; the web
app exists for admins.

This repo is being reworked from **FarmLink v1**, a text-first farm-to-buyer ordering
platform piloted in Little Rock, AR (Mar–Jul 2026). Phase 1 of the rework retired the
ordering domain, the AI assistant and the unused SMS channels; the spec, audit and
migration plan are in **[`docs/SPEC.md`](docs/SPEC.md)**. The v1 design package,
prototype and recovered Postgres-era code live in **[`archive/`](archive/README.md)**.

The final v1 code is tagged **`farmlink-v1-final`** (branch `archive/farmlink-v1`).

## Stack

| Layer | Actual |
|---|---|
| Runtime | Node 22, TypeScript 5.7, ESM |
| API | Fastify 5 mounted inside **one Firebase Cloud Function v2** `api` (`src/functions.ts`) via `fastify.inject`; `src/server.ts` is the local-dev runner; both call `buildApp()` in `src/app.ts` |
| Data | **Firestore** (admin SDK only; `firestore.rules` / `storage.rules` deny all client access). No SQL, no migrations. |
| Scheduled work | Cloud Scheduler via the `processReminders` `onSchedule` export |
| SMS | voip.ms only, through `src/services/sms.ts`; inbound webhook at `/api/sms/voipms/inbound` with a keyword handler (STOP/START/HELP) in `src/services/inbound.ts`; every text is logged to the `messages` collection |
| Email | Resend (`src/services/email.ts`) |
| AI | None in the product. `@anthropic-ai/sdk` is used only by `src/services/error-notify.ts` to draft fix suggestions in alert emails |
| Web | Next.js 15 / React 19 / Tailwind 4 in `web/`, deployed through Firebase Hosting's web-frameworks integration (`frameworksBackend`; the current output is fully static, so no SSR function exists); `/api/**` rewrites to the `api` function; retired v1 URLs 301 to `/changed` |
| Auth | Phone OTP (`otps` collection) → HS256 JWT (`src/utils/jwt.ts`), 7-day expiry |
| Project | Firebase/GCP `arkansaslocalfoodnetwork`, `us-central1` (Firestore `nam5`). **Live project with real user data.** |

## Commands

```bash
cp .env.example .env       # then fill it in — leave send credentials blank on a dev machine
npm ci && (cd web && npm ci)

npm run dev                # local Fastify on LOCAL_PORT (default 3000) via tsx watch
npm run dev:web            # Next dev server on :3001 (proxies /api to :3000)
npm run typecheck          # tsc --noEmit (src/ only)
npm test                   # vitest, tests/ only
npm run build              # rm -rf dist && tsc

npm run deploy:functions   # firebase deploy --only functions (prompts to DELETE retired functions)
npm run deploy:hosting     # firebase deploy --only hosting
npm run deploy:firestore   # rules + indexes
```

Deploys need `firebase login` and `gcloud auth login` and are always run by the owner.
`firebase.json → functions.ignore` keeps `.env`, service-account keys, `docs/`, `tests/`,
`archive/` and `src/` out of the functions bundle (`main` is `dist/functions.js`).

## Layout

```
src/app.ts            buildApp(): plugins, hooks, error handler, health, route list
src/functions.ts      Cloud Functions entry: api (HTTPS) + processReminders (schedule)
src/server.ts         local dev runner
src/routes/           auth, sms, admin, profile, invite, push, errors, feedback, reminders, uploads
src/services/         sms, voipms, inbound, otp, email, push, reminders, storage, error-notify, support-notify
src/middleware/rbac.ts authenticate + requireRole
tests/                vitest (helpers/fake-db.ts is an in-memory Firestore stand-in)
web/                  Next.js admin app
docs/SPEC.md          the spec; docs/MONITORING.md — alerts and log queries
archive/              v1 history (never imported, never deployed)
```

See [`CLAUDE.md`](CLAUDE.md) for conventions and ground rules, and
[`CHANGELOG.md`](CHANGELOG.md) for what changed and why.
