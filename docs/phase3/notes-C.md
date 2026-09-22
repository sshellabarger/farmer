# Phase 3 executor C — web (`web/src/**`) release notes

Branch `rework/p3-web`, built against the Phase 3 contract's web section (§6) and types
(§6.3). Built against the contract's types only — the backend (executors A/B) is not
running in this worktree, so nothing here was exercised against real API responses.

## What was built

- **`web/src/lib/types.ts`** — appended the Phase 3 shapes: `ReminderSent`, the Phase 3
  additions to `MarketDateActions` (`checkin_recipients`, `checkin_failed`,
  `summary_sent_at`, `summary_skipped`, `claims`) and `MarketDate` (`non_responders`,
  `spot_not_held`, `deadline_recipient_count`, `deadline_responded_count`), `CheckinSource`,
  `CheckinFormValues`, `CheckinSubmitInput`, `CheckinTokenView`, `DateScheduleView`,
  `MarketDateStatusView` (see deviation below), `CloseResult`. `Checkin.source` widened to
  include `'sms'`; added `submissions` / `partial`.
- **`web/src/lib/api.ts`** — `request<T>` now throws the exported `ApiError` (carries
  `.status`); appended `getCheckinByToken`, `submitCheckin`, `getMarketDateStatus`,
  `resendCheckin`, `closeMarketDate` per contract §6.2.
- **`web/src/components/status-chip.tsx`** — added the Phase 3 chip colours:
  `responded`, `no_response`, `late`, `spot_not_held`, `form`/`sms`/`import`,
  `deferred`/`pending`, `done`, `superseded`/`unreachable`.
- **`web/src/app/checkin/page.tsx` + `layout.tsx`** — the public, no-login check-in page at
  `/checkin?t=<token>`. Mobile-first, no `<Header>` (a slim top bar + a "text us" link in
  the footer instead), loads `api.getCheckinByToken`, renders `<CheckinForm>`, handles the
  404/410/other error states and the thank-you screen from contract §6.1. `layout.tsx` sets
  `robots: { index: false, follow: false }`.
- **`web/src/components/checkin-form.tsx`** — the fixed question set in the contract's
  order (attending-next Yes/No required, bringing/sold-out/unsold text, estimated sales
  with the "SJCA staff only, reported in aggregate" hint, transactions, feedback), then one
  control per `extra_questions` entry (`text`/`choice`/`yes_no`).
- **`web/src/app/admin/market-dates/page.tsx`** — the staff timeline page at
  `/admin/market-dates?id=<market_date_id>`: header with status chip and back-to-market
  link, an "older than the automatic window" warning, Timeline (check-in text / each
  reminder / deadline / staff summary, each with scheduled vs. effective time and a
  "deferred by quiet hours" note), Recipients table with a "Resend check-in link"
  `ConfirmButton`, Excluded table, After-the-deadline lists, Messages table, and an
  admin-only Close-date panel with a "text the summary to staff" checkbox. Every write
  re-fetches the status.
- **`web/src/app/admin/markets/detail/page.tsx`** — each date row gained a "Check-ins" link
  to the new page and a small glyph line (`✓ link`, `N rem.`, `✓ deadline`) built from
  `actions`. Table `colSpan`s bumped from 6 to 7 for the new column.
- **`web/src/app/admin/page.tsx`** — "Collecting: `<date>`" is now a link to
  `/admin/market-dates?id=<collecting_date.id>`.
- **`web/src/app/admin/producers/detail/page.tsx`** — the check-ins table gained Source
  (chip, with a "text only" note when `partial`), Bringing and Feedback columns, and the
  market-day cell now links to `/admin/market-dates?id=<market_date_id>`.
- **`docs/phase3/notes-C.md`** — this file.

## Deviations from the contract

1. **`MarketDateStatus` naming collision → `MarketDateStatusView`.** The Phase 2 contract
   already exports `MarketDateStatus` from `web/src/lib/types.ts` as the date-lifecycle
   string union (`'collecting' | 'lineup_final' | 'published' | 'cancelled'`), used
   throughout Phase 2 code (`MarketDate.status`, the markets detail page's status filter,
   etc.). The Phase 3 contract's §4.2 response type of the same name would silently shadow
   or conflict with it in the same module. Smallest sensible fix: the response type is
   named `MarketDateStatusView` here (and in `api.ts`'s `getMarketDateStatus`), keeping the
   Phase 2 union intact. Also added `DateScheduleView` for the nested `schedule` shape
   (contract's `DateSchedule` name is the workflow engine's own export in
   `src/services/checkin-workflow.ts`, so giving the web mirror a distinct name avoids any
   confusion when the two are read side by side, even though they live in different
   modules with no compile-time collision).
2. **`CheckinForm` takes an extra `marketName` prop.** The contract's prop list for
   `checkin-form.tsx` is `{ questions, initial, submitting, onSubmit }`, but the first
   question's copy is "Are you attending next `{market_name}`?" — the component cannot
   render that text without the market name. Added `marketName: string` as a prop; every
   other prop matches the contract exactly.
3. **Chip title on the After-the-deadline lists.** `non_responders` / `spot_not_held` are
   arrays of producer ids (contract §2.2); the page resolves each id to a business name
   from the already-loaded `recipients` list and shows it as the chip's `title` (hover) plus
   links each chip to the producer's detail page, since the contract doesn't specify a
   rendering for these id lists beyond "chips."

## What could not be verified

- No live backend: everything here was built and typechecked against the contract's types
  only (`cd web && npx tsc --noEmit && npm run build`, both clean; see below). None of it
  has been exercised against A's real routes or B's real inbound/status behaviour — that
  only happens once the three branches are merged and `tests/phase3-e2e.test.ts` runs
  (integrator step, contract §7.5).
- The §7.3 web tests were run by hand rather than as an automated suite (there is no
  Playwright/Cypress harness in this repo): `cd web && npx tsc --noEmit` clean; `npm run
  build` output shows no `ƒ` (dynamic) routes, and lists `/checkin` and
  `/admin/market-dates` as static (`○`); `find web/src/app -type d -name '*[*'` finds no
  `[param]` folder; `grep -rn "toLocale\|getTimezoneOffset" web/src/app/checkin
  web/src/app/admin/market-dates` prints nothing; `grep -n "SJCA staff only, reported in
  aggregate" web/src/components/checkin-form.tsx` matches.

## Owner actions

None specific to this branch — the owner actions in contract §8 belong to the integrator
once all three branches are merged and functions/hosting are deployed. This branch alone
changes nothing in production; it is inert until A's routes exist to call.
