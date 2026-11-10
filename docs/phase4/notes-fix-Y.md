# Phase 4 fix notes - fixer Y (booth side)

Branch `rework/p4-fix-booths`, from `rework/p4-fix` (`4332952`). `npm run typecheck && npm test` green
(51 files, 699 tests); `cd web && npx tsc --noEmit && npx next build` green (22 static routes, no `[param]`).
Nothing was deployed, pushed or run against a real project; every test uses the fake DB and the console
providers.

Files touched: `src/services/{booth-assignments,checkin-workflow}.ts`, `src/services/market-dates.ts`
(action fields and their parsing only), `src/routes/market-dates.ts`,
`web/src/app/admin/market-dates/page.tsx`, and, shared with fixer X, `web/src/lib/phase4-types.ts` (one
block inserted after `AssignmentSource`), `web/src/lib/api.ts` (one block inserted after
`getMarketDateStatus`) and `tests/phase4-e2e.test.ts` (the booth-text id assertion only).
Tests: `booth-assignments`, `booth-texts`, `assignments-routes` updated; `booth-text-changes`,
`season-opener` and `helpers/booth-fixtures` are new.

## The model in one page

**Cycles.** A market date document can carry two booth-assignment cycles, each with its own draft,
approval and booth-text state:

| cycle | state lives at | target | who is on the list | drafted by |
|---|---|---|---|---|
| `next` (every date) | `actions.*` (unchanged) | `actions.assignments_target_date_id` - the next market | vendors who answered "attending next" on this date | the engine at `drafts_at`, or staff |
| `opener` (the season's first market date only) | `actions.opener.*` | the date itself | the season's ACTIVE memberships on the seasonal plan | staff only |

Every assignments route takes `cycle` (`next` is the default, so existing callers are unchanged). Lock keys
of the opener cycle are prefixed `opener_`. All writes are field paths under the cycle's prefix.

**What a vendor is owed is computed, not remembered.** `planBoothTexts(rows, booths, log)` (pure) compares
the current assignment rows of the target date with the `messages` log of kind `booth` for that date and
returns, per vendor, the one text that reflects what they hold now and whether they have been told:
`sent`, `queued`, `failed` or `owed`. The engine sends the `owed` ones; the staff view shows all of them.

**Keys.** `booth:<target>:<producer>:<id of the vendor's newest current assignment row>` and
`booth_release:<target>:<producer>:<id of the assignment that was told and taken away>`. A staff change
supersedes every row of that vendor and writes new ones, so a changed assignment has a new key (one
corrective text) and an unchanged one can never be texted twice.

**When the engine looks.** `assignments_rev` is a fresh token written on every staff change (before the
rows move and again after); the booth-text step records the token it acted on in `booth_texts_rev`.
`boothTextsSettled(state)` is pure, so each tick the engine skips every settled cycle without a read and
processes every approved cycle that is not - whatever the date's age, including a date still in the future
(the opener).

## What changed, item by item

- **Y1 - no booth text for a double-booked booth.** After approval `PATCH .../assignments` refuses a change
  that would leave a booth with a second vendor: `409 { code: 'conflict', booth_id, booth_label, error }`
  (a swap sent as ONE request is fine; a double booking that already exists is not made worse by moving a
  vendor off it). `sendBoothTexts` re-reads the rows and, while `conflictedBoothIds` is non-empty, sends
  nothing and records `<cycle>.booth_texts_blocked = 'conflict'` (cleared when it later sends). Staff
  changes are also serialised by a mutex (`workflow_locks/<date>__[opener_]assignments_change`, created
  with `create()`, deleted when the change ends, taken over after 3 minutes): two simultaneous changes can
  no longer each pass the conflict check against the same rows - the second gets `409 code in_progress`.
- **Y2 - booth texts follow the current assignment.** The first pass texts every seated vendor once. A
  change after approval or after the texts went out is accepted (the `409 texts_sent` refusal is gone) as
  long as it creates no double booking and the target market has not started (`409 code target_started`);
  the next engine tick then sends exactly one corrective text ("... is now V6 ...") to each vendor whose
  booths changed and a short release notice to a vendor who had been told a booth and was removed. Changed
  and changed back before the engine ran = no text. All of it waits for the end of quiet hours like the
  first send. A provider failure leaves the row `failed` and is not retried by the engine.
  New route `POST /api/market-dates/:id/assignments/resend-text?producer_id=[&cycle=]`: staff with market
  access, unkeyed, audited as `market_date.assignments.resend_text` (no phone in the audit row), `409` with
  `code` `quiet_hours` (plus `allowed_at`), `not_approved`, `conflict` / `cancelled` / `started`,
  `nothing_to_send`, `pending` (the engine is about to send that very text) or `not_textable`.
  The assignments view gains `texts[]` (per vendor: type, booths, status `none | pending | sent | failed |
  blocked | excluded | skipped`, reason, last message, `can_resend`), `text_counts`, and `messages[]` now
  carries the text type and labels.
- **Y3 - the target date is validated.** `approveAssignments` refuses (409 `target_cancelled` /
  `target_started`) before taking any lock. `sendBoothTexts` sends nothing for a cancelled target
  (`booth_texts_blocked = 'cancelled'`, re-checked every tick without a lock, because a date still ahead
  can be un-cancelled) or one whose start time has passed (`'started'`, final - also for a cancelled
  target once its time has passed, so the engine stops looking; the view's `target_cancelled` says which).
- **Y4 - approved dates are never stranded.** The booth-text step left the per-date loop: after the
  windowed steps the engine walks every collecting date it already loaded and runs the step for each
  approved, unsettled cycle. The "outside the automatic window" warning on the panel is gone.
- **Y5 - opening day.** `seasonOpenerOf` = the earliest non-cancelled market date inside the season of
  `summarizeSeason(market)` (the market's season settings; nothing names a date). The opener cycle is
  described above. The date BEFORE the opener (the last market of the previous season) has no target
  (`no_next_date`): it must not seat last season's vendors on the new season's first day. On ANY date
  staff may now place a current-season active vendor who is not on the list (`source: 'manual'`, shown as
  "added by staff"); the 400 "not attending" is gone, the 400 remains for a producer who is not an active
  vendor of the current season. A manual Draft with nobody on the list is no longer refused
  (`no_attendees`): it creates an empty draft so vendors can be added by hand (the engine still records
  the skip and does nothing).
- **Y6 - planAssignments pass 1.** A two-space vendor on a free usual stall takes the free same-row
  neighbour (order + 1, else order - 1) whatever its power flag. An electric vendor keeps an unpowered usual
  stall and the plan returns `warnings: [{ producer_id, reason: 'power_mismatch', booth_ids }]` (also in
  the draft result and, computed live, in the view).
- **Y7 - one segment.** `TEMPLATES.booth` drops the STOP line (the comment says why; STOP and HELP are
  still honoured by `inbound.ts` and the weekly check-in text carries the wording). With a 31-character
  market name, a 12-character first name and two labels it is 149 characters, 153 with "is now". Longer
  inputs drop the greeting name, then the closing sentence, before they would split.
  `TEMPLATES.booth_release` is new.
- **Y8 - computeNextDue.** Once the deadline has passed or been processed neither the check-in text nor an
  unrecorded reminder is "next" (same rule as the engine). `booth_texts` is taken from the views' live
  `booth_texts_due_at`, and an opener's booth texts come first when they are due earlier.
- **Y9 - admin panel.** One Assignments card per cycle ("Opening day assignments" first while that market
  is ahead). It shows the hold reason, the per-vendor text table with a Resend button, the power / second
  space / unplaced warnings, "Opening day: the list starts from seasonal vendors", hand-added vendors
  (`+ Name (reason)` in every booth's list), and a confirmation box for changes after approval that names
  who will be texted what. New `api.ts` helpers: `getMarketDateBoothStatus`, `draftBoothAssignments`,
  `updateBoothAssignments`, `approveBoothAssignments`, `resendBoothText`; types in `phase4-types.ts`.

Three additions that came out of the work rather than the item list:

- **`season_mismatch`.** Drafting an opener is refused (409) while the market's current season is not the
  season that date belongs to - next year's schedule version exists but the season label was never set.
  Without it the opener would be seated from, and texted to, last season's vendors.
- **`not_ended`.** The "next market" draft of a date is refused (409) until that date's market has ended.
  Because an empty manual draft is now allowed, a Draft pressed months early would otherwise have recorded
  `drafts_generated_at` and silently replaced the engine's own draft after the market. The view carries
  `draft_open`.
- **The view is more honest.** `unassigned[].reason` gains `not_placed` (a suitable booth IS free: nothing
  drafted yet, or staff took the booth away) so `full` only ever means "every booth is taken"; and
  `conflicts[]` names every vendor on a double-booked booth (the grid can only show one).

## Deviations from the contract (deliberate, all asked for by the fix items)

1. `messages` dedupe key for booth texts: contract 2.12 says `booth:<target>:<producer>`; it is now
   `booth:<target>:<producer>:<assignment id>` (Y2). No production row uses the old key (Phase 4 was never
   deployed).
2. Contract 3.4 `PATCH` "409 when `booth_texts_sent_at` set" and "400 not attending" are removed (Y2, Y5);
   "after `approved_at` the change is allowed" now has two refusals (`conflict`, `target_started`).
3. Contract 3.5 template wording: the STOP line is gone from the booth text (Y7).
4. Contract 3.4 draft "409 no_attendees" applies to nothing any more: the manual draft is empty instead.
5. `messages` rows of kind `booth` carry `booth_text`, `assignment_id`, `booth_ids`, `seq` (and `resend`)
   next to `booth_labels` / `source_date_id`.
6. `workflow_locks` now holds one lock that IS deleted (the change mutex). `src/db/firestore.ts` (not my
   file) still says "never cleared" in its comment.

## Residuals - things this round did not solve

- **A market cancelled AFTER its booths were approved leaves the following market without a source.** If
  Saturday T is cancelled before the date before it is approved, a Redraft simply targets T+1 (the panel
  says so). Once that cycle is approved it is closed to redraft and there is no "unapprove"; T itself is
  not a collecting date, so no check-in runs for it and nothing drafts T+1. Staff cannot assign T+1
  through the app. The opener cycle (a date that assigns itself, drafted by hand) is exactly the mechanism
  that would cover it, but allowing it on "any date whose previous market was cancelled" is a product
  decision that was not in scope. The approved cycle's own texts are held (`cancelled`) and the panel says
  why.
- **The opener's own state does not freeze the date.** `isDateDecided` (the generator) and the un-cancel
  check in `src/routes/markets.ts` look at `actions.approved_at` etc., not `actions.opener.*`; a schedule
  change can still move or cancel an opening day whose booths were already approved and texted. Both files
  were outside this fixer's scope; the fix is one extra clause in each.
- **If the season's first date changes after the opener was drafted**, the old date keeps its opener
  rows and is now also the target of the date before it; the two sets of rows show up as double bookings
  (which block texts) and need cleaning up by hand.
- **Corrective texts are not instant.** A change after approval is texted by the next engine tick (up to
  five minutes), so several edits in a row become one text per vendor. Approval still sends immediately.
- **A vendor who could not be texted when the texts went out** (no phone, opted out) is not texted
  automatically when that changes: the row shows `skipped` and staff press Resend.
- **Two requests that arrive together at a STALE change mutex** (left by a request that died more than
  three minutes earlier) can both take it over, exactly like the engine's stale step locks. The booth-text
  step's own double-booking check is what stands behind that.
- **A staff request that overlaps a booth-text pass and then changes nothing** (refused, or a no-op) can
  delay that pass by up to ten minutes: the pass backs off, and its step lock for that version of the
  assignments has to go stale before the next tick retries. Nothing is lost or doubled.
- **A `queued` row that never got the provider's answer** (the function died mid-send) counts as "told" for
  the engine (it will not send again) and is shown as `failed` after 10 minutes so staff can resend.
- **An approved cycle on a date that is itself cancelled** is never visited by the engine (it reads
  collecting dates only). For an opener that is the desired outcome; for a `next` cycle it means the texts
  for the following market are not sent.
- **Quiet hours that end when the market starts.** Approving the night before a market whose start equals
  the end of quiet hours sends nothing (the target has started by then). The view carries
  `booth_texts_too_late` and the panel tells staff to call the vendors.
- The web panel was type-checked, built, and its Assignments card server-rendered without error against
  real views produced by the backend over the fake database in thirteen states (preview, drafted, double
  booked, approved in quiet hours, texted, change pending, released, cancelled target, started target, and
  the opener's four) with and without edit rights. It was NOT exercised in a browser against a live API:
  the click handlers (draft, change, confirm, approve, resend) are covered by the type checker only.
- The old `draftAssignments` / `updateAssignments` / `approveAssignments` helpers in `web/src/lib/api.ts`
  and the old `AssignmentsView` type in `web/src/lib/types.ts` are left in place (shared / not my files)
  and are no longer used by the page.

## Owner notes

1. **Opening day 2027.** After the 2027 schedule version exists AND the season label is set to 2027 on
   the market, open Admin -> Markets -> WLRFM -> the first Saturday (Apr 3). The "Opening day assignments"
   card is there: press Draft (seasonal vendors are seated, usual booths first), add daily-plan vendors
   from any booth's list, then Approve. Texts go out at once, or at 08:00 if you approve during quiet
   hours - weeks ahead is fine. Draft is refused with a clear message if the season label is still last
   year's, because it would seat last year's vendors.
2. **Changing a booth after approval is now normal.** Pick the new vendor on the booth; the panel asks you
   to confirm and tells you who will be texted. To swap two vendors, do it in one step (pick vendor A on
   vendor B's booth: B is taken off it in the same change) - putting a second vendor on an occupied booth
   is refused once approved.
3. **Booth texts are one SMS now** and no longer end with "Reply STOP to opt out." (the weekly check-in
   text still does, and STOP always works).
4. **If a booth text fails** the Booth texts table shows `failed` with a Resend button; it is not retried
   automatically.
5. **If a Saturday is cancelled**, the assignments for the Saturday after it cannot be made in the app yet
   (first residual above). Tell me if you want any date to be assignable "by hand" the way opening day is.
