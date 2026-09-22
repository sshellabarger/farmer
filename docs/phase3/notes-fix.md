# Phase 3 — integrator fix notes (branch `rework/p3-fix`, on top of `rework/phase-3` @ `084a861`)

Two findings from the adversarial verifiers are addressed here: the **blocker** (the
engine's overlapping-run guard was a read-then-write, so concurrent runs double-texted)
and the **major** (the contract §7.5 end-to-end test the integrator owed). Nothing in
`web/` changed.

## The blocker, reproduced

Seed one `collecting` market date with two phone-bearing active recipients and run
`await Promise.all([processMarketDates(db, env, { now }), processMarketDates(db, env, { now })])`
at the check-in instant.

| | `checkin_link` rows | provider calls (console prints) | per run | `link_tokens` |
|---|---|---|---|---|
| **before** (`084a861`) | **4** — `p1, p1, p2, p2` | 4 | both `checkin_sent: 2, skipped_claimed: 0` | 4 |
| **after** (`5ef4ea4`) | **2** — `p1, p2` | 2 | one `checkin_sent: 2`, the other `skipped_claimed: 1` | 2 |

The same reproduction is now a permanent test (`tests/checkin-workflow-concurrency.test.ts`,
case (a)), and the whole new file was run against the pre-fix engine to confirm every
engine-level case fails there.

## What changed

### 1. `sendSms` gains an atomic `dedupe_key` (`src/services/sms.ts`)

- `SendSmsArgs.dedupe_key?: string`. When present it **is** the `messages` row id, and the
  `queued` row is written with the admin SDK's `DocumentReference.create()` instead of
  `set()`. `create()` fails with gRPC code 6 `ALREADY_EXISTS` when the doc exists, so of
  any number of callers racing on one key exactly one gets past that line. The loser throws
  the new `DuplicateSendError(dedupe_key, existing_message_id)` **before any provider
  call** — the log row is the lock; a duplicate can never reach voip.ms.
- `trySendSms` maps it to `{ ok: false, duplicate: true, message_id: <key>, error }`; every
  other failure now carries `duplicate: false` (additive).
- `isAlreadyExists(err)` recognises `code === 6` / `'6'` / `'ALREADY_EXISTS'` and an
  `ALREADY_EXISTS` message.
- Without `dedupe_key` the behaviour is byte-for-byte what it was (uuid id, `set()`). The
  OTP, invite, alert, support, broadcast and reminder sends are untouched.

### 2. The engine's guard is an atomic step lock (`src/services/checkin-workflow.ts`)

- `claim()` now creates `workflow_locks/<market_date_id>__<key>` (keys `checkin`,
  `reminder_<offset>`, `deadline`, `summary`) with `create({ market_date_id, key,
  claimed_at, run_id, created_at })`. `ALREADY_EXISTS` → read the lock → `claimed_at`
  younger than `CLAIM_TTL_MS` (10 min) → the step is skipped (`skipped_claimed++`); older →
  the owner died (the function times out at 300 s, so no live run can hold a lock that
  long) and this run takes it over with `set()`, recording `taken_over_from`.
- The done-check is still a fresh read of the market_date flags, and the informational
  `actions.claims[key]` map is still written exactly as before (the status page shows it) —
  it is simply no longer the guard.
- Every engine send passes a deterministic key (`DEDUPE_KEYS`):
  `checkin_link:<date_id>:<producer_id>`,
  `checkin_reminder:<date_id>:<producer_id>:<offset_min>`,
  `deadline_summary:<date_id>:<user_id>`. A `DuplicateSendError` counts as "already sent"
  — skipped, not failed — in `checkin_sent`, `checkin_failed`, `reminders_sent[].recipients
  / failed` and `sendDeadlineSummary().sms` (which gains a `duplicates` count).
- `sendCheckinLink` accepts `dedupe_key` and can return `status: 'duplicate'`. The staff
  **resend** route (`POST /api/market-dates/:id/resend-checkin`) passes no key: a resend is
  an intentional second text and is not blocked (tested).
- The in-memory pre-check against existing `messages` rows is kept as a cheap first layer
  (it avoids minting a token that would then be refused); the keyed `create()` is what
  actually guarantees at-most-once.
- `src/db/firestore.ts` lists the new `workflow_locks` collection. It needs no index and
  no rules change (`firestore.rules` already denies all client access).

### 3. The summary email

`sendEmail` has no log row and therefore no atomic guard. The summary step passes
`email: c.created` to `sendDeadlineSummary`, so the email goes out **only from the run that
created the summary lock**; a stale-lock takeover re-attempts the texts (all refused as
duplicates if they went out) but never the email. Rationale: a possibly missing email beats
a double one — the texts are the authoritative channel and are atomic.

### 4. Inbound forwarding (`src/services/inbound.ts`)

`forwarded_inbound` rows carry `dedupe_key: forwarded_inbound:<inbound_message_id>:<user_id>`,
exactly as specified. **Please note what this does and does not protect:** the key
guarantees at most one forward per inbound `messages` row per staff member, but
`inbound_message_id` is a fresh uuid minted per webhook delivery, so a voip.ms *retry*
(a new delivery of the same text) gets a new inbound row and a new key and is forwarded
again — the same as before this change. Making retries idempotent needs the key (or the
inbound row id) to derive from the provider's message id (`providerMessageId`, the `id`
query param), which I did not do because (a) it was outside the "small, contained edit"
asked for, and (b) the route falls back to `voipms-<Date.now()>` when the id is absent and
I could not verify that voip.ms ids are unique across SMS/MMS. Recommended follow-up:
`dedupe_key: forwarded_inbound:${providerMessageId}:${user_id}` when the id is a real
provider id.

### 5. Tests

- `tests/checkin-workflow-concurrency.test.ts` (new, 14 cases): (a) the verifier's
  reproduction; (b) five concurrent runs on every tick of a 10-recipient date — one link
  and one reminder per offset per producer, one summary per staff phone (never `mgr_a` /
  the phone-less admin), one email, `non_responders` written once, exactly two
  `reminders_sent` entries, five locks; (c) a run that dies after the 3rd of 6 sends — the
  next tick is blocked by the fresh lock, the tick after the TTL takes over and texts only
  the remaining three, nobody twice; plus a keyed row refusing a re-send that the in-memory
  pre-check cannot see; (d) resend after the engine's text → a second (uuid) row, then a
  third; (e) keyed `sendSms` semantics including a five-way race; (f) the fake `create()`
  semantics including its atomicity.
- `tests/checkin-workflow.test.ts`: the two idempotency cases now seed the lock doc rather
  than `actions.claims`; a new case proves a stale informational claim alone never blocks;
  a new case covers a stale **summary** takeover (texts refused as duplicates, no second
  email, `summary_sent_at` written).
- `tests/phase3-e2e.test.ts` (new, the major): the full §7.5 flow through `buildApp()`
  with a fake clock (`vi.useFakeTimers({ toFake: ['Date'] })`) so the routes' `new Date()`
  and the engine's injected `now` agree; the one-producer flow the brief enumerates, the
  contract's literal two-producer flow, and the three-way concurrent first tick.
- `tests/helpers/fake-db.ts`: `FakeDocRef.create()` (additive). The collection name is
  threaded through only to build the error's `<path>`; nothing else changed.

Totals: `npm run typecheck` clean; `npm test` 28 files / 311 tests (was 26 / 292).

## Residual windows the owner should know about

1. **Stale-lock takeover is read-then-write.** Two runs that both find a lock older than
   10 minutes can both take it over and both proceed. Harmless for texts (each is atomic on
   its key) and flags (idempotent whole-map rewrites of the same values). The email is sent
   by neither (only a *creator* emails), which leads to:
2. **A creator that dies before emailing leaves no summary email** (the texts still go out
   from the takeover). A creator that dies *after* emailing but before `summary_sent_at`
   leaves exactly one email. There is no scenario with two engine emails.
3. **Admin "close" racing the engine's deadline tick.** `POST /:id/close` still calls
   `processDeadline(notify: true)` outside the lock; its summary texts now carry the same
   `deadline_summary:<date>:<user>` keys so no staff phone can get two, but its email is
   unconditional, so a close issued in the same seconds as the engine's summary step can
   produce a second email. The route's 409 (`deadline_processed_at` already set) covers the
   normal case.
4. **A keyed row that failed at the provider holds the key.** If voip.ms rejects a
   check-in text, the `failed` row under `checkin_link:<date>:<producer>` refuses a later
   engine re-attempt (which only happens on a takeover anyway; the engine never retried
   failures). The resend button is the retry path, as the contract already says.
5. **`workflow_locks` is never cleared** (~5 tiny docs per market date). It is harmless
   history; a future janitor could delete locks for dates whose `summary_sent_at` /
   `summary_skipped` is set.

## Things that look different in Firestore / the status page

- Engine-sent `messages` rows have deterministic ids (e.g.
  `checkin_link:wlrfm_2026-09-26:<producer_id>`) instead of uuids; `link_tokens.sent_message_id`
  and the status page's `messages[].id` show them. Colons are valid in Firestore doc ids.
  The console provider's `provider_message_id` is `console-<id>` as before.
- The `workflow_locks` collection appears after the first engine tick in production
  (one `…__checkin` / `…__deadline` doc per considered date — for `wlrfm_2026-09-19` at
  deploy time, per contract §3.6, still zero sends).

## Pre-existing hazard noticed in passing (not fixed here — files owned by A/B, out of scope)

Three existing tests mint or seed tokens that expire at **2026-09-25T17:00Z** and then hit
routes that read the real clock: `tests/checkin-public.test.ts` ("200s on a valid token",
the POST cases), `tests/inbound-checkin.test.ts` (`FUTURE`), and
`tests/market-dates-routes.test.ts` ("mints a fresh token, sends, and audits" — the
`past_grace` 409 will trigger). They will start failing on real-world 2026-09-25 whatever
the code does. The fix is the fake clock this branch's e2e test uses
(`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`), or far-future fixture
dates. Worth folding in before CI goes red.

## Owner actions

None beyond contract §8. No new env keys, no index, no rules change. Deploying functions
from the merged tree is what makes the fix live; until then production runs the
read-then-write engine — but nothing producer-facing can be sent there yet because no
producer has a phone (§3.6).
