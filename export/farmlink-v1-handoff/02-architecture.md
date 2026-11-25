# 02 — v1 architecture

| Layer | v1 |
|---|---|
| Runtime | Node 22, TypeScript 5.7, ESM |
| API | Fastify 5 mounted in one Firebase Cloud Function v2 `api` via `fastify.inject` (`src/functions.ts`); `src/server.ts` runs it locally |
| Data | Firestore (admin SDK only; rules deny all client access), project `arkansaslocalfoodnetwork`, `us-central1`, Firestore `nam5` |
| Scheduled | `processRecurringOrders` (00:00 Central), `freshnessAlerts` (07:00 Central), `processReminders` (every 15 min) via `onSchedule`; `sendNotification` Cloud Tasks handler (never actually ran) |
| SMS | `src/services/sms.ts` routes to voip.ms (production), Telnyx or WhatsApp (both coded, never configured) |
| AI | `@anthropic-ai/sdk` for the SMS assistant and error-alert diagnosis |
| Email | Resend |
| Push | Firebase Cloud Messaging (`users.fcm_tokens`) |
| Files | Firebase Storage `uploads/` (17 photos) |
| Web | Next.js 15 / React 19 / Tailwind 4 in `web/`, static export on Firebase Hosting; `/api/**` rewrites to `api` |
| Auth | Phone OTP → hand-rolled HS256 JWT (`src/utils/jwt.ts`), 7-day expiry, `middleware/rbac.ts` |

## API routes (prefix `/api`)

| Prefix | Endpoints |
|---|---|
| `/auth` | `POST /signup`, `/check-phone`, `/otp/request`, `/otp/verify`; `GET /me` |
| `/sms` | `POST /inbound` (Telnyx), `GET+POST /voipms/inbound`, `GET+POST /whatsapp/inbound`, `POST /chat` (web chat), `GET /history/:phone`, `GET /conversations`, `POST /status` (stub) |
| `/farms`, `/markets` | list, detail, CRUD |
| `/products`, `/inventory` | CRUD; `POST /inventory/sync-lfm` |
| `/orders`, `/recurring-orders`, `/deliveries` | CRUD and status |
| `/relationships`, `/directory` | connections; `GET /directory/farms|markets`, `POST /directory/connect`, `/connect/:relId/respond`, `GET /connect/pending` |
| `/analytics` | per-farm revenue and top products |
| `/profile` | `GET /`, `PUT /user`, `PUT /farm`, `PUT /market` |
| `/admin` | `GET /utilization`, `/users`, `/broadcasts`; `POST /broadcast` |
| `/reminders`, `/feedback`, `/invite`, `/push`, `/uploads`, `/errors` | as named |

## Code map

```
src/functions.ts        Cloud Function exports (api + 3 schedules + task handler)
src/server.ts           local dev runner
src/config/env.ts       zod env loader (dotenv override:true — see 05)
src/config/depot.ts     the single depot address
src/routes/*.ts         20 Fastify route plugins
src/services/           conversation (AI loop), sms + voipms/telnyx/whatsapp, otp, push, email,
                        order-notifications, recurring-orders, freshness-alerts, reminders,
                        lfm-sync, produce-photo, imagen, storage, error-notify, support-notify
src/tools/              the 28 AI tools (index.ts is the registry)
src/utils/              jwt, view-link, freshness, sort, serialize, http-error-handler, errors
src/db/                 firestore.ts (getDb), seed-firestore.ts (seeds PRODUCTION — never run)
web/src/app/            the pages in 01-product.md
tests/                  4 vitest files (webhook auth, WhatsApp signature, validation, signup types)
```

## Environment variable names (values never in git)

`GOOGLE_APPLICATION_CREDENTIALS`, `GCLOUD_PROJECT`, `SMS_PROVIDER`, `VOIPMS_USERNAME`,
`VOIPMS_PASSWORD`, `VOIPMS_DID`, `VOIPMS_WEBHOOK_SECRET`, `TELNYX_*`, `WHATSAPP_*`,
`META_APP_SECRET`, `RESEND_API_KEY`, `FROM_EMAIL`, `APP_URL`, `ANTHROPIC_API_KEY`, `PORT`,
`HOST`, `NODE_ENV`, `JWT_SECRET`, `CLOUD_TASKS_*`, `CLOUD_FUNCTIONS_URL`, `ALERT_EMAIL`,
`ALERT_PHONE`, `LFM_API_BASE`, `LFM_API_KEY`, `LFM_MARKET_ID`.

## Commands

`npm run dev` (local API), `npm run dev:web` (web on :3001), `npm run typecheck`,
`npm test`, `npm run build`. `npm run deploy*` deploys to the **one** Firebase project,
which is production. `npm run seed` writes demo data **into production**. Never run it.
