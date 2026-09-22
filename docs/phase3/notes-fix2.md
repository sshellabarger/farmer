# Phase 3 — integrator fix notes, round 2 (branch `rework/p3-fix2`, on top of `rework/p3-fix` @ `f10ef77`)

Round 1 made the engine's step guard and every engine send atomic. A fresh concurrency
adversary then showed what round 1 left: every step's final write still rewrote the
**whole `market_dates.actions` map** from the snapshot taken in `claim()`, and the inbound
webhook minted a fresh row id per delivery. This round removes both, plus the smaller
findings and the two items from the other verifiers. Nothing in `web/` changed.

## The rule

**The engine never writes the `actions` map, only fields inside it.**

Every engine write — `claim()`'s informational claims entry, the check-in step, each
reminder offset, the deadline and summary steps — and `processDeadline` (the admin close)
names Firestore field paths: `'actions.checkin_sent_at'`, `'actions.claims.<key>'`,
`'actions.reminder_state.offset_<n>'`, `'actions.deadline_processed_at'`, … Two runs holding
different step locks, or the close (which takes no lock), therefore write disjoint paths and
the last writer cannot drop the other's outcome. `claim()` no longer returns its snapshot at
all, so no step *can* spread one. The generator follows the same rule for the one action
field it owns (`'actions.deadline_at'`, see "Deviations").

## The findings, reproduced before the fix

Both reproductions ran the new tests against the round-1 engine (`f10ef77`) with the new
fake db's dotted-path support but with its `undefined` guard disabled (see below — with the
guard on, the round-1 engine fails earlier, on the map write itself):

| | observed on `f10ef77` | after |
|---|---|---|
| **(g) blocker** — two runs at a tick where `reminder_1440` must be superseded and `reminder_2880` sent, gated so the 2880 sender writes last | after A's write the state is `[1440: superseded]`; after B's whole-map write it is `[2880: sent to 2]` — the supersede decision is gone. The next tick past the lock TTL **sends `reminder_1440` to both producers**: 4 reminder texts for 2 producers (`p01@1440, p02@1440, p01@2880, p02@2880`), final state `[2880: 2, 1440: 2]`. Neither run counted its lost lock (`skipped_claimed` 0). | both entries survive in every interleave (concurrent, gated both ways, late check-in); the next ticks send nothing; exactly one reminder text per producer; the loser of a reminder lock is counted |
| **(h) major** — admin close `{notify:true}` while the engine is mid check-in loop (gated after its 2nd send) | close returns 200 `sent` with `deadline_processed_at` and `summary_sent_at` set; the engine's final write leaves `checkin_sent_at` set and **both close flags `null`**; the scheduled deadline tick then reports `deadlines_processed 1, summaries_sent 1` and **sends a second summary email** (2 emails; the texts were refused by their keys, 2 rows) | all three flags set after both finish; one email; the deadline tick does nothing (`0 / 0`, still 1 email, 5 messages) |
| **inbound major** — the same voip.ms `id` delivered twice (form POST, sequential and concurrent) | 2 inbound rows, 2 forwards per staff member, 2 `Got it` replies to a redelivered YES | 1 row (`inbound:<id>`), 1 forward per staff member, 1 reply, 1 check-in doc |

The interrupted first attempt at this round had recorded the same five (g)/(h) failures, but
against a fake that stored `'actions.checkin_sent_at'` as a literal top-level key, so its
scenario was distorted (the engine took over a "stale" check-in lock instead). The numbers
above are from the honest run.

## What changed

### 1. Field-path writes everywhere (`src/services/checkin-workflow.ts`)

- `claim()` writes `{ ['actions.claims.' + key]: now, updated_at }` and returns only
  `{ status, created }`.
- The check-in step writes `actions.checkin_sent_at / checkin_recipients / checkin_failed`.
- `processReminderOffset` writes **`actions.reminder_state.offset_<n>`** = `{ offset_min,
  sent_at, recipients, failed, skipped }` — one field per offset, no array append. It also
  reports `claimed`, which `processRemindersStep` aggregates into `result.skipped_claimed`.
- The deadline step writes the top-level `non_responders / spot_not_held /
  deadline_recipient_count / deadline_responded_count / updated_at` plus
  `actions.deadline_processed_at` (and `actions.summary_sent_at: null` +
  `actions.summary_skipped: 'no_recipients'` when nobody could be texted).
- The summary step writes `actions.summary_sent_at`.
- `processDeadline` (the close route) does the same with its three outcomes; its extra
  "fresh" read is gone because nothing is spread any more.

### 2. `reminders_sent` is derived (`src/services/market-dates.ts`)

`marketDateFromData()` builds `actions.reminders_sent` — the array every reader, the status
route, the web page and `isDateDecided` use — from `actions.reminder_state` (offset-sorted),
over a legacy `reminders_sent` array (an offset present in both reads from the map; an
offset only the array holds is kept, so a recorded outcome is never dropped on read). No
production doc has either yet, so nothing migrates. `reminderStateKey(offset)` is the field
name (`offset_1440`); offsets are integers by zod, so dot notation is legal.
`isDateDecided` is unchanged and still freezes a date whose only action is a
`reminder_state` entry (tested, including through the generator).

### 3. The fake db (`tests/helpers/fake-db.ts`, `tests/fake-db.test.ts`)

`update(data)` honours dotted keys exactly as the admin SDK does — every rule below was
checked offline against `@google-cloud/firestore`'s own client-side validation first:
`'a.b.c': v` sets the nested field, creating intermediate maps (or replacing a non-map
parent); a plain key still replaces that top-level field; siblings are untouched; the doc
must exist (`NOT_FOUND`, now with gRPC `code: 5`); a key and a path inside it in one update
is rejected (`Field "a" was specified multiple times.`); dotted keys are literal in `set()`.
The stored doc is deep-copied before mutation (a `dump()` object captured earlier never
changes under a later write; the object handed to `set()` is not aliased) and Dates stay
Dates in the store (reads still hand back Timestamps).

**Additive, beyond the brief:** every write now refuses `undefined` values with the SDK's own
message. That guard is what caught the next item.

### 4. The `undefined` hazard the fake was hiding (found, fixed by construction)

The admin SDK rejects `undefined` anywhere in a write unless `ignoreUndefinedProperties` is
on (it is not, in `src/db/firestore.ts`). Phase 3 widened `marketDateFromData()` with optional
fields that are emitted as explicit `undefined`s (`checkin_recipients`, `summary_sent_at`,
`claims`, …), and every whole-map write spread that normalised object back:
`claim()`'s `actions: { ...fresh.actions, claims }` and the generator's
`actions: { ...existing.actions, deadline_at }` on the revive and undecided-update paths.
With the guard on, the round-1 engine failed **every `claim()`** and the nightly roll failed
every schedule update of an undecided date — i.e. the round-1 branch would have died at its
first production tick. Field-path writes carry no `undefined` and fix it structurally; the
whole suite runs with the guard on.

### 5. The idempotent inbound webhook (`src/services/inbound.ts`)

- `inboundRowId(providerMessageId)`: a real id → `inbound:<id>`; the route's
  `voipms-<Date.now()>` fallback (minted per delivery, identifies nothing), an empty id, or
  anything that is not a legal Firestore doc id (`/`, `.`, `..`, `__x__`, > 1000 bytes) →
  a uuid as before. Two deliveries without a real id therefore stay two messages — the
  provider gave us nothing to dedupe on, and voip.ms sends `id` with every delivery anyway.
- The inbound row is written with `create()`. `ALREADY_EXISTS` with the same sender and body
  is a provider redelivery: one info log line and `return` before any reply, forward or
  state change. **Extra guard:** the same id carrying a different sender/body (voip.ms does
  not document id uniqueness across SMS and MMS) is logged and processed under a uuid row
  rather than dropped.
- The `forwarded_inbound:<inbound row id>:<user_id>` dedupe key is unchanged in shape and is
  now stable across redeliveries by construction (they never reach it).
- `src/routes/sms.ts` is untouched: it already passes `params.id` or the fallback.

### 6. The summary email no longer holds the lock open

Inside `sendDeadlineSummary`'s email branch (used by both the engine's summary step and the
close) a non-`SendsDisabled` failure is caught, logged with `console.error`, and returned as
`email: false`; the step still writes `summary_sent_at`. **Trade-off:** the texts are the
authoritative, atomic channel; a lost email is a logged degradation. Round 1 let the failure
propagate, which left `summary_sent_at` unset with the summary lock held and — because a
takeover never emails — meant the email was never sent at all. The email is still sent only
by the run that created the lock.

### 7. Small items

- `DEDUPE_KEYS` documents the id alphabets that make the keys injective (slugs
  `/^[a-z0-9][a-z0-9-]{1,31}$/`, date ids `<slug>_<YYYY-MM-DD>`, uuid v4 producer/user ids,
  integer offsets) and `keyPart()` throws on an empty part or one containing `':'`.
- `upsertFormCheckin`: still read-modify-write, but a first submission uses `create()`; the
  loser of two concurrent first submissions re-reads the winner's doc and counts on top of
  it (submissions 2, the winner's `created_at`). Concurrent *re*-submissions can still
  under-count by one; the later answers win. `markTokenUsed` is documented: its update names
  only `uses` and `used_at`, so nothing else on the token can be lost.
- The clock is pinned (`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`) in
  `tests/inbound-checkin.test.ts`, `tests/checkin-public.test.ts`,
  `tests/market-dates-routes.test.ts` and `tests/checkin-workflow-concurrency.test.ts`
  (case (d) drives the resend route — not on the brief's list; found by the proof run).
  **Proof:** the whole suite run with a throwaway setup file that fakes the clock to
  2026-10-15 for every test that does not pin its own: 13 clock failures before, 335/335
  after. The throwaway config is not committed.

## Deviations from the brief (each deliberate)

1. **The generator's `actions` write is a field path, not "kept".** The brief said the
   generator keeps its existing write for undecided dates. That write spreads the normalised
   map and therefore carries `undefined`s the real SDK rejects (item 4), so it was replaced
   by `'actions.deadline_at': deadline_at` on the revive and undecided-update paths. For an
   undecided doc the effect is identical (its other action fields are the generator's own
   nulls), and the generator now cannot touch an engine field even if `isDateDecided` were
   ever wrong. Tested: a `reminder_state`-only date is frozen; an undecided date with an
   informational claim gets only `deadline_at` changed.
2. **Gated case (g), run A's `skipped_claimed` is 0, not 1** as the interrupted draft
   asserted: by the time A reaches `reminder_2880`, B has *finished* it, so `claim()`'s fresh
   read reports `done`, not `claimed` — consistent with every other step (done is never
   counted). The mirror case ("gated the other way", where B's write is still pending)
   asserts `skipped_claimed` 1, which covers the minor finding.
3. The fake's `undefined` guard and the same-id-different-text guard in the webhook are
   additions beyond the brief, for the reasons above.
4. `reminders_sent` derivation merges the legacy array with the map rather than falling back
   only when the map is absent — strictly safer, no production doc has either.

## Residual windows the owner should know about (carried forward or new)

1. **Stale-lock takeover is still read-then-write** (round 1, §1). Harmless for texts and,
   now, for flags (field paths carrying the same value); the email is sent by neither.
2. **Close racing the engine's deadline step in the same seconds** (round 1, §3): the close
   takes no lock, so if it reads the date before the engine's `deadline_processed_at` lands
   and both proceed, the engine's summary step can still email once more while the close's
   email is in flight. The overlap this round fixed (close during a long check-in or
   reminder loop) was the minutes-long one; this one is milliseconds. Closing it needs the
   close to take the `summary` lock, which changes the route's response semantics — left as
   is, documented.
3. `uses` / `submissions` can under-count by one under concurrent re-submissions (§7).
4. `workflow_locks` is never cleared; a keyed row that failed at the provider holds its key
   (round 1, §4–5). Unchanged.

## Things that look different in Firestore / the status page

- Engine-touched `market_dates` carry `actions.reminder_state.offset_<n>` maps;
  `actions.reminders_sent` stays the generator's `[]` on disk and is derived on read (the
  status route and the web page see the same array as before, so `web/` is untouched).
- Inbound `messages` rows are `inbound:<voip.ms id>` instead of uuids; their forwards'
  keys read `forwarded_inbound:inbound:<id>:<user_id>`.
- A close no longer rewrites `actions`; only the fields it sets change.

## Owner actions

None beyond contract §8. No new env keys, no index, no rules change. Deploying functions
from the merged tree is what makes the fix live; until then production runs the Phase 2
engine (`processReminders` only), and nothing producer-facing can be sent there yet because
no producer has a phone (§3.6).

Totals: `npm run typecheck` clean; `npm test` 30 files / 335 tests (round 1: 28 / 311);
`cd web && npx tsc --noEmit` clean with an empty `web/` diff.
