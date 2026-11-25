# 05 — What v1 got wrong (fix these in the rebuild)

From the 2026-09-20 audit (`docs/SPEC.md` §1.5–1.6 on tag `sjca-rework-final`). Some of
these were fixed in production by the rework, but **all of them are still in the v1 code**.

## Must fix before the rebuild sends anything

1. **No dev/test send guard.** `sendSms` always calls the carrier. `src/config/env.ts`
   loads `.env` with `override: true`, so `npm run dev` and tests run with production
   credentials and can text real people. The rework fixed this structurally: a console
   provider by default, and real sends only when `NODE_ENV=production` **and**
   `ALLOW_REAL_SENDS=true` are set in a deploy-only env file. Copy that design.
2. **Secrets shipped in every functions bundle.** `firebase.json → functions.ignore` didn't
   exclude `.env`, the service-account key or `.claude/`. Exclude them, or deploy from a
   `functions/` folder that lists only what ships. Use Secret Manager.
3. **Unauthenticated inbound SMS webhook.** Anyone could post to the voip.ms inbound URL
   as any user, drive the AI tool loop, and make `email_send` mail arbitrary addresses.
   Require a shared secret on the callback URL, and verify Square webhook signatures the
   same way.
4. **Unauthenticated write and PII endpoints:** delivery status, products,
   recurring-orders CRUD, connections, `directory/connect` (it texts arbitrary users),
   open image upload, and public farm/buyer lists exposing phone, email and address.
   Every route needs `authenticate` + an ownership check.
5. **`email_send` AI tool** let the model pick the recipient and the body, a phishing
   vector. Don't rebuild it, or fix the recipients to known users.
6. **No STOP/HELP/START handling and no quiet hours**, yet the published terms promise
   them. This is a TCPA exposure. Build a keyword handler before the AI loop, and keep an
   opt-out flag per phone.

## Design gaps

7. **No send log.** `notifications` stored neither the body nor the phone. Log every outbound
   text (to, from, body, provider id, kind, status) in one choke point.
8. **Duplicate sends on retry.** voip.ms retries webhooks, and nothing was idempotent. Key
   each send and each Square write on the inbound message id; `create()` the log row
   first and skip the send if the row already exists.
9. **Rate limit is one global bucket.** Behind `fastify.inject` every request comes from
   `127.0.0.1`. Key on the real client IP or on the phone number.
10. **Timezone `America/Chicago` hard-coded** in four places; `farms.timezone` never read.
11. **OTP:** `Math.random`, no attempt limit, no per-phone send throttle. Use
    `crypto.randomInt`, add a limit and a throttle.
12. **JWT secret never rotated**, and the HMAC compare isn't constant-time.
13. **Cloud Tasks path never worked** (wrong queue name, wrong payload, no OIDC). Delayed
    priority notifications only ever went out directly. Use Cloud Scheduler or a proper
    task queue.
14. **Firestore returns `Timestamp`, not `Date`.** Read every date through a converter. A
    nightly job died on exactly this in the rework.
15. **"Market" means buyer.** Rename it in the rebuild.
16. **`npm run seed` writes to production**, and `/` and `/about` market the product to
    users. There's no staging project. Use the Square Sandbox and a separate Firebase project
    (or the emulator) for development.
17. **Service worker fight:** an inline script in `layout.tsx` unregisters every service
    worker that `pwa-register` installs, which breaks offline caching and FCM.

## Worth keeping

The OTP → JWT login, the zod-validated Fastify routes, the `sendSms` choke point, the
reminders job (cleanest SMS + audit pattern), the admin broadcast with a confirm step,
the error-alert pipeline, the web form kit in `/settings`, and the AI prompt's date and
hallucination rules.
