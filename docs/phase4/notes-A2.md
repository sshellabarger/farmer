# Phase 4 release notes - executor A2 (booths, assignments, booth texts, Hold Harmless, insurance)

Branch `rework/p4-booths`, from `f0ddd81`. `npm run typecheck && npm test` green (39 files, 457 tests; the
Phase 3 suite is untouched and passes).

## What was built

- **Shared modules, byte-identical copies:** `src/services/seasons.ts`
  (`8593e84d...9fa8`, 275 lines) and `src/services/purpose-tokens.ts` (`552d512f...cc7a`, 165 lines);
  the `schema.ts` hunk (post-hunk sha `43dff1dc...8d902` verified) plus the A2 block at EOF.
- **Booths** (`src/services/booths.ts`, `src/routes/booths.ts`): doc id `${market_id}_${slug(label)}` via
  `create()`; list / create / seed / patch (rename keeps the id) / retire (`active:false`, never deleted) /
  reorder. Reads are market-scoped staff; writes are admin; every write audits (`booth.*`).
  Nothing names a stall: the V1-V22 layout is whatever the admin seeds.
- **Assignments** (`src/services/booth-assignments.ts`): append-only `booth_assignments` keyed by the
  TARGET date; the pure `planAssignments` (usual booths, neighbour pairs, powered stalls kept for electric
  vendors, food-truck slot, deterministic); `draftAssignments` (initial / redraft, manual rows are fixed);
  `applyAssignmentChanges`; `buildAssignmentsView` (the `AssignmentsView` of contract section 3.4).
- **Engine** (`src/services/checkin-workflow.ts`): `listRecipients` reads only the market's current season
  (through `seasons.ts`; optional `{ now }`); `DEDUPE_KEYS.booth`; `TEMPLATES.booth`; the drafts step
  (replaces the stub; records `drafts_skipped` once so it never loops); the booth-texts step; and the
  exported `draftNow`, `approveAssignments`, `sendBoothTexts` that the routes share, so the engine and the
  staff buttons take the same locks (`drafts`, `redraft_<version>`, `approve`, `booth_texts`).
  `EngineResult` gains `drafts_generated`, `booth_texts_sent`; `functions.ts` logs them.
- **Routes** (`src/routes/market-dates.ts`): status gains `assignments` and `next_due` `drafts` /
  `booth_texts`; `resend-checkin` finds the membership with `findMembership(current season)`; new
  `POST .../assignments/draft`, `PATCH .../assignments`, `POST .../assignments/approve`.
- **Hold Harmless** (`src/services/agreements.ts`, `src/routes/agreements.ts`): public
  `GET/POST /api/agreements/:token`; signing writes `hold_harmless`, flips `approved -> active` (history
  `by: 'producer'`), spends the token, audits `membership.agreement.signed`, sends nothing.
- **Insurance + agreement link** (`src/routes/insurance.ts`): `PATCH /api/memberships/:id/insurance`,
  `POST /api/memberships/:id/agreement-link` (new token, one `acceptance`-kind text, no dedupe key).
- **Tests:** `booths`, `booth-assignments`, `assignments-routes`, `booth-texts`, `agreements`, `insurance`,
  `recipients-season` (contract section 5.2, plus concurrency: 3 simultaneous drafts/ticks/approvals/signatures).

## Not built / not verified

- No real provider, Firestore or Storage was touched; everything ran on the fake DB and the console
  providers. Quiet-hours behaviour is exercised with pinned clocks (America/Chicago, CDT and CST).
- Booth texts that fail at the provider are counted (`booth_text_failed`) but not retried - same as the
  Phase 3 check-in step. There is no staff "resend booth text" button.
- The engine only looks at dates within 7 days of their close. If staff approve later than that, the text
  relies on the approve route's immediate attempt; a quiet-hours deferral past the window is not picked up
  by the engine (the panel should say so when the status route's `in_window` is false).
- A manual unassign (empty `booth_ids`) is not remembered: a later redraft seats that vendor again.
- Unassigned reasons in the staff view are derived from the booths still free (an admin who unassigns a
  vendor while stalls remain sees `full`, the closest enum value).

## Owner actions (A2's part of the contract section 6 list)

1. Admin -> Markets -> WLRFM -> Booths: seed the layout and set `power` on the right stalls (step 4d).
   Until booths exist the engine records `no_booths` and does nothing; drafts can still be made by hand
   once booths exist (the manual Draft button works after an engine skip).
2. Paste the Hold Harmless text and version into Legal texts BEFORE approving applications: signing is not
   blocked when the text is empty, so a link opened before the text exists would record a blank agreement.
3. Nothing texts a producer until their membership is `active` in the current season AND they have a phone;
   booth texts are the first thing the engine sends in 2027, after staff press Approve.

## Deviations from the contract (and why)

1. **`kind: 'acceptance'`** for the agreement-link text: `SmsKind` gains it only in A1's `sms.ts` hunk and A2
   may not edit that file, so `agreements.ts` widens it with one `as unknown as SmsKind` constant. Redundant
   after the merge (the merger can replace it with the literal).
2. **`next_due` `drafts`** is announced only when the market has at least one active booth. The Phase 3
   e2e (which must pass unchanged) expects `{ action: 'none' }` after the summary; a market with no booths
   has nothing to draft anyway.
3. **Booth texts are sent at the first instant that is both >= `nextAllowedInstant(approved_at)` and outside
   quiet hours now** (contract: only the first condition). Otherwise an engine retry at 22:30 after a crash
   at 10:00 would text during quiet hours.
4. **`TEMPLATES.booth` length:** the wording is verbatim from the contract, but with a 40-character market
   name it is 172 characters (the contract says <= 160). It stays within two SMS segments; WLRFM's real name
   gives two segments for a two-booth vendor.
5. **Locks:** the manual first draft uses the engine's `drafts` lock; a redraft uses `redraft_<ms of the
   draft version it replaces>` so two concurrent redrafts collide and the next one does not. Every refusal is
   decided before any lock is taken (locks are never cleared). Signing writes `hold_harmless` only while null
   (as specified) but, because there is no transaction, also takes `workflow_locks/agreement__<membership_id>`
   (stale after `CLAIM_TTL_MS`) so two simultaneous signatures cannot both write.
6. **Agreement edge cases the contract left open:** a token spent without a signature on the membership does
   not block signing (the membership's signature is the truth); a wrong-purpose token (application token) is
   404; signing an `inactive` membership is 409; an agreement link can only be issued for `approved` or
   `active` memberships.
7. **Insurance:** "expires on D" is stored as market-local midnight at the start of D+1 (valid through D);
   `upload_id` keeps its stored value when the request omits it (the schema default would otherwise detach
   the certificate on every status change) and a new `upload_id` must exist in `application_uploads`; the
   response resolves an `on_file` certificate past expiry to `expired` (the stored status is unchanged).
8. **Booth retire guard** (409 when a current-season membership names it as `usual_booth_id`) also applies to
   `PATCH { active: false }`, and counts memberships of any status in the current season, as written.
9. **Row order is alphabetical** by the row label (`east` before `west`), because the contract orders by
   `(row, order)`. It only decides which free booth is suggested first; the labels the admin chooses for rows
   can steer it.
10. `PATCH .../assignments` does not enforce `booth_ids.length <= spaces` or booth kind (contract: 0-2 booths,
    attending vendors only); a booth another vendor holds is allowed and surfaces as a conflict that blocks
    approval.

## For the merger

- `seasons.ts` / `purpose-tokens.ts` / the `schema.ts` hunk are identical to A1's; git resolves the add/add.
- `src/app.ts`: A2 adds three imports after the `createErrorHandler` import and three registrations after
  the dashboard route; A1's `storage` pieces go elsewhere.
- Both A1 and A2 add `application_*` / `booths` lines to `src/db/firestore.ts` at different anchors.
- `agreements.ts` reads `market.legal.hold_harmless_markdown / _version / insurance_help_url` as plain
  fields, so it works before and after A1's `FarmersMarket.legal` typing lands.
