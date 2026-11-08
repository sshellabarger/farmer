# Phase 4 release notes - C2 (web admin)

Branch `rework/p4-web-admin`. Everything is under `web/src/**` plus this file.

## What was built

- `web/src/lib/phase4-types.ts`: byte copy of C1's shared file (sha256 `d1ef5438...f4f44e`, 427 lines).
- `web/src/lib/api.ts`: the `export` hunk on `qs` and `request` (hash after the hunk alone matched `97d6ec3a...`), then the Phase 4 helpers appended inside `api` (contract 4.2). No existing helper was removed or renamed. `getProducers`, `getProducer`, `createMembership`, `updateMembership` gained optional Phase 4 parameters/response fields.
- `web/src/lib/types.ts`: `Market`/`UpdateMarketInput` season, fees, payment links, legal, booth map, categories, product types; `Producer` Phase 4 fields (`products` now `(string | ProductEntry)[]`); `FeePlan = 'seasonal' | 'daily'`; `Membership` season/spaces/electric/pay_in_full/booth_kind/trial/insurance/hold_harmless/approved_items/item_requests/application_id; `DashboardCard.season`; `MarketDateActions` booth fields; `MarketDateStatusView.assignments` and the new `next_due` actions; `ApplicationAction`, `ApplicationInvite`, `InviteBatchResult`, `InsuranceUpdateInput`, `BoothInput`, `BoothSeedInput`, `AssignmentsView`.
- `status-chip.tsx`: the new colours.
- `/admin/applications`: queue with status tabs (incl. withdrawn), market, season, fee, category, new/returning filters and a debounced search. Rows open `/admin/applications/detail?id=`.
- `/admin/applications/detail`: `application-view.tsx` (every section; uploads open through a signed URL in a window opened synchronously so popup blockers allow it), Start review, Approve dialog (prefilled from the booth request, usual booth select from the market's booths, fee total preview from `market.fees`, send checkbox), Decline (reason required), Withdraw, fee paid/waived/unpaid with reference, notes saved when focus leaves the card, and the approval `sends` outcome plus a link to the producer.
- `/admin/markets/detail`: "Season & fees" (with "Invite returning vendors...": dry run, then confirm), "Legal texts", "Booths" (`booth-grid.tsx` edit grid, add booth, retire/reactivate, up/down reorder per row, and the "Seed V1-V22 from the WLRFM map" button, the only place that layout is spelled out). Legal texts are admin-only; the other two render read-only for market managers.
- `/admin/market-dates`: "Assignments" card after "After the deadline": draft/redraft, a select per booth, a second-space picker for two-space vendors, unplaced/not attending/no answer lists, approve confirmation ("Approve and text N vendors their booth?"), booth text status (sent / deferred until / failed counts), the booth messages, and the not-in-window warning.
- `/admin/producers/detail`: memberships grouped by season (current editable, earlier seasons collapsed as history), per membership fee plan/spaces/booth kind/usual booth/electric/paid in full/trial, insurance block (status, expiry, Open certificate, Update insurance...), agreement block (signed name and time, or Send agreement link / Copy link), approved items with Approve/Decline of requests and direct add; profile gains website, social, address, public description, categories and a read-only products table; header "Invite to re-apply" (copies the link, shows send outcomes, offers a forced resend on 409 "Already invited").
- `/admin` dashboard: season label on each card.

## Could not verify

- No manual run against `npm run dev` + `npm run dev:web`: the Phase 4 backend routes live on the A1/A2 branches, so the new screens were checked only by `npx tsc --noEmit` and `npx next build` (both green). The checks C2 owes once the branches are merged: queue filters, approve dialog, booth seed + power flags + reorder, draft/reassign/approve on a date, producer detail per-season view.
- The signed-URL "Open" buttons depend on the IAM grant in contract section 6 step 3.

## Deviations and judgement calls

- `FeePlan` becomes `'seasonal' | 'daily'` as specified; the producer page still normalises `weekly/season/both` when reading, in case the memberships endpoint returns raw Phase 2 values.
- Season & fees: a blank season label sends `season: null` only when the market already has a season; otherwise `season` is omitted from the PATCH. If A1's zod does not accept `null` for `season` that clear action will 400 (no other path breaks).
- The fee total in the approve dialog is a local preview (`previewSeasonTotal` in `application-view.tsx`, same arithmetic as contract 2.2) because `fees.ts` belongs to C1. The server's frozen `season_total` is shown on the application itself.
- "Open certificate" on a membership goes through `GET /api/applications/:id/uploads/:upload_id/url` with the membership's `application_id`; it is shown to admins only and only when both ids exist.
- The Assignments panel treats `redraft = !!drafted_at` so a draft that was skipped by the engine (no placement) can still be drafted by hand.
- Past seasons are shown read-only; Phase 4 code never edits them.

## Owner actions

None specific to C2. The contract section 6 list applies (season label, fees, legal texts, "Seed V1-V22", power flags, invite returning vendors) and all of it is now doable from the admin pages.
