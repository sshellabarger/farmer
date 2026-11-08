# Phase 4 Contract — SJCA Market Manager (2027 producer application, booth map, booth assignment)

Four executors — **A1** (backend: application, producers/memberships/fees, prefill invites, public uploads, D29), **A2** (backend: booths, assignments, drafts/approve/booth texts through the engine, Hold Harmless e-sign, insurance tracking), **C1** (web public: application, rules, agreement, prefill), **C2** (web admin) — branch from `main` at **`f0ddd81`** and work in parallel without talking. Every rule exists so the four branches merge without conflicts and the merged tree passes `npm run typecheck`, `npm test`, `cd web && npx tsc --noEmit && npm run build`. Where this contract and SPEC.md / the Phase 2–3 contracts differ, this contract wins for Phase 4. Phase 2 contract §1.1 rules 1–7 and Phase 3 contract §1.1 rules apply unchanged (ownership, byte-identical shared modules, the fake-db Firestore envelope, conventions, no `.env*` / `service-account.json` / `.claude/` / survey TSV reads).

**Decisions in force.** D24–D31 (approved 2026-11-08) and **D32** (no cooperative / shared retail booths: no "another vendor brings my products" question, no applicant path without a booth of their own, the form states each vendor sells only what they grow, raise or produce, from their own booth) and **D33** (every producer re-applies each season; a membership belongs to ONE season; only the market's current season counts for texts, booths, dashboard; previous seasons stay visible as history).

**Deployed reality every executor designs around.** Production: `farmers_markets/wlrfm` (Saturdays 08:00–12:00 America/Chicago, one schedule version ending 2026-10-31, no `season`/`fees`/`legal` fields), 29 `market_dates` all `collecting`, 39 `producers` with `phone: null`, 39 `producer_memberships` with ids `<producer>_wlrfm`, `status: 'active'`, `fee_plan: 'weekly'|'season'|'both'`, **no `season` field**, 508 imported `checkins`, 1 Phase 2 application (page-1 fields), 0 `booths`. The Phase 3 engine runs every 5 minutes; `generateDrafts` is a no-op stub; `actions` already carries `drafts_generated_at / approved_at / booth_texts_sent_at`. The 2027 season (Apr 3 – Nov 27 2027, 35 Saturdays — verified) is DATA the admin adds as a schedule version (§6); nothing in code names it. Every reader of memberships goes through `src/services/seasons.ts`; the 39 Phase 2 docs read as season `'2026'` until `scripts/backfill-membership-seasons.mjs` writes the field. Nothing texts a producer without an E.164 phone, an `active` membership **in the current season**, and no `sms_opt_out_at`.

---

## 1. FILE OWNERSHIP MAP

### 1.1 Rules

1. Touch only the paths under your name. Creating a file another executor owns is a merge conflict.
2. **Shared byte-identical modules (three, §1.5):** `src/services/seasons.ts` and `src/services/purpose-tokens.ts` (A1 owns, A2 copies), `web/src/lib/phase4-types.ts` (C1 owns, C2 copies). Copy the fenced source exactly (ends with one `\n`, no formatter run); `shasum -a 256 <file>` must print the hash above the block.
3. **Identical hunks (two, §1.6):** `src/types/schema.ts` lines 28–29 (A1 and A2 apply the same replacement), `web/src/lib/api.ts` lines 38 and 62 (C1 and C2 add `export`). Post-hunk hashes are given; beyond the hunk, A1/A2 and C2 add at the anchors named in §1.2 only.
4. Nobody edits `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `docs/SPEC.md`, `docs/MONITORING.md`, `docs/phase2-contract.md`, `docs/phase3-contract.md`, `docs/2027-application-review.md`, `package.json`, `package-lock.json`, `web/package.json`, `web/package-lock.json` (**no new dependencies** — markdown is rendered by C1's `markdown-lite.ts`, uploads use the installed `@fastify/multipart`, Storage uses `firebase-admin`), `firebase.json`, `firestore.indexes.json` (stays `[]`: every new query is one equality filter), `.env.example` (no new env keys: `STORAGE_BUCKET`, `APP_URL`, `FROM_EMAIL` exist), `tests/helpers/fake-db.ts`, `tests/helpers/staff-auth.ts`, `tests/setup/test-mode.ts`, `vitest.config.ts`, `.github/**`, `src/services/sms.ts` except A1's §1.6 kind hunk, `src/services/open-checkin.ts`, `src/utils/**`, `src/middleware/**`. Each executor writes release notes to a NEW file `docs/phase4/notes-<A1|A2|C1|C2>.md` (what you built, what you could not verify, owner actions, deviations with reasons).
5. Firestore envelope: `doc().get/set/set(merge)/update/delete/create`, `where(field,'==',v)`, `limit`, `get`, `add`; dotted field paths in `update()`; no `orderBy`/`in`/`array-contains`/batch/transactions/`FieldValue`; never `undefined` in a write; never spread a normalised doc into `update()`. Every date field read through `toDate`/`toDateOrEpoch` (`src/utils/dates.ts`). Anything that must exist at most once is `create()`d and branched on `isAlreadyExists()`.
6. Conventions: ESM `.js` suffixes, zod at every route boundary (400 via `createErrorHandler` or `safeParse` + `issues[0].message`), `snake_case`, route plugins registered with a prefix only in `src/app.ts`, no hard-coded day/time/zone/quiet window/fee/season anywhere, `audit_log` for every staff write, ASCII-only text templates, no emoji anywhere (web included).
7. Every branch is green on its own: `npm run typecheck && npm test` (C1/C2 also `cd web && npx tsc --noEmit && npm run build`). No `@ts-ignore` scaffolds: A1's `app.ts` imports only A1's files; A2's imports only A2's; C1 and C2 import only their own files plus the shared types.
8. **Phase 3 suite untouched** except the two D29 cases named for A1. Tests that drive a route reading the real clock pin it with `vi.useFakeTimers({ toFake: ['Date'] })`.

### 1.2 Ownership

**A1 — application, producers/memberships/fees, prefill invites, public uploads, D29**
- Modifies: `src/app.ts` (§1.3: `BuildAppOptions.storage`, `app.decorate('storage', …)`, imports after line 30, registrations after line 104 — nothing else), `src/types/schema.ts` (§1.6 hunk + the A1 block inserted after line 14 `export type MarketDateStatus = …;` and its blank line), `src/types/fastify.d.ts` (add `storage: StoragePort;` to `FastifyInstance`), `src/db/firestore.ts` (insert after line 54 `applications: 'applications',`: `application_uploads` and `application_invites` lines, §1.4), `src/services/sms.ts` (§1.6 kind hunk only), `src/services/markets.ts` (§2.1 interfaces, zod, defaults), `src/services/producers.ts` (§2.3 zod; `export type { FeePlan } from './seasons.js'`; `upsertProducerByEmail` gains the §2.3 fields), `src/services/link-tokens.ts` (ONE change: in `resolveCheckinToken`, after the `exists` check, `if (data.purpose && data.purpose !== 'checkin') return { status: 'unknown' };` — a purpose token presented to `/api/checkin/` is 404, not 410), `src/services/inbound.ts` (D29 only, §3.6), `src/routes/applications.ts` (rewrite), `src/routes/producers.ts`, `src/routes/memberships.ts`, `src/routes/markets.ts` (public `GET /:id/rules`; PATCH handles the §2.1 fields), `src/routes/dashboard.ts` (current-season progress), `tests/sms-webhook-auth.test.ts` and `tests/inbound-checkin.test.ts` (ONLY the unknown-number cases, §5.1).
- Creates: `src/services/seasons.ts` (owner, §1.5), `src/services/purpose-tokens.ts` (owner, §1.5), `src/services/storage-port.ts`, `src/services/applications.ts` (zod, config, season total, projection), `src/services/application-uploads.ts`, `src/services/invites.ts` (invite-to-reapply + acceptance sends), `scripts/backfill-membership-seasons.mjs`, `tests/helpers/fake-storage.ts`, `tests/seasons.test.ts`, `tests/purpose-tokens.test.ts`, `tests/applications-v2.test.ts`, `tests/application-uploads.test.ts`, `tests/application-config.test.ts`, `tests/invites.test.ts`, `tests/memberships-seasons.test.ts`, `tests/producers-seasons.test.ts`, `tests/dashboard-seasons.test.ts`, `tests/inbound-d29.test.ts`, `docs/phase4/notes-A1.md`.

**A2 — booths, assignments, engine drafts/approve/booth texts, Hold Harmless e-sign, insurance tracking**
- Modifies: `src/app.ts` (imports inserted after line 10 `import { createErrorHandler } …;`, registrations inserted after line 107 `await app.register(dashboardRoutes, …);` — nothing else), `src/types/schema.ts` (§1.6 hunk + the A2 block appended at end of file), `src/db/firestore.ts` (insert after line 60 `workflow_locks: 'workflow_locks',`: `booths` and `booth_assignments` lines, §1.4), `src/services/market-dates.ts` (`MarketDateActions`/`MarketDateDoc` additions §2.9 and their parsing in `marketDateFromData`; no generator logic change), `src/services/checkin-workflow.ts` (§3.5: season-filtered `listRecipients`, `DEDUPE_KEYS.booth`, `TEMPLATES.booth`, drafts step, booth-texts step, `EngineResult` additions), `src/routes/market-dates.ts` (§3.4: status additions, membership lookup via `findMembership`, assignments routes), `src/functions.ts` (only the `processMarketDates` log line: append `drafts=${r.drafts_generated} booth_texts=${r.booth_texts_sent}`).
- Creates: `src/services/seasons.ts` (copy), `src/services/purpose-tokens.ts` (copy), `src/services/booths.ts`, `src/services/booth-assignments.ts`, `src/services/agreements.ts`, `src/routes/booths.ts`, `src/routes/agreements.ts`, `src/routes/insurance.ts`, `tests/booths.test.ts`, `tests/booth-assignments.test.ts`, `tests/assignments-routes.test.ts`, `tests/booth-texts.test.ts`, `tests/agreements.test.ts`, `tests/insurance.test.ts`, `tests/recipients-season.test.ts`, `docs/phase4/notes-A2.md`.

**C1 — web public (`web/src/**`, `web/public/**`)**
- Modifies: `web/src/lib/api.ts` (§1.6 hunk ONLY).
- Creates: `web/src/lib/phase4-types.ts` (owner, §1.5), `web/src/lib/api-apply.ts` (`applyApi`, §4.1), `web/src/lib/apply-draft.ts`, `web/src/lib/fees.ts`, `web/src/lib/markdown-lite.ts`, `web/src/components/apply/section-business.tsx`, `section-products.tsx`, `section-booth.tsx`, `section-agreements.tsx`, `section-review.tsx`, `upload-field.tsx`, `progress-nav.tsx`, `web/src/components/stall-picker.tsx`, `web/src/components/markdown.tsx`, `web/src/app/apply/page.tsx` (rewrite), `web/src/app/apply/layout.tsx`, `web/src/app/rules/page.tsx`, `web/src/app/rules/layout.tsx`, `web/src/app/agreement/page.tsx`, `web/src/app/agreement/layout.tsx` (noindex), `web/public/wlrfm-vendor-map.jpg` (byte copy of `docs/wlrfm-vendor-map.jpg`), `docs/phase4/notes-C1.md`.

**C2 — web admin (`web/src/**`)**
- Modifies: `web/src/lib/api.ts` (§1.6 hunk + helpers appended INSIDE the `api` object before its closing `};`, §4.2; never remove or rename an existing helper — `submitApplication` and the old `Application` type stay until the merger deletes them), `web/src/lib/types.ts` (§4.2 additions; `FeePlan` becomes `'seasonal' | 'daily'`), `web/src/components/status-chip.tsx` (new colours §4.2), `web/src/app/admin/applications/page.tsx` (rewrite: queue), `web/src/app/admin/markets/detail/page.tsx` (three new sections), `web/src/app/admin/market-dates/page.tsx` (Assignments panel), `web/src/app/admin/producers/detail/page.tsx`, `web/src/app/admin/page.tsx` (season label on each card — one line).
- Creates: `web/src/lib/phase4-types.ts` (copy), `web/src/components/booth-grid.tsx`, `web/src/components/application-view.tsx`, `web/src/app/admin/applications/detail/page.tsx` (`?id=`; no `[param]` folders), `docs/phase4/notes-C2.md`.

### 1.3 `src/app.ts` — final registration block (A1 owns the file; A2 has two insertion hunks)

```ts
// line 10 (unchanged):  import { createErrorHandler } from './utils/http-error-handler.js';
import { boothRoutes } from './routes/booths.js';                       // A2 (inserted after line 10)
import { agreementRoutes } from './routes/agreements.js';               // A2
import { insuranceRoutes } from './routes/insurance.js';                // A2
// … lines 11–30 unchanged …
// line 30 (unchanged):  import { marketDateRoutes } from './routes/market-dates.js';
import type { StoragePort } from './services/storage-port.js';          // A1 (inserted after line 30)
import { firebaseStoragePort } from './services/storage-port.js';       // A1

export interface BuildAppOptions {
  db: Firestore;
  env: Env;
  logLevel?: string;
  notifyOnError?: boolean;
  /** A1: object storage for application uploads. Defaults to Firebase Storage; tests pass `fakeStorage()`. */
  storage?: StoragePort;
}
// in buildApp(): `{ db, env, logLevel = 'info', notifyOnError = true, storage }`; after `app.decorate('env', env);` (line 68):
  app.decorate('storage', storage ?? firebaseStoragePort(env));         // A1

// … registrations lines 86–104 unchanged …
  await app.register(marketDateRoutes, { prefix: '/api/market-dates' });           // line 104, unchanged
  // A1 — nothing new: applicationRoutes (line 100) now also serves /config, /uploads, /prefill, /invite…;
  //      marketRoutes (line 97) serves /:id/rules; producerRoutes / membershipRoutes gain routes in place.
  await app.register(adminUserRoutes, { prefix: '/api/admin/users' });              // 105
  await app.register(auditLogRoutes, { prefix: '/api/audit-log' });                 // 106
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });                // 107, unchanged
  await app.register(boothRoutes, { prefix: '/api/markets' });                      // A2 (inserted after line 107): /:id/booths…
  await app.register(agreementRoutes, { prefix: '/api/agreements' });               // A2
  await app.register(insuranceRoutes, { prefix: '/api/memberships' });              // A2: /:id/insurance, /:id/agreement-link
```
Two plugins may share a prefix; routes must not collide (A2's `/:id/booths*` and `/:id/insurance` never match A1's paths). `src/functions.ts` passes no `storage` (the default is the real bucket).

### 1.4 `src/db/firestore.ts` collections lines and `src/types/schema.ts` blocks

A1 inserts after line 54:
```ts
  // Phase 4 (A1). Doc id = uuid. Metadata of a public application upload; the bytes live in Storage at `storage_path`.
  application_uploads: 'application_uploads',
  // Phase 4 (A1). Doc id = `${market_id}_${season}_${producer_id}`; created atomically — the invite-to-reapply lock.
  application_invites: 'application_invites',
```
A2 inserts after line 60:
```ts
  // Phase 4 (A2). Doc id = `${market_id}_<label slug>`; created atomically so a label is unique per market.
  booths: 'booths',
  // Phase 4 (A2). Doc id = uuid; append-only (superseded_by), keyed by the TARGET market date.
  booth_assignments: 'booth_assignments',
```
A1's schema.ts block (after line 14 + blank line, followed by a blank line):
```ts
// Phase 4 (contract §2): the 2027 application.
export type ApplicationStatus = 'new' | 'under_review' | 'approved' | 'declined' | 'withdrawn';
export type ApplicationFeeStatus = 'unpaid' | 'paid' | 'waived';
export type PermitStatus = 'uploaded' | 'will_provide' | 'not_required' | 'food_freedom';
export type InsuranceAnswer = 'have' | 'none' | 'need_guidance';
export type UploadKind = 'permit' | 'insurance' | 'logo';
```
A2's schema.ts block (end of file, preceded by a blank line):
```ts
// Phase 4 (contract §2.7–2.8): booths and assignments.
export type BoothKind = 'stall' | 'food_truck';
export type AssignmentSource = 'usual' | 'suggested' | 'manual';
export type DraftSkipReason = 'no_next_date' | 'no_booths' | 'no_attendees';
```

### 1.5 Shared modules (complete sources; copy verbatim)

All three typecheck against the repo's `tsconfig.json` (strict, ES2022, bundler) and were exercised against `tests/helpers/fake-db.ts` (Timestamps on read): season inference, legacy normalisation, `findMembership`, token lifecycle, and that `findOpenCheckin` ignores purpose tokens.

**`src/services/seasons.ts`** — A1 owns, A2 copies. sha256 `8593e84db2b4c13d3f0cd88fb021f66f9b9feebd67cf8797e771be66e82f9fa8`, 275 lines.

```ts
import type { Firestore } from 'firebase-admin/firestore';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { utcToLocalDate } from '../utils/tz.js';
import type { MembershipStatus } from './producers.js';

/**
 * Per-season memberships (Phase 4 contract §2.6, decision D33: every producer
 * re-applies each season, so a membership belongs to exactly one season) and
 * the one place that answers "which season is this market in right now?".
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte. Do not reformat or extend it here — put extensions in your
 * own module and import from this one.
 *
 * Firestore access stays inside the fake-db envelope (one equality filter per
 * query, everything else in memory) and every date field is read through
 * `toDate` — Firestore hands back Timestamps, never Dates.
 */

/**
 * The season every membership written before Phase 4 belongs to. The 39
 * production docs (the 2026 WLRFM survey import and its Phase 2 approvals)
 * carry no `season` field; `scripts/backfill-membership-seasons.mjs` adds it
 * once, and until then — or for any doc the backfill missed — a missing field
 * reads as this. A fact about the deployed data, not a schedule rule.
 */
export const LEGACY_MEMBERSHIP_SEASON = '2026';

/** '2027', or a qualified label such as '2027-winter'. */
export const SEASON_LABEL_RE = /^\d{4}(-[a-z0-9]{1,16})?$/;

/** Phase 4 fee vocabulary (D31). Phase 2 values map on read: weekly → daily, season → seasonal, both → seasonal. */
export type FeePlan = 'seasonal' | 'daily';
export type BoothKind = 'stall' | 'food_truck';
export type InsuranceStatus = 'missing' | 'on_file' | 'expired' | 'waived';
export type ItemRequestStatus = 'pending' | 'approved' | 'declined';

export interface MembershipInsurance {
  status: InsuranceStatus;
  expires_at: Date | null;
  upload_id: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  note: string;
}

export interface HoldHarmless {
  signed_at: Date;
  name: string;
  ip: string;
  version: string;
  token: string;
}

export interface ItemRequest {
  id: string;
  items: string[];
  note: string;
  requested_at: Date;
  source: 'application' | 'admin' | 'producer';
  status: ItemRequestStatus;
  decided_by: string | null;
  decided_at: Date | null;
}

/** A `producer_memberships` document as every Phase 4 reader sees it (Phase 2 docs normalised). */
export interface MembershipView {
  id: string;
  producer_id: string;
  market_id: string;
  season: string;
  status: MembershipStatus;
  fee_plan: FeePlan;
  /** The stored value before `normalizeFeePlan` ('weekly' | 'season' | 'both' on Phase 2 docs). */
  fee_plan_raw: string;
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  booth_kind: BoothKind;
  usual_booth_id: string | null;
  trial_period: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  insurance: MembershipInsurance;
  hold_harmless: HoldHarmless | null;
  approved_items: string[];
  item_requests: ItemRequest[];
  application_id: string | null;
  history: unknown[];
  source: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * What `currentSeason` needs from a market document. Structural on purpose: a
 * `FarmersMarket` passes with or without the Phase 4 `season` field, so the
 * helper compiles on every branch.
 */
export interface SeasonSource {
  timezone: string;
  schedule?: { versions?: { effective_from: string; season_start: string }[] | null } | null;
  season?: { label?: string | null } | null;
}

/**
 * The season a market would be in with no explicit label: the year of
 * `season_start` of the latest schedule version whose `effective_from` is on
 * or before today (market-local), else of the earliest version;
 * LEGACY_MEMBERSHIP_SEASON for a market with no versions at all (test
 * fixtures). For production WLRFM today that is '2026' and stays '2026' after
 * the 2027 version is added with a 2027 `effective_from`.
 */
export function inferSeasonLabel(market: SeasonSource, now: Date): string {
  const versions = market.schedule?.versions ?? [];
  if (versions.length === 0) return LEGACY_MEMBERSHIP_SEASON;
  const today = utcToLocalDate(now, market.timezone || 'UTC');
  const sorted = [...versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let applicable = sorted[0]!;
  for (const v of sorted) if (v.effective_from <= today) applicable = v;
  return applicable.season_start.slice(0, 4);
}

/** The market's current season: `season.label` when it is set and well-formed, else `inferSeasonLabel`. */
export function currentSeason(market: SeasonSource, now: Date): string {
  const label = market.season?.label;
  if (typeof label === 'string' && SEASON_LABEL_RE.test(label)) return label;
  return inferSeasonLabel(market, now);
}

/** The season a stored membership belongs to; a missing or malformed field reads as the legacy season. */
export function membershipSeason(data: Record<string, unknown>): string {
  const s = data.season;
  return typeof s === 'string' && SEASON_LABEL_RE.test(s) ? s : LEGACY_MEMBERSHIP_SEASON;
}

/** Doc id of a Phase 4 membership. Phase 2 docs keep their `${producer_id}_${market_id}` ids; never derive an id to read by — query and filter. */
export function membershipDocId(producerId: string, marketId: string, season: string): string {
  return `${producerId}_${marketId}_${season}`;
}

export function normalizeFeePlan(raw: unknown): FeePlan {
  switch (raw) {
    case 'seasonal':
    case 'season':
    case 'both':
      return 'seasonal';
    default:
      return 'daily';
  }
}

function insuranceFromData(raw: unknown): MembershipInsurance {
  const i = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = i.status;
  return {
    status: status === 'on_file' || status === 'expired' || status === 'waived' ? status : 'missing',
    expires_at: toDate(i.expires_at),
    upload_id: typeof i.upload_id === 'string' ? i.upload_id : null,
    verified_by: typeof i.verified_by === 'string' ? i.verified_by : null,
    verified_at: toDate(i.verified_at),
    note: typeof i.note === 'string' ? i.note : '',
  };
}

function holdHarmlessFromData(raw: unknown): HoldHarmless | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  const signedAt = toDate(h.signed_at);
  if (!signedAt) return null;
  return {
    signed_at: signedAt,
    name: typeof h.name === 'string' ? h.name : '',
    ip: typeof h.ip === 'string' ? h.ip : '',
    version: typeof h.version === 'string' ? h.version : '',
    token: typeof h.token === 'string' ? h.token : '',
  };
}

function itemRequestsFromData(raw: unknown): ItemRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const status = r.status;
    const source = r.source;
    return {
      id: typeof r.id === 'string' ? r.id : String(index),
      items: Array.isArray(r.items) ? r.items.map(String) : [],
      note: typeof r.note === 'string' ? r.note : '',
      requested_at: toDateOrEpoch(r.requested_at),
      source: source === 'admin' || source === 'producer' ? source : 'application',
      status: status === 'approved' || status === 'declined' ? status : 'pending',
      decided_by: typeof r.decided_by === 'string' ? r.decided_by : null,
      decided_at: toDate(r.decided_at),
    };
  });
}

/** Normalise a stored membership. Tolerates every Phase 2 doc (no season, old fee_plan, no Phase 4 fields). */
export function membershipFromData(id: string, data: Record<string, unknown>): MembershipView {
  const feePlanRaw = typeof data.fee_plan === 'string' ? data.fee_plan : 'weekly';
  return {
    id,
    producer_id: String(data.producer_id ?? ''),
    market_id: String(data.market_id ?? ''),
    season: membershipSeason(data),
    status: (typeof data.status === 'string' ? data.status : 'inactive') as MembershipStatus,
    fee_plan: normalizeFeePlan(feePlanRaw),
    fee_plan_raw: feePlanRaw,
    spaces: data.spaces === 2 ? 2 : 1,
    electric: data.electric === true,
    pay_in_full: data.pay_in_full === true,
    booth_kind: data.booth_kind === 'food_truck' ? 'food_truck' : 'stall',
    usual_booth_id: typeof data.usual_booth_id === 'string' && data.usual_booth_id ? data.usual_booth_id : null,
    trial_period: data.trial_period === true,
    approved_at: toDate(data.approved_at),
    approved_by: typeof data.approved_by === 'string' ? data.approved_by : null,
    insurance: insuranceFromData(data.insurance),
    hold_harmless: holdHarmlessFromData(data.hold_harmless),
    approved_items: Array.isArray(data.approved_items) ? data.approved_items.map(String) : [],
    item_requests: itemRequestsFromData(data.item_requests),
    application_id: typeof data.application_id === 'string' ? data.application_id : null,
    history: Array.isArray(data.history) ? data.history : [],
    source: typeof data.source === 'string' ? data.source : 'admin',
    created_at: toDateOrEpoch(data.created_at),
    updated_at: toDateOrEpoch(data.updated_at),
  };
}

/** Insurance as it stands at `now`: an `on_file` certificate past its expiry reads as `expired`. */
export function insuranceStatusAt(insurance: MembershipInsurance, now: Date): InsuranceStatus {
  if (insurance.status === 'on_file' && insurance.expires_at && insurance.expires_at.getTime() <= now.getTime()) return 'expired';
  return insurance.status;
}

/** Every membership at a market, any season. One equality filter. */
export async function listMembershipsForMarket(db: Firestore, marketId: string): Promise<MembershipView[]> {
  const snap = await db.collection('producer_memberships').where('market_id', '==', marketId).get();
  return snap.docs.map((d) => membershipFromData(d.id, d.data() as Record<string, unknown>));
}

/** Every membership of a producer, any market, any season. One equality filter. */
export async function listMembershipsForProducer(db: Firestore, producerId: string): Promise<MembershipView[]> {
  const snap = await db.collection('producer_memberships').where('producer_id', '==', producerId).get();
  return snap.docs.map((d) => membershipFromData(d.id, d.data() as Record<string, unknown>));
}

export function ofSeason<T extends { season: string }>(memberships: T[], season: string): T[] {
  return memberships.filter((m) => m.season === season);
}

/** "The vendors of this market": the memberships of the market's current season (any status), plus the season they belong to. */
export async function listCurrentMemberships(
  db: Firestore,
  market: SeasonSource & { id: string },
  now: Date,
): Promise<{ season: string; memberships: MembershipView[] }> {
  const season = currentSeason(market, now);
  const all = await listMembershipsForMarket(db, market.id);
  return { season, memberships: ofSeason(all, season) };
}

/** The one membership of a producer at a market for a season, or null. Query by producer, filter in memory. */
export async function findMembership(db: Firestore, producerId: string, marketId: string, season: string): Promise<MembershipView | null> {
  const all = await listMembershipsForProducer(db, producerId);
  const matches = all.filter((m) => m.market_id === marketId && m.season === season);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return matches[0]!;
}

/** A vendor in the rotation: receives check-in texts and is drafted into booths. */
export function isVendorOfRecord(m: Pick<MembershipView, 'status'>): boolean {
  return m.status === 'active';
}
```

**`src/services/purpose-tokens.ts`** — A1 owns, A2 copies. sha256 `552d512f7059c104115422531886dd773de677735877423ad12c58837f49cc7a`, 165 lines.

```ts
import type { Firestore } from 'firebase-admin/firestore';
import { toDate, toDateOrEpoch } from '../utils/dates.js';
import { generateToken, TOKEN_RE } from './link-tokens.js';

/**
 * No-login links for the two Phase 4 purposes (contract §2.11): the
 * returning-vendor application prefill ('application', D30) and the Hold
 * Harmless e-sign ('agreement'). Same `link_tokens` collection and 43-char
 * token as the Phase 3 check-in links; `findOpenCheckin` ignores these rows
 * because it filters on `purpose === 'checkin'`, and `resolveCheckinToken`
 * answers 'unknown' for them. Never mints a JWT.
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte. Do not reformat or extend it here.
 */

export type PurposeTokenPurpose = 'application' | 'agreement';

/** A prefill link may be reopened and resubmitted; POST /api/applications counts a use. */
export const APPLICATION_TOKEN_MAX_USES = 25;
/** Signing is a single act; after it the link shows the signed confirmation, not the form. */
export const AGREEMENT_TOKEN_MAX_USES = 1;

export const APPLICATION_PATH = '/apply';
export const AGREEMENT_PATH = '/agreement';

/** `${APP_URL}/apply?t=<token>` or `${APP_URL}/agreement?t=<token>`. */
export function purposeTokenUrl(appUrl: string, purpose: PurposeTokenPurpose, token: string): string {
  const path = purpose === 'application' ? APPLICATION_PATH : AGREEMENT_PATH;
  return `${appUrl.replace(/\/+$/, '')}${path}?t=${encodeURIComponent(token)}`;
}

export interface PurposeTokenDoc {
  /** Equals the doc id. */
  token: string;
  purpose: PurposeTokenPurpose;
  producer_id: string;
  market_id: string;
  season: string;
  /** The membership the agreement belongs to; null for an application token. */
  membership_id: string | null;
  /** Set on an application token once a submission used it. */
  application_id: string | null;
  expires_at: Date;
  used_at: Date | null;
  uses: number;
  max_uses: number;
  created_at: Date;
  /** The staff user id that minted it, or 'approve' / 'invite' for the routes that mint on the producer's behalf. */
  created_by: string;
  /** The `messages` row id of the text that carried it (null when no text was sent). */
  sent_message_id: string | null;
  email_sent_at: Date | null;
}

export function purposeTokenFromData(id: string, data: Record<string, unknown>): PurposeTokenDoc {
  return {
    token: id,
    purpose: data.purpose === 'agreement' ? 'agreement' : 'application',
    producer_id: String(data.producer_id ?? ''),
    market_id: String(data.market_id ?? ''),
    season: String(data.season ?? ''),
    membership_id: typeof data.membership_id === 'string' ? data.membership_id : null,
    application_id: typeof data.application_id === 'string' ? data.application_id : null,
    expires_at: toDateOrEpoch(data.expires_at),
    used_at: toDate(data.used_at),
    uses: typeof data.uses === 'number' ? data.uses : 0,
    max_uses: typeof data.max_uses === 'number' ? data.max_uses : 1,
    created_at: toDateOrEpoch(data.created_at),
    created_by: String(data.created_by ?? ''),
    sent_message_id: typeof data.sent_message_id === 'string' ? data.sent_message_id : null,
    email_sent_at: toDate(data.email_sent_at),
  };
}

export interface MintPurposeTokenArgs {
  purpose: PurposeTokenPurpose;
  producer_id: string;
  market_id: string;
  season: string;
  membership_id?: string | null;
  application_id?: string | null;
  expires_at: Date;
  now: Date;
  created_by: string;
}

/** Mints and writes a fresh token. Never invalidates an older one — an earlier email or text keeps working until it expires. */
export async function mintPurposeToken(db: Firestore, args: MintPurposeTokenArgs): Promise<PurposeTokenDoc> {
  const token = generateToken();
  const doc: PurposeTokenDoc = {
    token,
    purpose: args.purpose,
    producer_id: args.producer_id,
    market_id: args.market_id,
    season: args.season,
    membership_id: args.membership_id ?? null,
    application_id: args.application_id ?? null,
    expires_at: args.expires_at,
    used_at: null,
    uses: 0,
    max_uses: args.purpose === 'agreement' ? AGREEMENT_TOKEN_MAX_USES : APPLICATION_TOKEN_MAX_USES,
    created_at: args.now,
    created_by: args.created_by,
    sent_message_id: null,
    email_sent_at: null,
  };
  await db.collection('link_tokens').doc(token).set(doc as unknown as Record<string, unknown>);
  return doc;
}

export type ResolvedPurposeToken =
  | { status: 'unknown' }
  | { status: 'expired'; reason: 'expired' | 'wrong_purpose'; token: PurposeTokenDoc }
  /** `uses >= max_uses`: the act was completed (an agreement was signed); callers show the completed state, not an error. */
  | { status: 'used'; token: PurposeTokenDoc }
  | { status: 'ok'; token: PurposeTokenDoc };

/** Look a token up for one purpose. Regex failure, a missing doc or a checkin token → 'unknown'. */
export async function resolvePurposeToken(db: Firestore, token: string, purpose: PurposeTokenPurpose, now: Date): Promise<ResolvedPurposeToken> {
  if (!TOKEN_RE.test(token)) return { status: 'unknown' };
  const doc = await db.collection('link_tokens').doc(token).get();
  if (!doc.exists) return { status: 'unknown' };
  const data = doc.data() as Record<string, unknown>;
  if (data.purpose !== 'application' && data.purpose !== 'agreement') return { status: 'unknown' };
  const t = purposeTokenFromData(doc.id, data);
  if (t.purpose !== purpose) return { status: 'expired', reason: 'wrong_purpose', token: t };
  if (t.expires_at.getTime() <= now.getTime()) return { status: 'expired', reason: 'expired', token: t };
  if (t.uses >= t.max_uses) return { status: 'used', token: t };
  return { status: 'ok', token: t };
}

/**
 * Records a completed act: `uses + 1`, `used_at: now`, and the application
 * id when given. Read-modify-write on purpose (same reasoning as Phase 3's
 * `markTokenUsed`): the counter is advisory; the act it records is made
 * at-most-once by its own write (an application `create()`, a `hold_harmless`
 * field written only when null), never by this counter.
 */
export async function markPurposeTokenUsed(db: Firestore, token: string, now: Date, opts: { application_id?: string } = {}): Promise<void> {
  const ref = db.collection('link_tokens').doc(token);
  const doc = await ref.get();
  if (!doc.exists) return;
  const t = purposeTokenFromData(doc.id, doc.data() as Record<string, unknown>);
  const update: Record<string, unknown> = { uses: t.uses + 1, used_at: now };
  if (opts.application_id) update.application_id = opts.application_id;
  await ref.update(update);
}

/** A producer's tokens of one purpose, newest first; optionally one market / season. One equality filter (`producer_id`). */
export async function purposeTokensFor(
  db: Firestore,
  producerId: string,
  purpose: PurposeTokenPurpose,
  filter: { market_id?: string; season?: string } = {},
): Promise<PurposeTokenDoc[]> {
  const snap = await db.collection('link_tokens').where('producer_id', '==', producerId).get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .filter(({ data }) => data.purpose === purpose)
    .map(({ id, data }) => purposeTokenFromData(id, data))
    .filter((t) => (filter.market_id ? t.market_id === filter.market_id : true))
    .filter((t) => (filter.season ? t.season === filter.season : true))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
```

**`web/src/lib/phase4-types.ts`** — C1 owns, C2 copies. sha256 `d1ef5438c77889cc7a69c94446778ada45ecc1289d017bcf3b28ce6877f4f44e`, 427 lines. Typechecks under `--strict --isolatedModules`. It is the web mirror of §2; every API shape in §3 names its interfaces.

```ts
/**
 * Phase 4 shapes that cross the API (contract §2, §3): the public application
 * config and submission, uploads, prefill, the rules and agreement pages, the
 * stored application document, booths and assignments. Timestamps arrive as
 * ISO strings (the API's preSerialization hook converts them).
 *
 * SHARED VERBATIM: executor C1 owns this file; executor C2 copies it
 * byte-for-byte. Do not reformat or extend it here — Phase 4 additions to the
 * existing Phase 2/3 interfaces (Market, Membership, MarketDateStatusView)
 * live in `types.ts`, which C2 owns.
 */

/* ── Market configuration (farmers_markets additions) ── */

export interface MarketSeason {
  label: string;
  application_open: string | null; // YYYY-MM-DD, market-local
  application_close: string | null;
  schedule_version_id: string | null;
}

export interface MarketFees {
  application_fee: number;
  seasonal_total: number;
  seasonal_paid_in_full: number;
  seasonal_installments: number;
  daily: number;
  electric_seasonal: number;
  electric_daily: number;
  currency: string;
}

export interface MarketPaymentLinks {
  /** May contain `{email}`, which the server replaces with the applicant's encoded email. */
  application_fee_url: string | null;
  booth_fee_url: string | null;
}

export interface MarketLegal {
  rules_markdown: string;
  rules_version: string;
  rules_url: string | null;
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  insurance_help_url: string | null;
  adh_guidelines_url: string | null;
  food_freedom_url: string | null;
  sms_consent_text: string;
  sms_consent_version: string;
}

export interface MarketCategory {
  key: string;
  label: string;
  description: string;
  events_only: boolean;
  sort: number;
}

export interface PracticeOption {
  key: string;
  label: string;
}

export type PermitUploadRule = 'none' | 'optional' | 'required' | 'required_unless_food_freedom';

export interface ProductDetailField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required: boolean;
  hint: string;
}

export interface ProductTypeConfig {
  key: string;
  label: string;
  /** Which of the four categories this type may be listed under. */
  category_keys: string[];
  examples: string;
  /** The §7 permit rule shown inline, plain text. */
  permit_rule: string;
  permit_upload: PermitUploadRule;
  /** Prohibited items shown under the type, plain text ('' when none). */
  prohibited: string;
  practice_checklist: PracticeOption[];
  details: ProductDetailField[];
  sort: number;
}

export type BoothKind = 'stall' | 'food_truck';

/** A booth as the public application sees it. */
export interface StallPublic {
  id: string;
  label: string;
  row: string;
  order: number;
  kind: BoothKind;
  power: boolean;
  size: string;
  /** A current-season vendor already names it as their usual booth. */
  usually_taken: boolean;
}

export interface OptionItem {
  key: string;
  label: string;
}

export interface SeasonSummary {
  start: string | null;
  end: string | null;
  market_count: number;
  days_of_week: string[];
  start_time: string | null;
  end_time: string | null;
}

/** GET /api/applications/config?market= */
export interface ApplicationConfig {
  market: { id: string; name: string; location_name: string; location_address: string; timezone: string; booth_map_url: string | null };
  season: MarketSeason & SeasonSummary & { open_now: boolean };
  fees: MarketFees;
  payment_links: MarketPaymentLinks;
  legal: Omit<MarketLegal, 'rules_markdown' | 'hold_harmless_markdown'> & { has_rules_text: boolean };
  categories: MarketCategory[];
  product_types: ProductTypeConfig[];
  stalls: StallPublic[];
  payment_methods: OptionItem[];
  frequencies: OptionItem[];
  months: OptionItem[];
  agricultural_practices: OptionItem[];
  limits: { upload_max_bytes: number; upload_mimes: string[]; stall_preference_max: number };
}

/* ── Submission ── */

export type AgriculturalPractice = 'certified_organic' | 'certified_naturally_grown' | 'no_chemicals' | 'conventional' | 'not_applicable';
export type DailyFrequency = 'every_other_week' | 'monthly' | 'occasional';
export type PermitStatus = 'uploaded' | 'will_provide' | 'not_required' | 'food_freedom';
export type InsuranceAnswer = 'have' | 'none' | 'need_guidance';
export type BoothRate = 'seasonal' | 'daily';

export interface ApplicationAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface ApplicationContact {
  name: string;
  business_name: string;
  email: string;
  mobile: string;
  website: string;
  social: string;
  address: ApplicationAddress;
  description: string;
  years_in_operation: number | null;
  outlets: string;
  agricultural_practices: AgriculturalPractice;
  additional_info: string;
}

export interface ProductEntry {
  type: string;
  items: string[];
  practices: string[];
  description: string;
  details: Record<string, string | number | boolean>;
}

export interface PermitEntry {
  status: PermitStatus;
  upload_id: string | null;
  note: string;
}

export interface BoothRequest {
  rate: BoothRate;
  frequency: DailyFrequency | null;
  months: string[];
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  stall_preference: string[];
  food_truck: boolean;
}

export interface InsuranceAnswerInput {
  status: InsuranceAnswer;
  certificate_upload_id: string | null;
  carrier: string;
  expires_on: string | null; // YYYY-MM-DD
}

export interface AcknowledgementsInput {
  rules: boolean;
  weekly_report: boolean;
  farm_visits: boolean;
  marketing: boolean;
  products_listed_only: boolean;
  own_booth_only: boolean;
}

/** POST /api/applications body. */
export interface ApplicationSubmitInput {
  market_id: string;
  draft_id: string;
  prefill_token: string | null;
  contact: ApplicationContact;
  sms_consent: boolean;
  sms_consent_version: string;
  returning: { is_returning: boolean; last_stall: string | null };
  categories: string[];
  products: ProductEntry[];
  permits: Record<string, PermitEntry>;
  booth: BoothRequest;
  payment_methods: string[];
  insurance: InsuranceAnswerInput;
  acknowledgements: AcknowledgementsInput;
  rules_version: string;
  signature_name: string;
}

export interface SeasonTotal {
  rate: BoothRate;
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  market_count: number;
  booth_fee: number;
  electric_fee: number;
  total: number;
  basis: 'season' | 'per_market';
  installments: number;
  application_fee: number;
  currency: string;
}

export interface ApplicationSubmitResult {
  id: string;
  status: 'new';
  fee: { amount: number; currency: string; url: string | null };
  season_total: SeasonTotal;
}

/** POST /api/applications/uploads result. */
export interface UploadResult {
  upload_id: string;
  kind: 'permit' | 'insurance' | 'logo';
  bytes: number;
  mime: string;
  original_name: string;
}

/** GET /api/applications/prefill/:token */
export interface PrefillView {
  market_id: string;
  season: string;
  expires_at: string;
  producer: {
    business_name: string;
    contact_name: string;
    email: string | null;
    phone: string | null;
    website: string;
    social: string;
    address: ApplicationAddress | null;
    description_public: string;
    years_in_operation: number | null;
    outlets: string;
    agricultural_practices: AgriculturalPractice | null;
    categories: string[];
    products: ProductEntry[];
    payment_methods: string[];
  };
  last_membership: {
    season: string;
    fee_plan: BoothRate;
    spaces: 1 | 2;
    electric: boolean;
    pay_in_full: boolean;
    usual_booth_label: string | null;
  } | null;
}

/** GET /api/markets/:id/rules */
export interface RulesView {
  market_id: string;
  market_name: string;
  season: string;
  rules_version: string;
  rules_markdown: string;
  rules_url: string | null;
  updated_at: string;
}

/** GET /api/agreements/:token */
export interface AgreementView {
  status: 'open' | 'signed' | 'expired';
  market_name: string;
  season: string;
  business_name: string;
  contact_name: string;
  hold_harmless_markdown: string;
  hold_harmless_version: string;
  insurance_help_url: string | null;
  signed: { name: string; signed_at: string } | null;
  expires_at: string;
}

export interface AgreementSignInput {
  signature_name: string;
  agree: boolean;
}

/* ── Stored application (admin) ── */

export type ApplicationStatus4 = 'new' | 'under_review' | 'approved' | 'declined' | 'withdrawn';
export type FeeStatus = 'unpaid' | 'paid' | 'waived';

export interface ApplicationDoc {
  id: string;
  market_id: string;
  season: string;
  status: ApplicationStatus4;
  draft_id: string;
  prefill_token: string | null;
  prefill_producer_id: string | null;
  contact: ApplicationContact;
  sms_consent: { status: 'opted_in'; at: string; text_version: string; ip?: string };
  returning: { is_returning: boolean; last_stall: string | null };
  categories: string[];
  products: (ProductEntry & { category: string })[];
  permits: Record<string, PermitEntry>;
  booth: BoothRequest;
  season_total: SeasonTotal;
  payment_methods: string[];
  insurance: InsuranceAnswerInput;
  acknowledgements: {
    rules: { version: string; at: string };
    weekly_report: boolean;
    farm_visits: boolean;
    marketing: boolean;
    products_listed_only: boolean;
    own_booth_only: boolean;
  };
  signature: { name: string; signed_at: string; ip?: string };
  fee: { status: FeeStatus; amount: number; currency: string; paid_at: string | null; marked_by: string | null; reference: string | null };
  review: { notes: string; trial_period: boolean; decline_reason: string | null; reviewed_by: string | null; reviewed_at: string | null };
  producer_id: string | null;
  membership_id: string | null;
  upload_ids: string[];
  submitted_at: string;
  source: 'web';
  created_at: string;
  updated_at: string;
}

/** A row of GET /api/applications (the queue). */
export interface ApplicationListItem {
  id: string;
  market_id: string;
  season: string;
  status: ApplicationStatus4;
  business_name: string;
  contact_name: string;
  email: string;
  mobile: string;
  categories: string[];
  product_types: string[];
  rate: BoothRate;
  spaces: 1 | 2;
  electric: boolean;
  is_returning: boolean;
  fee_status: FeeStatus;
  insurance_status: InsuranceAnswer;
  permits_pending: number;
  submitted_at: string;
  producer_id: string | null;
}

export interface UploadMeta {
  id: string;
  kind: 'permit' | 'insurance' | 'logo';
  mime: string;
  bytes: number;
  original_name: string;
  uploaded_at: string;
  application_id: string | null;
}

/* ── Booths and assignments ── */

export interface BoothDoc {
  id: string;
  market_id: string;
  label: string;
  row: string;
  order: number;
  kind: BoothKind;
  power: boolean;
  size: string;
  notes: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type AssignmentSource = 'usual' | 'suggested' | 'manual';

export interface BoothAssignmentDoc {
  id: string;
  market_id: string;
  market_date_id: string;
  source_date_id: string;
  booth_id: string;
  producer_id: string;
  source: AssignmentSource;
  assigned_by: string;
  assigned_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
}
```

### 1.6 Identical hunks

**`src/types/schema.ts`** (A1 and A2). Before: sha256 `02188d9dc279721222ceccdaf8503d436540a61f9fe3a5aa4283158bb3442cdb`. Replace lines 28–29
```ts
export type LinkTokenPurpose = 'checkin';
export type WorkflowActionKey = 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts';
```
with
```ts
export type LinkTokenPurpose = 'checkin' | 'application' | 'agreement';
export type WorkflowActionKey = 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts' | 'approve' | 'booth_texts';
```
After the hunk alone: sha256 `43dff1dcfc8757c817f5180ec5550f138acd92e6977b0cbf0169b51831f8d902` (verify before adding your §1.4 block; A1's block goes after line 14, A2's at EOF — twelve-plus lines from the hunk, so git merges all three changes cleanly).

**`web/src/lib/api.ts`** (C1 and C2). Before: sha256 `ebeea3127a83f737e977948da77e5bf2d325478797b3934106fc08a42e3f185b`. Line 38 `function qs(` → `export function qs(`; line 62 `async function request<T>(` → `export async function request<T>(`. After the hunk alone: sha256 `97d6ec3aa53945cc3ccfdcc2255eea912ac87851e73903e89acd0cadcf724a55`. C1 changes nothing else in this file; C2 then appends inside `api` (§4.2).

**`src/services/sms.ts`** (A1 only — no second applier). Replace line 43 `  | 'forwarded_inbound';` with
```ts
  | 'forwarded_inbound'
  // Phase 4 (contract §2.12): the application invite and the acceptance text.
  | 'application_invite'
  | 'acceptance';
```
`'booth'` already exists and is what A2's booth texts use; A2 adds no kind.

### 1.7 MERGE ORDER (the integrator) — **A1 → A2 → C1 → C2**, from `main`, `npm run typecheck && npm test` after each merge, fixing forward; after C1 and after C2 also `cd web && npx tsc --noEmit && npm run build`.

Why: A1 owns `app.ts`, originates both shared backend modules and the `storage` decorator that nothing else needs; A1 alone must boot (`tests/app-boot.test.ts`). A2 adds identical copies of the two shared modules (git resolves identical add/add), applies the identical schema hunk, inserts at anchors A1 never touches (line 10 / line 107 / firestore.ts line 60 / schema EOF) and modifies files A1 never touches (`market-dates.ts` service and route, `checkin-workflow.ts`). A2's engine reads memberships through the shared module whose semantics A1's routes write, so the season tests are meaningful only after A1. C1 touches `web/src/**` only (api.ts hunk + new files) and is the origin of `phase4-types.ts`; C2 copies it and edits the existing admin pages, so C2 last and its `next build` is the final gate. Integrator checklist: (1) `shasum -a 256 src/services/seasons.ts src/services/purpose-tokens.ts web/src/lib/phase4-types.ts src/types/schema.ts` — the first three equal §1.5; schema differs from §1.6 only by the two blocks; `grep -c "export function qs\|export async function request" web/src/lib/api.ts` = 2. (2) Write and run `tests/phase4-e2e.test.ts` (§5.5). (3) `grep -rn "America/Chicago\|2027\|\$700\|700\b" src/services/*.ts src/routes/*.ts` prints nothing outside comments. (4) Delete the dead Phase 2 web items (`api.submitApplication`, `Application`, `ApplicationInput` in types.ts) once nothing imports them. (5) Optionally refactor A2's `agreements.ts` to import `resolvePurposeToken` — it already does (shared module); nothing to do. (6) Fold `docs/phase4/notes-*.md` into `CHANGELOG.md`, update CLAUDE.md status/repo map, SPEC §8 status, then §6 before any deploy.

---

## 2. DATA (types as stored: Timestamp written as `new Date()`, `'YYYY-MM-DD'`, `'HH:mm'`; money as integer dollars; `req` = always present on a Phase 4 write)

### 2.1 `farmers_markets` additions (A1: `src/services/markets.ts` interfaces + zod; all optional on read with the defaults below)

| Field | Type | Default (read-side when absent) |
|---|---|---|
| `season` | `{ label: string (SEASON_LABEL_RE), application_open: 'YYYY-MM-DD'\|null, application_close: 'YYYY-MM-DD'\|null, schedule_version_id: string\|null }` | `null` → `currentSeason()` infers (§1.5); applications are open iff `label` is set and today (market-local) is within `[application_open, application_close]` (null end = open-ended) |
| `fees` | `MarketFees` | `DEFAULT_FEES = { application_fee: 15, seasonal_total: 700, seasonal_paid_in_full: 600, seasonal_installments: 2, daily: 25, electric_seasonal: 50, electric_daily: 5, currency: 'USD' }` — the 2027 §4 amounts, editable per season, never referenced by code outside this constant |
| `payment_links` | `{ application_fee_url: string\|null, booth_fee_url: string\|null }` | `{ null, null }`; a URL may contain `{email}` |
| `legal` | `MarketLegal` (§1.5) | `DEFAULT_LEGAL`: `rules_markdown: ''`, `rules_version: ''`, `rules_url: null`, `hold_harmless_markdown: ''`, `hold_harmless_version: ''`, the three help URLs `null`, `sms_consent_text: 'I agree to receive text messages from SJCA Markets about my market participation (weekly check-ins, booth assignments and market-day notices) at the mobile number above. Message frequency varies; message and data rates may apply. Reply STOP to opt out, HELP for help.'`, `sms_consent_version: 'sjca-sms-1'` |
| `booth_map_url` | `string\|null` | `null` |
| `categories` | `MarketCategory[]` | `DEFAULT_CATEGORIES` (below) |
| `product_types` | `ProductTypeConfig[]` | `DEFAULT_PRODUCT_TYPES` (below) |

`updateMarketSchema` gains `season` (object, `label` regex, dates `dateString`, `schedule_version_id` must name an existing version or be null), `fees` (nonnegative ints, `currency` 3 letters), `payment_links` (`z.string().url()` or null each), `legal` (strings ≤ 50 000 chars for the two markdown fields, URLs or null), `booth_map_url` (url or an absolute path `/^\//` or null), `categories`, `product_types` (full arrays, validated with the shapes in §1.5; keys `/^[a-z][a-z0-9_]{1,31}$/` unique). PATCH writes each as a whole top-level field (never a dotted path into them). `toMarketDTO` keeps exposing everything to staff (nothing here is secret). The zod `marketSeasonSchema`, `feesSchema`, `legalSchema`, `categorySchema`, `productTypeSchema` are exported from `markets.ts`.

**`DEFAULT_CATEGORIES`** (keys, labels from the rules §3): `farmers_ranchers` "Farmers / Ranchers" — "fruits, vegetables, meats, mushrooms, nuts, seeds, grains, eggs, herbs, plants, flowers"; `specialty_food` "Specialty Food" — "baked goods, mixes, jams and jellies, honey, condiments, beverages, cheese, pet items"; `food_adjacent` "Food-adjacent products" — "woodwork, pottery, fabric crafts, plant and botanical arts, natural skincare and cleaning products"; `crafts` "Crafts (special events only)" — "soaps, lotions, candles, clothing, pottery, artwork, jewelry, leather", `events_only: true`. Sort 1–4.

**`DEFAULT_PRODUCT_TYPES`** (nine; `permit_rule` is shown verbatim in the form; practice keys are data the admin may edit through PATCH — the UI does not edit them in Phase 4):

| key | label | category_keys | permit_rule (verbatim) | permit_upload | prohibited | checklist / details |
|---|---|---|---|---|---|---|
| `produce` | Produce, herbs, plants and flowers | farmers_ranchers | "No permit is required for whole, uncut produce or microgreens. Plants and nursery stock must comply with Arkansas State Plant Board regulations." | none | "Wild-harvested mushrooms. Sprouts (microgreens are allowed)." | 22 practices: certified_organic, certified_naturally_grown, no_synthetic_pesticides, no_synthetic_fertilizers, no_herbicides, integrated_pest_management, cover_crops, crop_rotation, compost, drip_irrigation, non_gmo_seed, heirloom_varieties, high_tunnel, greenhouse, hydroponic, raised_beds, no_till, conventional, gap_certified, food_safety_plan, cold_storage, other; details: `plant_board` boolean "I sell plants or nursery stock and comply with the Arkansas State Plant Board" (required: false) |
| `meat_poultry` | Meat and poultry | farmers_ranchers | "Meat and poultry must be processed in a USDA-inspected facility and sold frozen. Labels must include product name, net weight, farm name and address." | none | '' | 13 practices (shared with eggs/dairy): pasture_raised, grass_fed, grass_finished, free_range, cage_free, no_antibiotics, no_added_hormones, non_gmo_feed, organic_feed, certified_humane, animal_welfare_approved, usda_inspected_processing, on_farm_processing; details: `usda_facility` text "USDA-inspected processing facility" required |
| `eggs` | Eggs | farmers_ranchers | "Eggs must be washed, pre-packaged, labeled \"ungraded\", labeled with the farm name and address, and refrigerated at all times." | none | '' | the 13 practices |
| `dairy` | Dairy and cheese | farmers_ranchers, specialty_food | "A permit is required for dairy products. Upload your permit, or tell us you will provide it before your first market." | required | '' | the 13 practices; details: `facility` text required |
| `honey_sorghum` | Honey and sorghum | farmers_ranchers, specialty_food | "No permit is required for honey and sorghum." | none | '' | practices: none; details: `hives` number required, `registered_inspected` boolean, `commercial_facility` boolean, `flavoured` boolean "Flavored or infused products" |
| `value_added` | Baked goods, jams, canned goods, mixes, condiments, beverages | specialty_food | "Properly labeled Food Freedom products need no permit. Canned goods not approved by the Food Freedom Act and any TCS (time/temperature control for safety) food require a permit: upload it or tell us you will provide it before your first market." | required_unless_food_freedom | '' | practices: certified_kitchen, food_freedom_labelled, batch_records, allergen_labelling, cottage_food_training; details: `facility_kind` text required ("home kitchen (Food Freedom)", "commercial kitchen", "own licensed facility"), `certifications` text, `food_freedom_only` boolean "Everything I sell under this type is a labeled Food Freedom product" |
| `prepared_food` | Prepared and ready-to-eat food | specialty_food | "Prepared and TCS foods require an Arkansas Department of Health permit (Retail Food Establishment or mobile unit). Upload it or tell us you will provide it before your first market." | required | '' | practices: none; details: `permit_number` text, `mobile_unit` boolean "Sold from a food truck or trailer" |
| `non_food` | Non-food, food-adjacent and craft items | food_adjacent, crafts | "No permit is required. Herbal, skincare and cleaning products may carry no unapproved health claims and must comply with FDA/FTC guidance." | none | '' | practices: handmade_in_arkansas, natural_ingredients, no_health_claims |
| `education` | Education and demonstration | farmers_ranchers, specialty_food, food_adjacent | "No permit is required." | none | '' | none |

Config `agricultural_practices` options: certified_organic "Certified organic", certified_naturally_grown "Certified Naturally Grown", no_chemicals "No synthetic chemicals (not certified)", conventional "Conventional", not_applicable "Not applicable". `payment_methods`: cash, card, check, wic "WIC", snap "SNAP/EBT". `frequencies`: every_other_week, monthly, occasional. `months`: april … november (keys lower-case English month names; the config lists only months inside the season window). These option lists live in `src/services/applications.ts` as constants (not per market).

### 2.2 `applications` — doc id = uuid (A1; the one Phase 2 doc keeps its old shape and reads with `schema_version: 1`; new docs write `schema_version: 2`). Stored shape = `ApplicationDoc` (§1.5) with Timestamps for `*_at` plus `ip` (req, the submitting `request.ip`), `user_agent` (req, ≤ 500 chars), `schema_version: 2`. `products[].category` is derived server-side from the type's first `category_keys` entry the applicant selected. `season_total` is computed at submission by `computeSeasonTotal(fees, booth, market_count)` and frozen. `fee.amount = fees.application_fee`. **Admin-only in every response:** `ip`, `user_agent`, `signature.ip`, `sms_consent.ip`, `review.notes` — all application routes are `requireRole('admin')`, so no stripping is needed; the public submit response is `ApplicationSubmitResult` only.

`computeSeasonTotal` (pure, `src/services/applications.ts`): seasonal → `booth_fee = (pay_in_full ? seasonal_paid_in_full : seasonal_total) × spaces`, `electric_fee = electric ? electric_seasonal : 0`, `total = booth_fee + electric_fee`, `basis: 'season'`, `installments = pay_in_full ? 1 : seasonal_installments`; daily → `booth_fee = daily × spaces`, `electric_fee = electric ? electric_daily : 0`, `total = booth_fee + electric_fee`, `basis: 'per_market'`, `installments: 0`. Electricity is charged once per vendor (one hookup); the rules charge booth fees per space. C1's `web/src/lib/fees.ts` mirrors this exactly for the live total; the server value wins.

### 2.3 `producers` additions (A1; all optional on read, defaults in parentheses): `website: string ('')`, `social: string ('')`, `address: { street, city, state, zip } | null (null)`, `description_public: string ('')`, `years_in_operation: number|null`, `outlets: string ('')`, `agricultural_practices: AgriculturalPractice|null`, `categories: string[] ([])`, `products: ProductEntry[]` — **the Phase 2 `products: string[]` becomes structured**: readers accept both (`string[]` → `[{ type: 'produce', items: <the strings>, practices: [], description: '', details: {} }]` only when displaying; the 39 production docs all have `[]`), `payment_methods: string[] ([])`, `logo_upload_id: string|null (null)`, `last_application_id: string|null`. `updateProducerSchema` gains these (zod mirrors §1.5 `ProductEntry`; `products: z.array(productEntrySchema).max(50)`). Approval copies `contact.*` → producer (`business_name` canonical stays; a different name becomes an alias as today), `mobile` → `phone` (E.164; a conflicting phone on another producer → 409 `{ error, producer_id }` before anything is written), `sms_consent: { status: 'opted_in', at: application.sms_consent.at, source: 'application', text_version, ip }`, `sms_opt_out_at` untouched.

### 2.4 `application_uploads` — doc id = uuid (A1)
`{ draft_id (req, uuid v4), application_id: string|null, kind: UploadKind, storage_path: 'application-uploads/<yyyy>/<draft_id>/<id>.<ext>', mime, bytes, sha256 (hex of the buffer), original_name (≤ 200 chars, basename only), ip, uploaded_at, attached_at: Date|null, expires_at: uploaded_at + 14 days (informational; a nightly purge is Phase 5) }`. Limits (`UPLOAD_LIMITS` exported from `application-uploads.ts`, also in the config response): 10 MB, mimes `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `image/heif`; magic bytes checked (`%PDF`, `FF D8 FF`, `89 50 4E 47`, `ftyp` at offset 4) — a mismatch is 415; at most 10 uploads per `draft_id`.

### 2.5 `application_invites` — doc id = `${market_id}_${season}_${producer_id}` (A1, created atomically = the dedupe)
`{ market_id, season, producer_id, token, email: string|null, email_status: 'sent'|'skipped_no_email'|'failed'|'simulated', phone: string|null, sms_status: 'sent'|'simulated'|'skipped_no_phone'|'skipped_opted_out'|'failed'|'duplicate', message_id: string|null, sent_by, sent_at, resends: { at, by, token, email_status, sms_status }[] }`.

### 2.6 `producer_memberships` become per season (A1 writes; the shared module reads)
New docs: id `membershipDocId(producer_id, market_id, season)`, written with `create()`. Fields (req on write): `producer_id`, `market_id`, `season`, `status` (Phase 2 machine unchanged), `fee_plan: 'seasonal'|'daily'`, `spaces: 1|2`, `electric: boolean`, `pay_in_full: boolean`, `booth_kind: 'stall'|'food_truck'`, `usual_booth_id: string|null`, `trial_period: boolean`, `approved_at/approved_by`, `insurance: { status: 'missing'|'on_file'|'expired'|'waived', expires_at: Date|null, upload_id: string|null, verified_by: string|null, verified_at: Date|null, note: '' }`, `hold_harmless: null | { signed_at, name, ip, version, token }`, `approved_items: string[]` (flattened `products[].items` at approval), `item_requests: ItemRequest[]`, `application_id`, `history[]`, `source`, `created_at/updated_at`. The 39 Phase 2 docs are never rewritten by code; `scripts/backfill-membership-seasons.mjs --market wlrfm --season 2026 [--write]` (dry-run default, mirrors `import-survey.mjs`' lazy `firebase-admin` init and `--db-project`) sets `season` on every membership of the market that lacks it, nothing else, and prints `scanned / updated / already_set`. **Lifecycle:** approval creates `status: 'approved'`; signing the Hold Harmless (A2) transitions `approved → active` (history `by: 'producer'`, note `'Hold Harmless signed'`); admins may still transition manually. Texts and booth drafts take `active` only (`isVendorOfRecord`). Previous seasons are never modified by Phase 4 code.

### 2.7 `booths` — doc id = `${market_id}_${slug(label)}` where `slug` = lower-case, `[^a-z0-9]+` → `-`, trimmed (A2; `create()` makes a label unique per market at creation; a later rename keeps the id)
`{ market_id, label (1–12 chars), row: string (free label, 'west' | 'east' | 'center' for WLRFM), order: number (integer, ascending = north to south), kind: 'stall'|'food_truck', power: boolean, size: string ('12x12'), notes: string, active: boolean, created_at, updated_at }`. Two-row rendering is by `row`; a two-space vendor needs two booths with the same `row` and consecutive `order`.

### 2.8 `booth_assignments` — doc id = uuid, append-only (A2)
`{ market_id, market_date_id (the TARGET date the vendor will attend), source_date_id (the collecting date whose check-ins produced it), booth_id, producer_id, source: 'usual'|'suggested'|'manual', assigned_by ('engine' | user id), assigned_at, superseded_by: string|null, superseded_at: Date|null }`. "Current" = `superseded_by == null`. Query: `where('market_date_id','==',target)`.

### 2.9 `market_dates.actions` additions (A2 edits `MarketDateActions` + `marketDateFromData`; the engine and routes write field paths only)
`drafts_generated_at` (first draft, engine or manual — already declared), `assignments_draft_at: Date|null` (latest draft or redraft), `assignments_target_date_id: string|null`, `drafts_skipped: DraftSkipReason|null`, `approved_at` (exists), `approved_by: string|null`, `booth_texts_sent_at` (exists), `booth_summary: { assigned: number; unassigned: number; booths_total: number; booths_free: number } | null`, `booth_text_recipients?: number`, `booth_text_failed?: number`, `booth_text_excluded?: number`, `claims` keys gain `'drafts' | 'approve' | 'booth_texts'`. `isDateDecided` is unchanged (it already counts the three Phase 2 flags).

### 2.10 `checkins` — unchanged. `attending_next === true` on the check-in of collecting date D means "attending the next market after D".

### 2.11 `link_tokens` purposes `'application'` and `'agreement'` — exactly `PurposeTokenDoc` (§1.5). Application tokens: `expires_at = season.application_close + 1 day (market-local midnight) if set, else created_at + 120 days`. Agreement tokens: `expires_at = created_at + 60 days`, `membership_id` set.

### 2.12 `messages.kind` values added: `'application_invite'` (`producer_id`, `extra: { token, market_id, season }`, dedupe `application_invite:<market_id>:<season>:<producer_id>` on the first invite, none on a forced resend), `'acceptance'` (`producer_id`, `extra: { application_id, membership_id, token }`, dedupe `acceptance:<application_id>`), `'booth'` (exists; `producer_id`, `market_date_id` = the TARGET date, `extra: { booth_labels: string[], source_date_id }`, dedupe `booth:<target_date_id>:<producer_id>`).

### 2.13 `audit_log` actions added: `application.transition`, `application.approve`, `application.decline`, `application.fee`, `application.items.approve`, `producer.invite_reapply`, `market.invite_reapply`, `membership.create`, `membership.update`, `membership.insurance`, `membership.agreement_link`, `membership.agreement.signed` (actor `producer:<id>`, role `'producer'`), `booth.create|update|delete|reorder|seed`, `market_date.assignments.draft|update|approve`, `market.update` (season/fees/legal are `before/after` subsets).

---

## 3. ROUTES

Auth legend: **public** (rate-limited, no JWT, never mints a session, response never contains a token except the ids stated); **staff** = `authenticate(app)` + `requireStaff()` then `canAccessMarket(user, market_id)` → 403; **admin** = `requireRole('admin')`. Every staff write audits. Market managers never see `producers.notes`, `checkins.estimated_sales`; applications are admin-only.

### 3.1 Public (A1 unless marked; `applicationRoutes`, prefix `/api/applications`; `marketRoutes` for rules)

| Method / path | Rate limit | Request (zod) | Response | Notes |
|---|---|---|---|---|
| `GET /api/applications/config?market=` | 60 / min | `z.object({ market: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/) })` | 200 `ApplicationConfig`; 404 unknown/inactive market | `season` from `currentSeason` + the version named by `schedule_version_id`, else the version with the greatest `season_start`; `market_count` = dates in that version's range matching `days_of_week`, minus `skipped_dates`, plus `special_dates` inside the range; `open_now` per §2.1; `stalls` = active `booths` of the market sorted by row/order with `usually_taken` from current-season memberships' `usual_booth_id`; `has_rules_text = legal.rules_markdown !== ''`; `limits` from `UPLOAD_LIMITS` and `STALL_PREFERENCE_MAX = 3` |
| `POST /api/applications/uploads` | 20 / hour per IP | multipart: fields `draft_id` (uuid v4), `kind` (`permit\|insurance\|logo`), one `file` | 201 `UploadResult`; 400 missing field; 413 over 10 MB (`fileSize` limit → catch `request.file()` truncation); 415 bad mime or magic bytes; 429 over 10 per draft | writes bytes via `app.storage.put`, then the metadata doc |
| `POST /api/applications` | 5 / hour per IP | `applicationSubmitSchema` (below) | 201 `ApplicationSubmitResult`; 400 zod; 404 market; 409 `{ error: 'Applications are closed for this market' }` when `!open_now`; 409 `{ error: 'We already have an application for this email this season', application_id }` when an application with the same normalised email, same market, same season and status ∉ {declined, withdrawn} exists; 410 bad `prefill_token` | reads the market and config once; validates every `products[].type` exists, every category key exists, `permits` has an entry for every selected type whose rule is `required` (status ∈ uploaded/will_provide) or `required_unless_food_freedom` (uploaded/will_provide/food_freedom), every referenced `upload_id` exists with the same `draft_id`; `stall_preference` ids exist; `sms_consent === true` else 400 `'Text consent is required'`; `acknowledgements.*` all `true`; `rules_version === legal.rules_version` else 400 `'Please re-read the current rules'` (skipped when `legal.rules_version === ''`); normalises email (`normalizeEmail`) and mobile (`normalizePhone`, then E.164 regex) ; **upserts no producer** (identity is resolved at approval, as today) but records `prefill_producer_id` from a valid token; writes the doc with `create()`; marks `application_uploads.application_id/attached_at`; `markPurposeTokenUsed(token, { application_id })`; `fee.url` = `payment_links.application_fee_url` with `{email}` substituted |
| `GET /api/applications/prefill/:token` | 60 / min | `TOKEN_RE` else 404 | 200 `PrefillView`; 404 unknown; 410 expired/used | producer fields per §2.3 (no `notes`, no ids); `last_membership` = the producer's newest membership at the market in any season ≠ current, `usual_booth_label` resolved from `booths` |
| `GET /api/markets/:id/rules` | 60 / min | — | 200 `RulesView`; 404 market missing or `rules_markdown === '' && rules_url === null` | in `marketRoutes` |
| `GET /api/agreements/:token` (A2) | 60 / min | `TOKEN_RE` else 404 | 200 `AgreementView` (`status: 'signed'` with `signed` when the token is `used` or the membership already has `hold_harmless`; `'expired'` is a 410 body `{ error }` — no view) | loads membership → market (`legal.hold_harmless_markdown/version`) → producer |
| `POST /api/agreements/:token` (A2) | 10 / hour | `z.object({ signature_name: z.string().trim().min(2).max(120), agree: z.literal(true) })` | 200 `{ ok: true, signed: { name, signed_at }, membership_status }`; 404/410; 409 `{ error: 'Already signed' }` when `hold_harmless` exists | writes `hold_harmless` (field path) only when null, with `version = legal.hold_harmless_version`, `ip = request.ip`, `token`; transitions `approved → active` (history by `'producer'`); `markPurposeTokenUsed`; audits `membership.agreement.signed`; **no text or email is sent** |

```ts
// src/services/applications.ts (A1) — the submission schema (zod 3)
const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (max: number) => z.string().trim().max(max);
export const addressSchema = z.object({ street: str(200), city: str(100), state: str(40), zip: str(12) });
export const productEntrySchema = z.object({
  type: z.string().regex(KEY),
  items: z.array(str(80)).min(1).max(100),
  practices: z.array(z.string().regex(KEY)).max(40).default([]),
  description: str(2000).default(''),
  details: z.record(z.union([str(500), z.number().finite(), z.boolean()])).default({}),
});
export const permitEntrySchema = z.object({
  status: z.enum(['uploaded', 'will_provide', 'not_required', 'food_freedom']),
  upload_id: z.string().uuid().nullable().default(null),
  note: str(500).default(''),
}).refine((p) => p.status !== 'uploaded' || !!p.upload_id, { message: 'upload_id is required when status is uploaded', path: ['upload_id'] });
export const applicationSubmitSchema = z.object({
  market_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  draft_id: z.string().uuid(),
  prefill_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().default(null),
  contact: z.object({
    name: str(120).min(1), business_name: str(200).min(1), email: z.string().trim().email().max(254),
    mobile: z.string().trim().min(10).max(20), website: str(300).default(''), social: str(300).default(''),
    address: addressSchema, description: str(3000).default(''), years_in_operation: z.number().int().min(0).max(150).nullable().default(null),
    outlets: str(1000).default(''), agricultural_practices: z.enum(['certified_organic', 'certified_naturally_grown', 'no_chemicals', 'conventional', 'not_applicable']),
    additional_info: str(3000).default(''),
  }),
  sms_consent: z.literal(true, { errorMap: () => ({ message: 'Text consent is required' }) }),
  sms_consent_version: str(40).min(1),
  returning: z.object({ is_returning: z.boolean(), last_stall: str(12).nullable().default(null) }),
  categories: z.array(z.string().regex(KEY)).min(1).max(4),
  products: z.array(productEntrySchema).min(1).max(9).refine((p) => new Set(p.map((e) => e.type)).size === p.length, 'duplicate product type'),
  permits: z.record(z.string().regex(KEY), permitEntrySchema).default({}),
  booth: z.object({
    rate: z.enum(['seasonal', 'daily']),
    frequency: z.enum(['every_other_week', 'monthly', 'occasional']).nullable().default(null),
    months: z.array(z.string().regex(KEY)).max(12).default([]),
    spaces: z.union([z.literal(1), z.literal(2)]),
    electric: z.boolean(), pay_in_full: z.boolean(),
    stall_preference: z.array(z.string().min(1).max(60)).max(3).default([]),
    food_truck: z.boolean().default(false),
  }).refine((b) => b.rate !== 'daily' || b.frequency !== null, { message: 'frequency is required for the daily rate', path: ['frequency'] })
    .refine((b) => b.rate !== 'seasonal' || !b.pay_in_full || true, { message: '' }),
  payment_methods: z.array(z.enum(['cash', 'card', 'check', 'wic', 'snap'])).min(1),
  insurance: z.object({
    status: z.enum(['have', 'none', 'need_guidance']), certificate_upload_id: z.string().uuid().nullable().default(null),
    carrier: str(120).default(''), expires_on: z.string().regex(DATE).nullable().default(null),
  }),
  acknowledgements: z.object({
    rules: z.literal(true), weekly_report: z.literal(true), farm_visits: z.literal(true),
    marketing: z.literal(true), products_listed_only: z.literal(true), own_booth_only: z.literal(true),
  }),
  rules_version: str(40),
  signature_name: str(120).min(2),
});
export type ApplicationSubmitInput = z.infer<typeof applicationSubmitSchema>;
```
(The second `refine` on `booth` is a placeholder for executors to drop; `pay_in_full` is simply ignored for `daily`.)

### 3.2 Staff — applications (A1, admin only, prefix `/api/applications`)

| Method / path | Request | Response | Audit |
|---|---|---|---|
| `GET /` | query `{ market_id?, season?, status?: ApplicationStatus, fee?: FeeStatus, category?, returning?: 'true'\|'false', q? }` — ONE equality filter at the DB (`status` when given else `market_id` when given else none), the rest in memory | `{ applications: ApplicationListItem[] }` newest first; `season` defaults to the market's current season when `market_id` is given | no |
| `GET /:id` | — | `{ application: ApplicationDoc, uploads: UploadMeta[], producer: { id, business_name } \| null, prior_memberships: MembershipView[] (every season of the matched/prefilled producer at that market) }` | no |
| `GET /:id/uploads/:upload_id/url` | — | `{ url, expires_at }` from `app.storage.signedReadUrl({ path, expiresInMs: 15 * 60_000, filename: original_name })`; 404 when the upload is not this application's (or the producer's logo/insurance) | no |
| `PATCH /:id` | discriminated union on `action`: `review` → `under_review`; `withdraw`; `note` `{ notes: str(5000) }` (review.notes only); `fee` `{ status: 'paid'\|'waived'\|'unpaid', reference?: str(120) }`; `decline` `{ reason: str(2000) }`; `approve` (below) | `{ application }` (+ `producer`, `membership`, `sends` for approve) | `application.<action>` |

**`approve`** body: `{ action: 'approve', fee_plan: z.enum(['seasonal','daily']), spaces: 1|2, electric: boolean, pay_in_full: boolean, booth_kind: z.enum(['stall','food_truck']).default('stall'), usual_booth_id: z.string().nullable().default(null), trial_period: z.boolean().default(false), note: str(2000).default(''), send: z.boolean().default(true) }` — defaults in the UI come from `booth.*`. Preconditions: status ∈ {new, under_review} else 409; `usual_booth_id` must be an active booth of the market else 400. Steps, in order: (1) producer = `prefill_producer_id` if set and the doc exists, else `upsertProducerByEmail(contact.email, …)` (phone conflict → 409 before any write); copy §2.3 fields; (2) `season = application.season`; `findMembership(producer, market, season)` → if it exists and status ∉ {inactive} → 409 `{ error: 'This producer already has a <season> membership', membership_id }`; else `create()` the §2.6 doc with `status: 'approved'`, `approved_items` = flattened items, `insurance.status = application.insurance.certificate_upload_id ? 'on_file' : 'missing'` with `expires_at` from `expires_on`, `upload_id`, `verified_by: null`; on `isAlreadyExists` → 409 (two admins); (3) agreement token: `mintPurposeToken({ purpose: 'agreement', membership_id, created_by: user.id, expires_at: now + 60 d })`; (4) application → `approved`, `producer_id`, `membership_id`, `review.*`, `fee` untouched; (5) if `send`: text `TEMPLATES_A1.acceptance` via `trySendSms({ kind: 'acceptance', dedupe_key: 'acceptance:<application_id>' })` when the producer is textable, and `sendEmail` (acceptance email, below) when `env.FROM_EMAIL` is non-empty — both wrapped, never fail the request; `sends: { sms: 'sent'|'simulated'|'failed'|'duplicate'|'skipped_<reason>', email: boolean }`; (6) audits `producer.create|update`, `membership.create`, `application.approve`. Approving never touches a 2026 (or any other season's) membership row.

Acceptance text (ASCII, ≤ 2 segments): `SJCA Markets: your ${season} ${market_name} application is approved, ${first_name}! Please sign the Hold Harmless agreement here: ${agreement_link}\nBooth fee: $${total}${basis === 'per_market' ? ' per market' : ''}. Pay here: ${booth_fee_url}\nReply STOP to opt out.` (omit the pay sentence when `booth_fee_url` is null). Acceptance email: subject `[SJCA Markets] Your ${season} ${market_name} application is approved`; body lines: greeting; rate, spaces, electricity, pay-in-full, computed total with installments; the agreement link; the payment link; "Proof of $1,000,000 general liability insurance naming KBK-Breck, LLC c/o Kelley Commercial Partners, The WLRFM and ALFN/West Little Rock Farmers Market as additional insureds is required before your first market day." + `insurance_help_url`; first market date of the season (from the config's version); the rules link `${APP_URL}/rules?market=<id>`.

### 3.3 Staff — producers, memberships, invites (A1)

| Method / path | Auth | Request | Response | Audit |
|---|---|---|---|---|
| `GET /api/producers?market_id&status&season&q&include_inactive` | staff | `season` defaults to the market's current season when `market_id` is given; `status` filters memberships of that season | each row's `memberships[]` entries gain `season`, `fee_plan` (normalised), `spaces`, `electric` | no |
| `GET /api/producers/:id` | staff | — | `memberships: MembershipView[]` (all seasons, newest first), `current_season_by_market: Record<market_id, season>`, `invite: { token_url, sent_at } \| null` for the current season | no |
| `PATCH /api/producers/:id` | admin | `updateProducerSchema` + §2.3 fields | `{ producer }` | `producer.update` |
| `POST /api/producers/:id/invite?market_id=` | admin | query `{ market_id, force?: 'true' }` | `{ invite: ApplicationInviteDoc, url }`; 409 `{ error: 'Already invited', invite }` when the `application_invites` `create()` collides and `!force`; 409 when applications are not open (`season.label` unset) | `producer.invite_reapply` |
| `POST /api/markets/:id/invite-reapply` | admin | `{ season?: string (default current), force: z.boolean().default(false), dry_run: z.boolean().default(false) }` | `{ season, candidates: number, invited: number, skipped_already: number, skipped_applied: number, skipped_no_contact: number, results: { producer_id, business_name, email_status, sms_status }[] }` | `market.invite_reapply` |
| `POST /api/memberships` | admin | `{ producer_id, market_id, season?: (default current), status?, fee_plan?: 'seasonal'\|'daily', spaces?, electric?, pay_in_full?, booth_kind?, usual_booth_id? }` | 201 `{ membership: MembershipView }`; 409 when `findMembership` finds one for that season | `membership.create` |
| `PATCH /api/memberships/:id` | staff (market) | `{ status?, note?, fee_plan?, spaces?, electric?, pay_in_full?, booth_kind?, usual_booth_id?, trial_period? }` | `{ membership: MembershipView }` | `membership.transition` / `membership.update` |
| `POST /api/memberships/:id/items` | staff (market) | `{ action: 'approve'\|'decline', request_id }` or `{ action: 'add', items: string[] (admin adds directly) }` | `{ membership }` — approving appends the request's items to `approved_items` and mirrors them into the producer's `products[]` (type `'other'` entry when no type matches) | `application.items.approve` |
| `GET /api/dashboard` | staff | — | card gains `season: string`; `progress.active_memberships` counts current-season `active` only | no |

Invite candidates (bulk): every producer with any membership at the market in a season ≠ `season`, `producers.active !== false`, no application for `(market, season)` with status ∉ {declined, withdrawn}; per candidate: `create()` the invite doc (collision → `skipped_already` unless `force`, which appends to `resends` and sends again without a dedupe key), mint the application token (`created_by: user.id`), email (`sendEmail`, subject `Apply for the ${season} ${market_name} season`, body with the prefilled link, the $application_fee note, the rules link; skipped when no email), text `TEMPLATES_A1.application_invite` = `SJCA Markets: applications for the ${season} ${market_name} season are open. ${first_name}, your returning-vendor application is prefilled here: ${link}\nReply STOP to opt out.` (skipped when no E.164 phone or opted out). Sends go through `trySendSms`/`sendEmail` (console in tests). `resolveCheckinToken`'s purpose guard (§1.2) is A1's.

### 3.4 Staff — booths and assignments (A2)

| Method / path | Auth | Request | Response | Audit |
|---|---|---|---|---|
| `GET /api/markets/:id/booths` | staff (market) | query `{ include_inactive?: 'true' }` | `{ booths: BoothDoc[] }` sorted row, order | no |
| `POST /api/markets/:id/booths` | admin | `{ label: str(12).min(1), row: str(20).min(1), order: z.number().int(), kind: z.enum(['stall','food_truck']).default('stall'), power: z.boolean().default(false), size: str(20).default('12x12'), notes: str(500).default('') }` | 201 `{ booth }`; 409 label exists (`create()` collision) | `booth.create` |
| `POST /api/markets/:id/booths/seed` | admin | `{ rows: { row: string, labels: string[] }[], food_truck?: { label: string, row: string, order: number } \| null }` | `{ created, existing }` — creates each label (`create()`, existing skipped) with `order` = index + 1 | `booth.seed` |
| `PATCH /api/markets/:id/booths/:booth_id` | admin | partial of the create body + `active?: boolean` | `{ booth }`; 404 when `booth.market_id !== :id` | `booth.update` |
| `DELETE /api/markets/:id/booths/:booth_id` | admin | — | `{ booth }` — sets `active: false` (never deletes: assignments reference it); 409 when any current-season membership has it as `usual_booth_id` | `booth.delete` |
| `PUT /api/markets/:id/booths/reorder` | admin | `{ rows: { row: string, booth_ids: string[] }[] }` | `{ booths }` — rewrites `row`/`order` per list | `booth.reorder` |
| `GET /api/market-dates/:id/status` | staff | — | `MarketDateStatus` + `assignments: AssignmentsView` (below) | no |
| `POST /api/market-dates/:id/assignments/draft` | staff (market) | `{ redraft: z.boolean().default(false) }` | `{ draft: DraftResult, assignments: AssignmentsView }`; 409 `'No upcoming market date to assign'`, 409 `'Already drafted'` (without `redraft`), 409 `'Assignments are approved; redraft is closed'` when `approved_at` set, 409 `'in_progress'` when the engine holds the `drafts` lock | `market_date.assignments.draft` |
| `PATCH /api/market-dates/:id/assignments` | staff (market) | `{ changes: { producer_id: string, booth_ids: string[] (0 = unassign, 1–2) }[] }` | `{ assignments }`; 400 unknown booth / inactive booth / not attending; 409 when `booth_texts_sent_at` set (changes after texts are a new feature — refuse); after `approved_at` the change is allowed and `actions.booth_texts_sent_at` stays — the response carries `warning: 'approved'` | `market_date.assignments.update` (manual, supersedes) |
| `POST /api/market-dates/:id/assignments/approve` | staff (market) | `{}` | `{ assignments, texts: { attempted: boolean, sent, failed, excluded, deferred_until: string \| null } }`; 409 no draft, 409 conflicts (two current assignments on one booth), 409 already approved, 409 `in_progress` | `market_date.assignments.approve` |
| `PATCH /api/memberships/:id/insurance` | staff (market) | `{ status: z.enum(['missing','on_file','expired','waived']), expires_at: z.string().regex(DATE).nullable().default(null), upload_id: z.string().uuid().nullable().default(null), note: str(500).default('') }` | `{ membership: MembershipView }`; `verified_by/verified_at` set when status becomes `on_file`/`waived` | `membership.insurance` |
| `POST /api/memberships/:id/agreement-link` | staff (market) | `{ send: z.boolean().default(true) }` | `{ url, expires_at, sms: 'sent'\|'simulated'\|'failed'\|'skipped_<reason>' }`; 409 when `hold_harmless` already signed | `membership.agreement_link` (text kind `'acceptance'`, no dedupe key: a deliberate resend) |

```ts
export interface AssignmentsView {
  target_date: { id: string; date: string; date_label: string } | null;
  season: string;
  drafted_at: Date | null; assignments_draft_at: Date | null; approved_at: Date | null; approved_by: string | null;
  booth_texts_sent_at: Date | null; booth_texts_due_at: Date | null;   // nextAllowedInstant(approved_at) when approved and unsent
  drafts_skipped: DraftSkipReason | null;
  booths: { booth: BoothDoc; assignment: { id: string; producer_id: string; business_name: string; source: AssignmentSource; assigned_by: string; assigned_at: Date } | null }[];
  attending: { producer_id: string; business_name: string; spaces: 1 | 2; electric: boolean; booth_kind: BoothKind; usual_booth_id: string | null; booth_ids: string[] }[];
  unassigned: { producer_id: string; business_name: string; reason: 'no_power_stall' | 'no_pair' | 'full' | 'no_food_truck_slot' }[];
  not_attending: { producer_id: string; business_name: string }[];
  no_answer: { producer_id: string; business_name: string }[];
  summary: { assigned: number; unassigned: number; booths_total: number; booths_free: number; conflicts: number };
  messages: { id: string; producer_id: string | null; to: string; status: string; created_at: Date }[];   // kind 'booth' for the target date
}
```
`resend-checkin` (existing route) replaces its `doc(\`${producer_id}_${market.id}\`)` read with `findMembership(db, producer_id, market.id, currentSeason(market, now))`.

### 3.5 THE ENGINE (A2, `src/services/checkin-workflow.ts`)

- **`listRecipients(db, marketId)`** keeps its signature; implementation: `market = farmers_markets/<id>` (one read), `{ memberships } = listCurrentMemberships(db, market, now ?? new Date())` filtered `isVendorOfRecord` — add an optional third parameter `opts?: { now?: Date }` and have the engine pass `now`. Everything else (phone/opt-out rules, sorting) unchanged. Phase 3 fixtures (no `season`, no `market.season`) resolve to `'2026'`, so every Phase 3 test keeps passing.
- `DEDUPE_KEYS.booth = (targetDateId, producerId) => \`booth:${keyPart(targetDateId)}:${keyPart(producerId)}\``. `EngineResult` gains `drafts_generated: number; booth_texts_sent: number`.
- **`nextDateAfter(db, market, date)`** — `market_dates.where('market_id','==',market.id)`, in memory: `status !== 'cancelled' && d.date > date.date`, earliest; null when none.
- **Drafts step** (replaces the stub; due iff `schedule.drafts_at ≤ now && !actions.drafts_generated_at`): under `claim(db, date.id, 'drafts', now, (a) => !!a.drafts_generated_at)`: `draftAssignments(db, market, date, { now, actor: 'engine', mode: 'initial' })` which: finds the target date (none → `'actions.drafts_skipped': 'no_next_date'`, `'actions.drafts_generated_at': now`); loads active booths (none → `no_booths`); loads `listCurrentMemberships` ∩ `active` and the date's `checkins` → `attending` = producers whose check-in has `attending_next === true` (none → `no_attendees`); `planAssignments(…)` (pure, below); writes one `booth_assignments` doc per (producer, booth) with `source` from the plan, `assigned_by: actor`, `source_date_id: date.id`, `market_date_id: target.id`; then field paths `'actions.drafts_generated_at': now` (only when null), `'actions.assignments_draft_at': now`, `'actions.assignments_target_date_id': target.id`, `'actions.drafts_skipped': null`, `'actions.booth_summary': {...}`, `updated_at`. `mode: 'redraft'` (manual route only, before approval): supersedes every current non-`manual` assignment of the target date (`superseded_by: <new id or 'redraft'>`, `superseded_at`), keeps `manual` ones as fixed, re-plans around them, writes `assignments_draft_at` only.
- **`planAssignments(input: { booths: BoothDoc[]; vendors: { producer_id; business_name; spaces; electric; booth_kind; usual_booth_id }[]; fixed: { producer_id; booth_id }[] }): { placed: { producer_id; booth_ids: string[]; source: 'usual'|'suggested' }[]; unassigned: { producer_id; reason }[] }`** (pure, exported from `booth-assignments.ts`): booths sorted (row, order); `free` = active booths minus `fixed`. Pass 1 (usual): vendors with a free `usual_booth_id` of the right kind, in booth order; a 2-space vendor also takes the free same-row neighbour `order + 1`, else `order − 1`, else gets the usual only and is also listed in `unassigned` with `no_pair` (the panel shows "second space not available"). Pass 2 (suggested): remaining vendors sorted by (`booth_kind === 'food_truck'` first, `electric` desc, `spaces` desc, `business_name`); food-truck vendors take the first free `food_truck` booth else `no_food_truck_slot`; 1-space: first free stall with `power` when electric, else first free stall ordered by (`power` asc, row, order) so powered stalls stay for those who need them; 2-space: first same-row consecutive free pair (both powered when electric) else `no_pair`; none free → `full`. Deterministic.
- **Approve** (route, §3.4): `claim(db, date.id, 'approve', now, (a) => !!a.approved_at)`; conflicts → 409 (no flag written); else `'actions.approved_at': now`, `'actions.approved_by': user.id`, `'actions.booth_summary'`; then runs **`sendBoothTextsStep`** immediately (below) and reports its outcome; a quiet-hours deferral returns `deferred_until`.
- **Booth-texts step** (engine, every tick, for every kept date; due iff `actions.approved_at != null && actions.booth_texts_sent_at == null && nextAllowedInstant(actions.approved_at, quiet_hours, tz) ≤ now`): under `claim(db, date.id, 'booth_texts', now, (a) => !!a.booth_texts_sent_at)`: current assignments of the target date grouped by producer (labels sorted by row/order); recipients = those producers via `listRecipients` (textable, active, current season); per producer `trySendSms({ kind: 'booth', to, body: TEMPLATES.booth(...), producer_id, market_date_id: target.id, extra: { booth_labels, source_date_id: date.id }, dedupe_key: DEDUPE_KEYS.booth(target.id, producer_id) })`; a `duplicate` counts as already sent; then `'actions.booth_texts_sent_at': now`, `'actions.booth_text_recipients'`, `'actions.booth_text_failed'`, `'actions.booth_text_excluded'`. Window note: the engine considers only dates within `SCAN_WINDOW_MS` of their close (7 days); approving later than the following Saturday noon relies on the approve route's immediate attempt — the panel says so when `in_window` is false.
- `TEMPLATES.booth({ market_name, date_short, labels, first_name })` = `SJCA Markets: ${first_name ? first_name + ', your' : 'your'} booth at ${market_name} on ${date_short} is ${labels.length === 1 ? labels[0] : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1]}. Please check in at the table when you arrive.\nReply STOP to opt out.` (food truck label = the booth's label, e.g. `Food truck`). ≤ 160 chars with a 40-char market name.
- `computeNextDue` gains `'drafts'` (after summary, when `!drafts_generated_at`) and `'booth_texts'` (when approved and unsent); the status route exposes it.

### 3.6 D29 (A1, `src/services/inbound.ts`)
Branch (5) becomes: HELP → `REPLIES.help` (unchanged); STOP/START already answered in (3); **everything else from a number that matches no producer is logged (the inbound row) and nothing is sent** — no `REPLIES.closed`, no forward. `REPLIES.closed` is deleted. `repliedRecently` stays for the known-producer courtesy reply. Update `tests/sms-webhook-auth.test.ts` cases "unknown text gets the closed reply once", "a second unknown text within 24 h", "an unknown number still gets STOP confirmation and the one-time reply" and `tests/inbound-checkin.test.ts` describe "unknown numbers — unchanged from Phase 1" to assert: zero outbound rows for a plain unknown text, exactly one `opt_out_confirm` for STOP, one `help` for HELP. Nothing else in those files changes.

---

## 4. THE WEB

### 4.1 C1 — public pages (mobile-first, 16 px gutters, no emoji, plain error states; all copy ASCII quotes)

`web/src/lib/api-apply.ts`:
```ts
import { request, qs, ApiError } from './api';
export const applyApi = {
  getConfig: (market: string) => request<ApplicationConfig>(`/applications/config${qs({ market })}`),
  upload: (file: File, draft_id: string, kind: UploadResult['kind'], onProgress?: (pct: number) => void) => Promise<UploadResult>,   // XMLHttpRequest multipart (progress events), rejects with ApiError(status)
  submit: (data: ApplicationSubmitInput) => request<ApplicationSubmitResult>('/applications', { method: 'POST', body: JSON.stringify(data) }),
  getPrefill: (t: string) => request<PrefillView>(`/applications/prefill/${encodeURIComponent(t)}`),
  getRules: (market: string) => request<RulesView>(`/markets/${encodeURIComponent(market)}/rules`),
  getAgreement: (t: string) => request<AgreementView>(`/agreements/${encodeURIComponent(t)}`),
  signAgreement: (t: string, data: AgreementSignInput) => request<{ ok: true; signed: { name: string; signed_at: string }; membership_status: string }>(`/agreements/${encodeURIComponent(t)}`, { method: 'POST', body: JSON.stringify(data) }),
};
```
`web/src/lib/apply-draft.ts`: `loadDraft(market) / saveDraft(market, state) / clearDraft(market)` under `localStorage['sjca_apply_<market>']` `{ draft_id (uuid v4 via crypto.randomUUID), section, values, saved_at }`, every access in try/catch. `web/src/lib/fees.ts`: `computeSeasonTotal(fees, booth, market_count): SeasonTotal` identical to the server's. `web/src/lib/markdown-lite.ts`: `renderMarkdownLite(md): Block[]` for `#`/`##`/`###`, `-`/`*` bullets, `1.` lists, paragraphs, `**bold**`, `[text](https://…)` (http/https only); no raw HTML passthrough; `web/src/components/markdown.tsx` renders the blocks.

**`/apply`** (`?market=wlrfm` default = the first active market from `getConfig`; `?t=` → `getPrefill` first and prefill every field it covers, showing "Welcome back, <business>" and `returning.is_returning = true`). Five sections with `progress-nav.tsx` (1 You and your business · 2 What you sell · 3 Your booth · 4 Insurance and agreements · 5 Review and submit), each validated before "Continue", state saved per section to the draft. Closed season → the page shows "Applications for <market> are not open right now." and the rules link. Section copy that the rules dictate:
1. Business: fields per `ApplicationContact`; mobile field label "Mobile number for market texts" with the `legal.sms_consent_text` checkbox beneath (required); "New vendor or returning?" with "Which stall were you in last season?" when returning.
2. What you sell: category checkboxes (`crafts` shows "special events only"); then product-type checkboxes filtered by the selected categories; per type a sub-section: items (chips, "Add item"), practice checklist, description, detail fields, the `permit_rule` in a bordered note with the permit control (upload / "I will provide this permit before my first market" / "Not required" / "Food Freedom labeled only" as the rule allows) and `prohibited` in red text; above the list: "Vendors must grow, raise, or produce all the items they sell, and all items must be listed here. Items not listed are not approved for sale; mid-season additions need the market manager's approval."
3. Your booth: the map image (`booth_map_url`) above `stall-picker.tsx` (two columns from `stalls` grouped by `row`, north at the top, `food_truck` kind shown between rows, powered stalls marked "power", `usually_taken` greyed with "usually taken", up to 3 picks, numbered); rate radio (Seasonal — "all <market_count> markets, guaranteed weekly space" / Daily — "$<daily> per market"), daily frequency + months, spaces 1 / 2 ("two side-by-side spaces; fees are per space"), electricity, "I intend to pay the season fee in full on acceptance ($<seasonal_paid_in_full> instead of $<seasonal_total>)", live total card from `fees.ts` ("Season total $1,250 — 2 installments" or "$30 per market"), payment methods accepted, "I sell from a food truck or trailer", and the **D32 statement** with its required checkbox: "Each vendor sells only what they grow, raise or produce, from their own booth. Shared or cooperative retail booths are not permitted." Fees are collected on acceptance, not here (say so).
4. Insurance and agreements: "All vendors must carry $1,000,000 in general liability insurance naming KBK-Breck, The WLRFM and ALFN as additional insureds; proof is required before your first market day." radio have / none / need guidance, certificate upload (optional) + carrier + expiry when "have"; link "Insurance information sheet" → `insurance_help_url`; five rule acknowledgements each a required checkbox: rules and regulations (link to `/rules?market=` and `rules_url`, shows `rules_version`), weekly market report, farm or facility visits, marketing use of names/logos/photos/descriptions, products-listed-only; typed signature "Type your full legal name" with the date shown.
5. Review: a read-only summary of every section with "Edit" links; Submit. Success page: "Thank you — your application is in. Pay the $<application_fee> non-refundable application fee here:" button to `fee.url`, "SJCA will review your application and text you at <mobile>."; `clearDraft`. Errors: 409 closed / duplicate texts verbatim from the API; 410 prefill → "This link has expired. You can still apply below." then the blank form.

**`/rules?market=`** renders `RulesView` (`rules_markdown` through markdown-lite, or a link card to `rules_url`), version and updated date; 404 → "The rules for this market are not published yet." **`/agreement?t=`** (layout noindex): `AgreementView` → the Hold Harmless text, business and season, typed name + "I have read and agree" checkbox, Sign; `signed` state shows name/time and "You are all set; the market manager has your signature." 404 "Unknown link", 410 "This link has expired — ask the market manager for a new one." `web/public/wlrfm-vendor-map.jpg` is served as a static asset for the owner to point `booth_map_url` at.

### 4.2 C2 — admin

`web/src/lib/api.ts` additions inside `api` (types from `./types` and `./phase4-types`):
```ts
  // ── Phase 4 (contract §4.2) ──
  getApplicationsV2: (p?: { market_id?: string; season?: string; status?: string; fee?: string; category?: string; returning?: 'true' | 'false'; q?: string }) => request<{ applications: ApplicationListItem[] }>(`/applications${qs(p)}`),
  getApplicationV2: (id: string) => request<{ application: ApplicationDoc; uploads: UploadMeta[]; producer: { id: string; business_name: string } | null; prior_memberships: Membership[] }>(`/applications/${id}`),
  getApplicationUploadUrl: (id: string, uploadId: string) => request<{ url: string; expires_at: string }>(`/applications/${id}/uploads/${uploadId}/url`),
  patchApplication: (id: string, data: ApplicationAction) => request<{ application: ApplicationDoc; producer?: Producer; membership?: Membership; sends?: { sms: string; email: boolean } }>(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  inviteProducer: (id: string, market_id: string, force = false) => request<{ invite: ApplicationInvite; url: string }>(`/producers/${id}/invite${qs({ market_id, force: force ? 'true' : undefined })}`, { method: 'POST' }),
  inviteMarket: (id: string, data: { season?: string; force?: boolean; dry_run?: boolean }) => request<InviteBatchResult>(`/markets/${id}/invite-reapply`, { method: 'POST', body: JSON.stringify(data) }),
  membershipItems: (id: string, data: { action: 'approve' | 'decline'; request_id: string } | { action: 'add'; items: string[] }) => request<{ membership: Membership }>(`/memberships/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updateInsurance: (id: string, data: InsuranceUpdateInput) => request<{ membership: Membership }>(`/memberships/${id}/insurance`, { method: 'PATCH', body: JSON.stringify(data) }),
  sendAgreementLink: (id: string, send = true) => request<{ url: string; expires_at: string; sms: string }>(`/memberships/${id}/agreement-link`, { method: 'POST', body: JSON.stringify({ send }) }),
  getBooths: (marketId: string, includeInactive = false) => request<{ booths: BoothDoc[] }>(`/markets/${marketId}/booths${qs({ include_inactive: includeInactive ? 'true' : undefined })}`),
  createBooth: (marketId: string, data: BoothInput) => request<{ booth: BoothDoc }>(`/markets/${marketId}/booths`, { method: 'POST', body: JSON.stringify(data) }),
  seedBooths: (marketId: string, data: BoothSeedInput) => request<{ created: number; existing: number }>(`/markets/${marketId}/booths/seed`, { method: 'POST', body: JSON.stringify(data) }),
  updateBooth: (marketId: string, boothId: string, data: Partial<BoothInput> & { active?: boolean }) => request<{ booth: BoothDoc }>(`/markets/${marketId}/booths/${boothId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  retireBooth: (marketId: string, boothId: string) => request<{ booth: BoothDoc }>(`/markets/${marketId}/booths/${boothId}`, { method: 'DELETE' }),
  reorderBooths: (marketId: string, rows: { row: string; booth_ids: string[] }[]) => request<{ booths: BoothDoc[] }>(`/markets/${marketId}/booths/reorder`, { method: 'PUT', body: JSON.stringify({ rows }) }),
  draftAssignments: (dateId: string, redraft = false) => request<{ draft: unknown; assignments: AssignmentsView }>(`/market-dates/${dateId}/assignments/draft`, { method: 'POST', body: JSON.stringify({ redraft }) }),
  updateAssignments: (dateId: string, changes: { producer_id: string; booth_ids: string[] }[]) => request<{ assignments: AssignmentsView; warning?: string }>(`/market-dates/${dateId}/assignments`, { method: 'PATCH', body: JSON.stringify({ changes }) }),
  approveAssignments: (dateId: string) => request<{ assignments: AssignmentsView; texts: { attempted: boolean; sent: number; failed: number; excluded: number; deferred_until: string | null } }>(`/market-dates/${dateId}/assignments/approve`, { method: 'POST', body: '{}' }),
```
`updateMarket` keeps its signature; `UpdateMarketInput` (types.ts) gains `season`, `fees`, `payment_links`, `legal`, `booth_map_url`, `categories`, `product_types`. `types.ts` additions: `Market` gains those seven (optional); `Membership` gains `season`, `spaces`, `electric`, `pay_in_full`, `booth_kind`, `trial_period`, `insurance`, `hold_harmless`, `approved_items`, `item_requests`, `application_id`; `FeePlan = 'seasonal' | 'daily'`; `DashboardCard.season`; `MarketDateStatusView.assignments: AssignmentsView`, `next_due.action` gains `'drafts' | 'booth_texts'`; new `ApplicationAction` (the §3.2 union), `ApplicationInvite`, `InviteBatchResult`, `InsuranceUpdateInput`, `BoothInput`, `BoothSeedInput`, `AssignmentsView` (ISO strings). `status-chip.tsx` colours: `withdrawn` grey, `paid` green, `unpaid` amber, `waived` blue, `on_file` green, `missing` amber, `expired` red, `signed` green, `unsigned` amber, `usual` indigo, `suggested` blue, `manual` purple, `seasonal` green, `daily` grey.

Pages: **`/admin/applications`** — filter chips (status tabs incl. withdrawn; fee; category; new/returning; market/season selects; search), table columns Business / Contact / Products / Booth (rate · spaces · power) / Fee / Insurance / Submitted / status; row click → `/admin/applications/detail?id=`. **`/admin/applications/detail`** — `application-view.tsx` renders every section (uploads as "Open" buttons that fetch a signed URL then `window.open`), prior memberships; actions: Start review, Approve… (dialog prefilled from `booth.*`: fee plan, spaces, electric, pay in full, booth kind, usual booth select from `getBooths`, trial period, note, "send acceptance text and email" checkbox; shows the computed total from `fees.ts`), Decline… (reason), Mark fee paid / waived / unpaid (reference), Withdraw, Notes (saved on blur), and after approval a link to the producer plus the `sends` outcome. **`/admin/markets/detail`** gains three `Card`s after "Quiet hours": "Season & fees" (season label, application open/close, schedule version select, the eight fee fields, the two payment links, booth map URL; a "Invite returning vendors…" button → `inviteMarket` with dry-run preview then confirm), "Legal texts" (rules markdown textarea + version + URL, Hold Harmless markdown + version, the three help URLs, SMS consent text + version), "Booths" (`booth-grid.tsx`: two or more columns by row, north at top; per booth: label, power toggle, size, notes, active, up/down reorder; "Add booth" row; "Seed V1–V22 from the WLRFM map" button posting `{ rows: [{ row: 'west', labels: V1..V11 }, { row: 'east', labels: V12..V22 }], food_truck: { label: 'Food truck', row: 'center', order: 8 } }` — the only place the WLRFM layout is spelled out, as data the admin clicks). **`/admin/market-dates`** gains an "Assignments" card after "After the deadline": target date header, Draft / Redraft buttons, the `booth-grid` in read mode with a select per booth (attending producers; a 2-space vendor appears with "(2 spaces)" and selecting them in one booth prompts for the second), unassigned list with reasons, not attending / no answer lists, Approve button (confirm: "Approve and text N vendors their booth?"), booth-text status (sent / deferred until / failed), the `booth` messages. **`/admin/producers/detail`** — memberships grouped by season (current first, past collapsed as history), per membership: fee plan / spaces / electric / pay-in-full / usual booth (select) / trial, insurance block (status, expiry, Open certificate, "Update insurance…"), agreement block (signed name + time or "Not signed" + "Send agreement link"), approved items and item requests with Approve/Decline; profile gains website, social, address, public description, categories, products (read-only table); header action "Invite to re-apply" (copies the URL, shows send outcomes) when the market's current season has no application from this producer.

---

## 5. TESTS (vitest; `fakeDb()`; console providers are structural — never mock `sendSms`; spy on `console.log` for `[sms:console]` / `[email:console]`; mock `../src/middleware/rbac.js` exactly as `tests/applications.test.ts` does; env object as in `tests/phase3-e2e.test.ts`; FAKE names and `+1501555xxxx` phones only; every route test pins the clock)

### 5.1 A1
`seasons.test.ts`: `inferSeasonLabel` — 2026-only version at 2026-09-19 → `'2026'`; 2026+2027 versions (2027 `effective_from` 2027-01-01) at 2026-11-08 → `'2026'`, at 2027-02-01 → `'2027'`; no versions → `'2026'`; explicit label wins; malformed label ignored; `membershipFromData` on a Phase 2 doc → season `'2026'`, `fee_plan 'daily'`, `fee_plan_raw 'weekly'`, spaces 1, insurance missing, hold_harmless null; `normalizeFeePlan` four mappings; `findMembership` picks the season and returns null for an absent one; `insuranceStatusAt` expiry; `listCurrentMemberships` flips when `season.label` is set. `purpose-tokens.test.ts`: mint shape and `max_uses` per purpose; resolve unknown/ok/wrong_purpose/expired/used; `markPurposeTokenUsed` sets `application_id`; `findOpenCheckin` and `resolveCheckinToken` ignore purpose tokens (`'unknown'`). `application-config.test.ts`: config for a market with the 2027 version → `market_count 35`, `start '2027-04-03'`, `end '2027-11-27'`; a skipped date reduces the count; `open_now` inside/outside the window; stalls with `usually_taken`; 404 inactive market. `applications-v2.test.ts`: full valid submission → 201, doc shape (`season_total` for seasonal 2 spaces electric pay-in-full = 600×2+50 = 1250, installments 1; daily = 25×1+5 per market), `sms_consent` recorded with `ip`, `text_version`, `at`; zod rejects: missing consent (400 'Text consent is required'), a false acknowledgement, duplicate product type, `uploaded` without `upload_id`, daily without frequency, 4 stall picks, unknown product type key, permit missing for `dairy`; `food_freedom` accepted for `value_added`, rejected for `dairy`; rules version mismatch 400; closed season 409; duplicate per season 409 while a `declined` one allows a new submission; prefill token links `prefill_producer_id` and increments `uses`; expired token 410; the public response contains no `ip`, no `notes`, no token; queue list item shape and the filters (ONE DB `where`); detail is admin-only (manager 403); approve: producer upsert by email (new and existing), phone conflict 409 with nothing written, membership `create()` with `membershipDocId(...,'2027')`, 2026 row byte-identical before/after, `approved_items` flattened, agreement token minted with `membership_id`, one `acceptance` row keyed `acceptance:<id>` (a second approve attempt 409 and no second text), email printed once, `send: false` sends nothing; decline/withdraw/fee/note transitions and 409 after a terminal status. `application-uploads.test.ts` (with `fakeStorage()` injected via `buildApp({ storage })`): pdf/jpg/png accepted and stored at the §2.4 path with sha256; 11 MB → 413; `.exe` renamed `.pdf` → 415 (magic bytes); 11th upload per draft → 429; signed URL route admin-only, 404 for another application's upload; nothing ever touches `firebase-admin/storage` (`vi.mock` it to throw). `invites.test.ts`: single invite mints an application token, writes `application_invites/<m>_<s>_<p>`, one email print, one `application_invite` row with the §2.12 dedupe key; a second invite → 409 and no sends; `force` resends without a key; bulk: candidates = other-season memberships only, skips producers with a current-season application, counts; no phone → email only; opted out → `skipped_opted_out`. `memberships-seasons.test.ts`: POST defaults `season` to current, 409 on a same-season duplicate, allows a 2027 row beside a 2026 row; PATCH new fields; items approve/decline/add. `producers-seasons.test.ts`: `?market_id&status=active` counts only current-season memberships; detail lists both seasons. `dashboard-seasons.test.ts`: `active_memberships` ignores 2026 rows once `season.label = '2027'`. `inbound-d29.test.ts`: unknown number plain text → inbound row only, zero outbound; HELP → one `help`; STOP → one `opt_out_confirm`; a known producer's flow unchanged. Plus the D29 edits in the two Phase 3 files (§3.6). `fake-storage.ts`: `fakeStorage()` → `{ put, signedReadUrl: async ({ path, expiresInMs }) => \`https://fake-storage.test/${path}?exp=${expiresInMs}\`, delete, dump(): Map<string, { buffer, contentType }> }`.

### 5.2 A2
`booths.test.ts`: create → id `wlrfm_v7`, duplicate label 409, seed creates 23 and skips existing, PATCH rename keeps id, DELETE retires and 409 when a current-season `usual_booth_id` points at it, reorder rewrites rows, manager of another market 403. `booth-assignments.test.ts` (pure `planAssignments`): usual booths first; a 2-space vendor with usual V7 gets V7+V8, with V8 taken gets V7+V6, with both taken gets V7 and `no_pair`; electric vendor only on powered stalls, `no_power_stall` when none free; non-electric vendors avoid powered stalls while others remain; food truck vendor → the `food_truck` booth, `no_food_truck_slot` otherwise; a full house (23 vendors, 22 stalls + truck) → exactly one `full`; `fixed` manual assignments are respected; determinism (same input twice → deep-equal). `assignments-routes.test.ts`: draft → target date = next Saturday, assignments written with `source_date_id`, actions field paths (`actions.checkin_sent_at` untouched), 409 already drafted, redraft supersedes non-manual only, PATCH moves a vendor (old row `superseded_by` set), approve 409 on a double booking, approve sets `approved_at/by` and attempts texts, `in_window` false message; status `assignments` view shape; manager scope. `booth-texts.test.ts`: approve at 10:00 CDT → one `booth` row per producer keyed `booth:<target>:<p>`, 2-space vendor's body contains "V7 and V8", no phone → `excluded`; approve at 22:00 CDT → `deferred_until` next 08:00, no rows; engine tick at 07:59 sends nothing, at 08:00 sends once; three simultaneous ticks → one row per producer, one `workflow_locks/<date>__booth_texts`; two simultaneous approvals → one `approved_at`, `skipped_claimed`/409 for the loser; two simultaneous drafts → one set of assignments. `recipients-season.test.ts`: `listRecipients` with a 2026 and a 2027 membership for the same producer under `season.label='2027'` → recipient iff the 2027 row is active; Phase 3 fixtures unchanged → `'2026'`. `agreements.test.ts`: GET open view, POST signs once (second → 409), writes `hold_harmless` with version/ip/token and flips `approved → active` with a `'producer'` history entry, token `used` → GET shows `signed`, expired → 410, wrong purpose (a checkin token) → 404, no text or email printed. `insurance.test.ts`: transitions missing → on_file (verified_by/at set, expires_at parsed), → waived, `insuranceStatusAt` expired in the status view, agreement-link resend mints a new token and sends one `acceptance`-kind text without a dedupe key, 409 once signed.

### 5.3 C1 / C2
No vitest; the gates are `cd web && npx tsc --noEmit && npm run build`. Each notes file lists the manual checks performed against `npm run dev` + `npm run dev:web`: C1 — a full submission on a 375 px viewport, draft survives reload, prefill from `?t=`, upload progress, the live total matches the server's `season_total`, `/rules`, `/agreement` sign and re-open; C2 — queue filters, approve dialog, booth seed + power flags + reorder, draft/reassign/approve on a date, producer detail per-season view.

### 5.4 Every executor
`npm run typecheck && npm test` green on the branch; `grep -rn "America/Chicago" <your new src files>` prints nothing; no file outside your §1.2 list changed (`git diff --name-only main`); notes file written.

### 5.5 Integrator — `tests/phase4-e2e.test.ts` (after A1 → A2 → C1 → C2), one timeline with `vi.useFakeTimers({ toFake: ['Date'] })`, `buildApp({ db, env, storage: fakeStorage(), notifyOnError: false })`:
seed market with 2026 + 2027 versions, `season: { label: '2027', application_open: '2026-12-01' }`, fees/legal defaults with `hold_harmless_markdown` set, 23 seeded booths with V12–V14 powered, producer p1 with a 2026 membership and no phone, admin1 with a phone → `GET /api/applications/config?market=wlrfm` (35 markets) → admin invites p1 (`application_invites` row, email print, no text) → `GET /prefill/:token` (business name returned) → `POST /uploads` (pdf, draft d1) → `POST /api/applications` with `prefill_token`, dairy + permit upload, seasonal 2 spaces electric pay-in-full (`season_total.total === 1250`), consent → 201 with `fee.url` → queue shows it returning/unpaid → `PATCH approve` (usual booth V12) → producer has `phone` + `sms_consent.opted_in`, membership `p1_wlrfm_2027` `approved`, the 2026 row unchanged, one `acceptance` text containing `/agreement?t=` → `GET/POST /api/agreements/:token` → membership `active`, `hold_harmless.name` → `PATCH fee paid` → generate dates for the 2027 season (`scope: 'season'`), pick D = first Saturday, run the Phase 3 engine through its check-in (link text to p1), p1 texts YES → deadline tick → drafts tick at `drafts_at` (3 days + 1 h) → assignments for the second Saturday: p1 on V12 + V13 (`usual` + neighbour), `drafts_generated_at` set → status view → `POST approve` at a quiet-hours instant → `deferred_until` → tick at the window end → exactly one `booth` row `booth:<target>:p1` whose body contains "V12 and V13" → a later tick and a second approve change nothing (`messages` count stable) → the Phase 3 suite passes unchanged.

---

## 6. OWNER ACTIONS (in this order; nothing texts a producer until step 6)

1. **Backfill** (dry run, then write; from the repo root with the service-account auth used for the Phase 3 verification): `node scripts/backfill-membership-seasons.mjs --market wlrfm --season 2026 --dry-run` → expect `scanned 39 / would update 39`; then `--write`. Readers already default to 2026, so this can also happen after the deploy.
2. **Deploy order:** `npm run deploy:functions` (adds no new functions; `processMarketDates` gains the drafts/booth-texts steps — at deploy time no date is approved, so zero sends), then `npm run deploy:hosting` (`/apply`, `/rules`, `/agreement`, admin pages). Verify `GET /api/applications/config?market=wlrfm` returns 200 with `season.label` still `'2026'` and `open_now: false`.
3. **Storage signed URLs:** open an approved application's upload from the admin page once; if the signed URL fails with a `signBlob`/IAM error, grant the functions runtime service account `roles/iam.serviceAccountTokenCreator` on itself (the A1 notes name the account), then retry. Uploads themselves use the existing `STORAGE_BUCKET`.
4. **Admin → Markets → WLRFM:** (a) Schedule versions → Add: effective from `2027-01-01`, season `2027-04-03` – `2027-11-27`, Saturday, `08:00`–`12:00`; Regenerate dates with scope **season** (expect 35 created). (b) Season & fees: label `2027`, application open/close dates of your choosing (applications are closed until the label is set), schedule version = the 2027 one, fees 15 / 700 / 600 / 2 / 25 / 50 / 5 USD, application fee link and booth fee link `https://www.zeffy.com/en-US/organizations/arkansas-local-food-network`, booth map URL `/wlrfm-vendor-map.jpg`. (c) Legal texts: paste the adopted 2027 rules (markdown) with a version such as `2027-1`, the Hold Harmless text (version `2027-1`), insurance sheet `https://drive.google.com/file/d/1-2v-fWv0ByvmBaah2brOmCY3ZBvwC8KI/view?usp=sharing` (confirm it names The WLRFM for 2027), ADH guidelines `https://healthy.arkansas.gov/wp-content/uploads/FarmersMarketGuidelines-7-28-25.pdf`, Food Freedom guide `https://healthy.arkansas.gov/wp-content/uploads/Homemade-Food-Guide-2025-July.pdf`. (d) Booths: "Seed V1–V22 from the WLRFM map", then flag power on the stalls that reach the power station (V12–V14 end) and the check-in end (V11/V22) — D26 is yours; mark the food-truck slot active only if a truck is expected. Setting the season label to `2027` is the moment the dashboard, check-in texts and booth drafts switch to 2027 memberships (there are none yet); the 2026 season has ended, so nothing is lost.
5. **Test the form** on a phone: `/apply?market=wlrfm` end to end with a test email, confirm the fee link opens Zeffy, approve the test application in `/admin/applications`, sign the agreement from the acceptance text's link (the first real text leaves when you approve with "send" ticked — use your own mobile), then decline/withdraw the test application and set its membership inactive.
6. **Invite the 39 returning producers:** Season & fees → "Invite returning vendors…" → dry run (expect 39 candidates, all `skipped_no_phone` for texts, emails per the importer's addresses) → confirm. Producers without an email appear as `skipped_no_contact`; invite those by hand once you have a contact.
7. Review the practice-checklist wording and product-type permit text against the 2026 Jotform export (they are market data; A1's notes give the PATCH body to edit them) and tell us if the nine types need changing before the first applicants arrive.
