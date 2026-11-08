# Phase 4 release notes: C1 (web public)

Branch `rework/p4-web-public`, from `main` at `f0ddd81`. Scope: the public pages `/apply` (five sections), `/apply?t=` prefill,
`/rules`, `/agreement?t=`, and the helpers behind them. Built against the contract's types; the backend was not running.

## What was built

- `web/src/lib/phase4-types.ts`: shared types, copied byte for byte from contract section 1.5 (sha256 `d1ef5438...4f44e`, 427 lines).
- `web/src/lib/api.ts`: the section 1.6 hunk only (`export` on `qs` and `request`; sha256 `97d6ec3a...a55`).
- `web/src/lib/api-apply.ts`: `applyApi` exactly as section 4.1 (upload is an `XMLHttpRequest` multipart POST with progress events and
  `draft_id` and `kind` appended before `file`). Extra export: `firstActiveMarketId()`, used when the URL names no market.
- `web/src/lib/apply-draft.ts`: `loadDraft / saveDraft / clearDraft` under `localStorage['sjca_apply_<market>']`, every access in try/catch; also the
  form-state type, `validateSection`, `sectionReachable`, `applyPrefill` and `buildSubmitInput` (form state to the POST body).
- `web/src/lib/fees.ts`: `computeSeasonTotal` mirroring section 2.2 (seasonal 2 spaces electric pay-in-full gives 1250; daily 1 space electric gives
  30 per market), plus `formatMoney` and `describeTotal`.
- `web/src/lib/markdown-lite.ts` and `web/src/components/markdown.tsx`: headings, bullets, numbered lists, paragraphs, bold, http(s) links, rules.
  No raw HTML: everything is rendered as React text nodes. Non-http(s) link targets render as plain text.
- `/apply`: five sections with `progress-nav.tsx`; each validated before Continue; draft saved (debounced) as you type; `?t=` runs `getPrefill` first,
  shows "Welcome back, <business>", sets returning, and fills every field the prefill covers; an expired or unknown link shows
  "This link has expired. You can still apply below." (or the unknown-link variant) and gives the blank form. Closed season shows
  "Applications for <market> are not open right now." plus the rules link. Success page shows the fee button (`fee.url`), the text-back sentence and the
  server's `season_total`; the draft is cleared.
- `components/stall-picker.tsx`: rows as columns, north at top (ascending `order`), food-truck slots placed between the rows, powered stalls marked,
  `usually_taken` greyed but selectable, up to `limits.stall_preference_max` numbered picks, 48 px tap targets.
- `components/apply/upload-field.tsx`: client-side size and type checks, progress bar, server errors shown verbatim.
- D32 is built in: no co-marketing question, no applicant path without a booth. Section 3 has the required statement checkbox ("Each vendor sells
  only what they grow, raise or produce, from their own booth. Shared or cooperative retail booths are not permitted.") bound to
  `acknowledgements.own_booth_only`; section 4 has the other five acknowledgements.
- `/rules?market=`: `RulesView` through markdown-lite, or a link card to `rules_url`; 404 shows "The rules for this market are not published yet."
- `/agreement?t=` (layout is noindex): open state with typed name and agree checkbox; signed state; 404 "Unknown link"; 410 expired message. A 409 on
  sign reloads the view, which then shows the signed state.
- `web/public/wlrfm-vendor-map.jpg`: byte copy of `docs/wlrfm-vendor-map.jpg` (cmp verified).

## Verification

- `cd web && npx tsc --noEmit && npx next build`: clean. Root `npm run typecheck && npm test`: 342 tests pass (nothing outside `web/` changed).
- Logic spot-checks by compiling the libs to JS: seasonal total 1250 (paid in full) and 700 with 2 installments; daily 30 per market; markdown-lite
  output for headings, lists, bold, https and `javascript:` links and a literal `<script>` line (kept as text).

## Not verified (needs the merged backend)

The manual checks in contract section 5.3 were NOT run, because the API was not available: a full submission at 375 px, draft survival across a reload,
prefill from `?t=`, upload progress against the real endpoint, the live total against a real `season_total`, `/rules`, and `/agreement` sign and
re-open. Please run them against `npm run dev` + `npm run dev:web` after the merge.

## Owner actions

- After the merge, set the market's `booth_map_url` to `/wlrfm-vendor-map.jpg` (contract section 6, step 4b).
- The stall picker orders rows west, center, east when the row labels are those compass words; any other labels sort alphabetically after that.

## Deviations from the contract

1. Added `web/src/components/apply/kit.tsx` (not in the file list): shared public-page shell, inputs, radio and checkbox rows, error list. The existing
   `form.tsx` lacks `autocomplete`, `inputmode`, `maxlength` and 44 px rows, and is not C1's file. The file is new and C1-only, so it cannot conflict.
2. `apply-draft.ts` also holds validation and the submit mapping (the contract lists only draft I/O); `api-apply.ts` also exports `firstActiveMarketId`.
3. The contract's "first active market from getConfig" is implemented as the first active market from the existing `GET /api/markets/public`,
   because `getConfig` needs a market id. A prefill token's `market_id` wins over `?market=`.
4. Product types with permit rule `none` get no `permits` entry; `optional` shows the three-way choice but does not require an answer.
5. The Hold Harmless and rules copy in section 4 (insurance sentence, five acknowledgements) follows the contract and the 2027 rules draft in the
   page code, not market data, as the contract specifies.
6. The old `api.submitApplication`, `Application` and `ApplicationInput` are untouched and now unused by `/apply`; the merger deletes them (checklist item 4).
