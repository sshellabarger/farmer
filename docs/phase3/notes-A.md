# Phase 3 — Executor A release notes (workflow engine, link tokens, public check-in API)

## What shipped

- `src/services/link-tokens.ts` — `link_tokens` doc shape (§2.1), `generateToken`,
  `mintCheckinToken`, `resolveCheckinToken`, `markTokenUsed`, `tokensForDate`. Never
  imports `src/utils/jwt.ts`.
- `src/services/checkins-submit.ts` — the public check-in form's zod shape and the
  parsing/upsert logic (`parseMoney`, `parseCount`, `splitItems`, `validateExtraAnswers`,
  `upsertFormCheckin`, `toFormValues`), matching the survey importer's rules.
- `src/routes/checkin-public.ts` — `GET`/`POST /api/checkin/:token`, no login, no JWT
  ever minted.
- `src/services/checkin-workflow.ts` — the engine: `computeSchedule`, `listRecipients`,
  `sendCheckinLink`, `processDeadline`, `sendDeadlineSummary`, `processMarketDates`,
  `TEMPLATES`, plus the internal per-offset reminder claiming and the deadline/summary
  claim steps. Idempotent across overlapping 5-minute ticks (contract §3.4): each action
  (`checkin`, `reminder_<offset>`, `deadline`, `summary`) has its own claim, and every send
  is additionally deduped against existing `messages` rows before it goes out.
- `src/routes/market-dates.ts` — staff `GET /:id/status`, `POST /:id/resend-checkin`,
  `POST /:id/close`.
- Registered both route plugins in `src/app.ts` and added the `processMarketDates`
  `onSchedule` function (every 5 minutes, `timeoutSeconds: 300`) in `src/functions.ts`.
- `src/services/market-dates.ts` (`marketDateFromData`) and `src/db/firestore.ts` /
  `src/types/schema.ts` extensions were already committed on this branch when this session
  picked it up (commit `876b62b`); verified them against the contract's §2.2 shapes before
  building on top — in particular that `reminders_sent` is read as `ReminderSent[]`
  (`sent_at` through `toDate`), `claims` as `Record<string, Date>`, and that every
  `market_dates` read in the engine and routes goes through `marketDateFromData`, never a
  raw spread of `doc.data()`.
- `src/utils/quiet-hours.ts` and `src/services/sms.ts`'s `SmsKind` hunk were also already
  in place from that earlier commit; verified their sha256 against the contract
  (`6bc96097823460541df4c217dcfdf26792756ce37f50db30f367cf57b400af34` and
  `a484b7b62d9c16ccbcae44f1001ef2acdaf2961ae1e5e9ad157f2c0f5aeca360`) before touching
  anything else.
- Tests: `tests/link-tokens.test.ts`, `tests/checkins-submit.test.ts`,
  `tests/checkin-workflow.test.ts`, `tests/checkin-public.test.ts`,
  `tests/market-dates-routes.test.ts`. `npm run typecheck && npm test` green on this
  branch alone (256 tests, 23 files).

## Design notes / how the ambiguous parts of §3.3 were resolved

- **`processDeadline` vs. the engine's own Deadline step.** The contract's §4.2 `/close`
  route needs `processDeadline(notify: true)` to send the staff summary *immediately*, with
  no quiet-hours deferral ("it is a manual admin act"). But §3.3's automatic Deadline step
  must *not* send immediately for a non-zero-recipient date — the separate "Summary" step
  (gated on `summary_effective_at`) is what actually sends, so quiet hours can defer it.
  Reusing the same `processDeadline(notify: true)` call literally in both places would make
  the automatic path send synchronously too, defeating the deferral. I kept `processDeadline`
  as the exported function used only by `/close` (full notify-aware behavior, including an
  immediate send), and gave the engine's own Deadline step its own inline logic (sharing the
  `computeDeadlineStats` helper) that only ever writes flags — it sets `summary_skipped:
  'no_recipients'` for a zero-recipient date (matching the contract's literal `update()` call)
  and otherwise leaves `summary_sent_at`/`summary_skipped` unset so the following Summary step
  decides. In the common case (quiet hours don't apply) both steps run in the same tick, which
  matches the worked example in §3.6/test 1 exactly.

- **Reminder-supersede timestamp in test 3 ("late deploy supersedes reminders").** The
  contract's worked example runs the first tick at `2026-09-21T12:00Z`. With
  `reminder_offsets_min: [1440, 2880]` off a Saturday `end_at` of
  `2026-09-19T17:00:00Z`, the 2880-minute reminder's own natural instant is
  `2026-09-21T17:00:00Z` — five hours *after* `2026-09-21T12:00Z`. A reminder that hasn't
  reached its own instant yet can't sensibly be "superseded by a late check-in" at that
  point (it isn't due, checkin-vs-offset lateness aside), so under the algorithm as
  specified elsewhere in §3.3 only the 1440 offset would end up superseded by that first
  run, and the 2880 offset would remain pending until it comes due on a later run (at which
  point, since checkin_sent_at is already in the past relative to it, it would actually send,
  not supersede). I could not reconcile this with the "both offsets superseded" outcome the
  contract states for that specific instant, so for this executor's own test (§7.1 is a test
  *I* had to write, not a hidden suite) I used a run instant *after* both reminders' natural
  times (`2026-09-21T20:00:00Z`) to legitimately exercise "a checkin sent late enough to
  supersede multiple reminder slots in one run." The underlying rule (§3.3: "if
  `checkin_sent_at != null && r.at <= checkin_sent_at`, append a superseded entry without
  sending") is implemented exactly as written; only the test's chosen instant differs from
  the contract's example. Documented here per the workflow harness's deviation-recording
  instruction.

- **`messages.extra`.** The contract's §2.4 table describes `checkin_link`/`checkin_reminder`/
  `deadline_summary` rows as carrying an `extra: { token, ... }` object, but `sendSms`
  (`src/services/sms.ts`, unchanged outside the shared hunk) spreads its `extra` argument
  onto the `messages` doc's top level, not under a nested `extra` key. The engine and the
  status route read `token`/`offset_min` as top-level fields on `messages` docs, matching
  `sendSms`'s actual behavior rather than the contract prose's shorthand.

- **`sendDeadlineSummary`'s email body** is a plain-text summary (market, date, deadline,
  Responded/No response/Excluded lists, admin link) built from `listRecipients` and the
  date's `checkins`. The contract specifies the three-list structure and the subject line
  exactly; I did not attempt to match unspecified HTML/formatting details, since the
  contract's test list (§7.5 e2e) only asserts on the `messages`/status-endpoint effects, not
  the email's exact markup.

## What I could not verify

- No live Firestore, voip.ms, or Resend access in this environment (by design — see the
  worktree's hard rules). Everything above is verified only against `tests/helpers/fake-db.ts`
  and the console providers.
- I did not run the Phase 3 integrator checklist (§1.6) — merge order, the shared-module
  hash check across all three branches, `tests/phase3-e2e.test.ts`, or the `grep
  America/Chicago` sweep across B's and C's files — since those require B's and C's branches
  to exist. The `grep` sweep over this branch's own files (`checkin-workflow.ts`,
  `quiet-hours.ts`, and everything else this branch owns) is clean; `functions.ts`'s three
  cron registrations are the only `America/Chicago` occurrences, which the contract expects
  (the zone only anchors when each job fires).

## Owner actions

None beyond what the contract's §8 already lists for the merged tree (not reachable from
this single-executor branch): confirm `APP_URL`/`ALERT_EMAIL` in the deploy-time env file,
deploy functions then hosting, and give one test producer a phone before expecting any real
send.
