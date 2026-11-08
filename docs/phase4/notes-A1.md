# Phase 4 release notes - executor A1 (application, producers/memberships/fees, prefill invites, uploads, D29)

Branch `rework/p4-application`, from `f0ddd81`. `npm run typecheck` and `npm test` are green (41 files, 506 tests). Nothing here touches production; every service was exercised through `tests/helpers/fake-db.ts` and `tests/helpers/fake-storage.ts`.

## What was built

**Shared modules (byte-identical to the contract):** `src/services/seasons.ts` (sha256 `8593e84d...9fa8`, 275 lines) and `src/services/purpose-tokens.ts` (sha256 `552d512f...cc7a`, 165 lines). `src/types/schema.ts` carries the identical hunk (post-hunk sha256 `43dff1dc...d902` verified before adding the A1 block).

**Storage:** `src/services/storage-port.ts` (`StoragePort`, `firebaseStoragePort(env)` importing `firebase-admin/storage` lazily, so building the app does no I/O), `app.decorate('storage', ...)` in `buildApp({ storage })`, `tests/helpers/fake-storage.ts`.

**Markets (`src/services/markets.ts`, `src/routes/markets.ts`):** `season`, `fees`, `payment_links`, `legal`, `booth_map_url`, `categories`, `product_types` on `FarmersMarket`; zod `marketSeasonSchema`, `feesSchema`, `legalSchema`, `categorySchema`, `productTypeSchema` (all exported); `DEFAULT_FEES`, `DEFAULT_LEGAL`, `DEFAULT_CATEGORIES`, `DEFAULT_PRODUCT_TYPES` and the read helpers `marketFees/PaymentLinks/Legal/Categories/ProductTypes`, `applicationsOpen`. `PATCH /api/markets/:id` writes each as a whole top-level field and audits before/after subsets (legal bodies are recorded as lengths). Public `GET /api/markets/:id/rules`. Admin `POST /api/markets/:id/invite-reapply`.

**Application (`src/services/applications.ts`, `src/routes/applications.ts`):**
- Public: `GET /config`, `POST /uploads`, `POST /`, `GET /prefill/:token` with the rate limits of the contract.
- Admin: `GET /` (one DB equality filter: status, else market_id, else none), `GET /:id`, `GET /:id/uploads/:upload_id/url` (15-minute signed URL), `PATCH /:id` with `review | withdraw | note | fee | decline | approve`.
- `computeSeasonTotal`, `summarizeSeason` (the 2027 version gives 35 Saturdays, 2027-04-03 to 2027-11-27), `projectApplicationListItem` (also reads the Phase 2 document, `schema_version: 1`).
- Approve: producer by `prefill_producer_id` else by email (never by name); phone conflict and existing-membership refusals happen before any write; the membership is `create()`d at `p_m_<season>`; an agreement token (60 days) is minted; acceptance text keyed `acceptance:<application_id>` plus acceptance email; the 2026 row is never touched (test asserts byte equality).

**Uploads (`src/services/application-uploads.ts`):** 10 MB, pdf/jpeg/png/heic/heif, magic bytes checked against the declared type (415), 10 per draft (429), path `application-uploads/<yyyy>/<draft_id>/<id>.<ext>`, sha256, basename-only original name.

**Invites (`src/services/invites.ts`):** `inviteProducer` (atomic `application_invites` doc as the lock, new application token, email, text with dedupe key; `force` appends to `resends` and sends without a key), `inviteReapply` (bulk, with dry run), `TEMPLATES_A1.acceptance/application_invite`, `sendAcceptance`. Routes: `POST /api/producers/:id/invite`, `POST /api/markets/:id/invite-reapply`.

**Producers / memberships / dashboard:** producer profile fields (contract 2.3) on `upsertProducerByEmail` and `updateProducerSchema`; `createMembership` is the one per-season writer (`create()`, branch on `isAlreadyExists`); `GET /api/producers` filters by the market's current season, `GET /:id` lists every season plus `current_season_by_market` and (admin only) `invite`; `/api/memberships` gains season, the new fields and `POST /:id/items`; the dashboard card has `season` and counts current-season `active` memberships only.

**D29 (`src/services/inbound.ts`):** a number matching no producer is logged and gets nothing except STOP/START/HELP replies; `REPLIES.closed` is gone.

**Other:** `src/services/link-tokens.ts` purpose guard (a purpose token presented to `/api/checkin/` is 404, not 410); `scripts/backfill-membership-seasons.mjs`; SMS kinds `application_invite` and `acceptance`; collections `application_uploads` and `application_invites`.

## Deviations from the contract (and why)

1. **`tests/applications.test.ts` deleted.** It tested the Phase 2 page-1 application shape that this contract replaces; its upsert-by-email, phone-conflict, duplicate and terminal-status cases are re-covered in `tests/applications-v2.test.ts`.
2. **More Phase 3 test edits than the two named cases.** Besides the cases named in section 3.6, other cases in `tests/sms-webhook-auth.test.ts` used the unknown-number reply as the vehicle for their send path (shared-secret acceptance, real-provider path, send failure, flaky status update, the 24 h window). They now use HELP (still answered) or a known producer, and three assertions flipped to "logged, nothing sent". One assertion ("not re-sent within 24 h" after a flaky status update) was dropped because the reply it relied on no longer exists. Nothing else in those files changed.
3. **`tests/helpers/a1-fixtures.ts` added** (market with 2026 + 2027 versions, booths, valid submission, multipart builder) so the eight A1 route tests share one fixture. It is not on the contract's list but sits in A1's own test area.
4. **PATCH merge semantics.** `fees`, `payment_links` and `legal` accept a partial object and merge into the stored (or default) object; the whole object is written back. `season` replaces the stored object and `null` clears it. A full object from C2 behaves exactly as the contract describes.
5. **Stricter validation than the contract text:** link fields must be `http(s)` (no `javascript:` or `data:` URLs on public pages); `booth_map_url` is `/path` or `http(s)`; `seasonal_installments >= 1`; product `details` keys must match `^[a-z][a-z0-9_]{1,31}$` (they are the config's detail-field keys, and free-form keys could hit Firestore's reserved names); `product_types[].category_keys` must name existing categories; `season.schedule_version_id` must name a version of the market.
6. **Submission leniency kept on purpose:** required `details` fields (e.g. `usda_facility`) and practice keys are not validated server-side (not in the contract's validation list; the form enforces them). Permit entries for types the applicant did not select are dropped, not rejected. A repeat POST with the same `draft_id` and email returns the first submission's result (201, same id) instead of a 409.
7. **`GET /api/memberships`** defaults a market's list to its current season (`season=all` for everything) and returns `MembershipView` plus `producer`. **`GET /api/producers/:id`** returns `invite` only to admins: the link is a no-login key to the producer's prefilled data. Managers also no longer receive memberships of markets they cannot access.
8. **Acceptance email** is attempted when `FROM_EMAIL` is non-empty **or** `EMAIL_PROVIDER=console` (the contract says "when `FROM_EMAIL` is non-empty"; the console case lets dev/test runs print it). Invite emails are not gated on `FROM_EMAIL`, as the integrator's e2e expects an email print.
9. **Phase 2 application documents cannot be approved** through the new flow (409: ask the applicant to apply again); they can be declined or withdrawn. The one production document (page-1 fields) is in this state.
10. **Audit action names:** staff notes are logged as `application.transition` with `note: 'note'` (no new action name); the audit row holds the note length, never the text.
11. `createProducerSchema` accepts both fee-plan vocabularies and stores `seasonal | daily`; the dead Phase 2 `applicationSchema`/`ApplicationInput` in `producers.ts` was removed (nothing imports it).
12. `POST /api/producers` now creates its memberships at `<producer>_<market>_<season>` for the market's current season (D33), not the Phase 2 id.

## Could not verify

- Signed URLs and uploads against the real bucket (tests inject the fake; the real port is unit-tested against a mocked bucket only).
- Required-detail and practice-key validation by the form (C1 owns it).
- Behaviour on real Firestore of the `update()` calls with dotted `review.*` / `fee.*` paths on a document that lacks the parent map (Phase 4 documents always have both; the Phase 2 document does not and is never patched except `fee`/`note`).

## Owner actions (A1's share; the full list is contract section 6)

1. Backfill: `node scripts/backfill-membership-seasons.mjs --market wlrfm --season 2026 --dry-run` (expect `scanned 39 / would update 39 / already_set 0`), then `--write`. Readers default to 2026 either way.
2. **Signed URLs:** the admin upload viewer calls `getSignedUrl`, which signs with the functions runtime service account. If it fails with a `signBlob`/`iam.serviceAccounts.signBlob` error, grant that account `roles/iam.serviceAccountTokenCreator` on itself. For a 2nd-gen function with no custom account that is the Compute Engine default account, `<project-number>-compute@developer.gserviceaccount.com`; confirm with `gcloud functions describe api --gen2 --region us-central1 --format='value(serviceConfig.serviceAccountEmail)'`. Uploads themselves use the existing `STORAGE_BUCKET`.
3. Applications stay closed until `season.label` is set on the market (Admin -> Markets -> Season & fees). Setting it also switches the dashboard, check-in texts and booth drafts to 2027 memberships.
4. Editing the product types / practice checklists (they are market data). `PATCH /api/markets/wlrfm` with the **whole** `product_types` array (read it from `GET /api/applications/config?market=wlrfm`, change what you need, send it back), for example to add a practice:
   ```json
   { "product_types": [ { "key": "produce", "label": "Produce, herbs, plants and flowers", "category_keys": ["farmers_ranchers"], "examples": "...", "permit_rule": "...", "permit_upload": "none", "prohibited": "...", "practice_checklist": [ { "key": "certified_organic", "label": "Certified organic" }, { "key": "regenerative", "label": "Regenerative" } ], "details": [], "sort": 1 } ] }
   ```
   Keys are lower_snake (`^[a-z][a-z0-9_]{1,31}$`), unique, and every `category_keys` entry must exist in `categories`. Sending `categories` the same way replaces the four default categories.
5. Check the default texts before the first applicants: `DEFAULT_PRODUCT_TYPES` in `src/services/markets.ts` quotes the rules draft's permit wording verbatim; the SMS consent text and its version (`sjca-sms-1`) are in `DEFAULT_LEGAL` and are editable under `legal`.
