# Phase 3 Contract — SJCA Market Manager (weekly check-in workflow: links, texts, reminders, deadline flagging, STOP/HELP, quiet hours)

Three executors (A workflow engine + public check-in API, B messaging, C web) implement this in parallel on separate branches from `main` (`2308727`) without talking to each other. Every rule below exists so the three branches merge without conflicts and the merged tree passes `npm run typecheck`, `npm test`, `cd web && npx tsc --noEmit` and `cd web && npm run build`. Where this contract and SPEC.md or the Phase 2 contract differ, this contract wins for Phase 3. SPEC §6.3, §6.5, §6.6, §7.2, §7.4, §7.5 are the source it refines; the Phase 2 contract (`docs/phase2-contract.md`) §1.1 rules 1–7 (ownership, byte-identical shared modules, no CHANGELOG/CLAUDE/SPEC edits, the fake-db Firestore envelope, conventions, no `.env`/service-account/`.claude`/survey reads) apply unchanged.

**Deployed reality every executor designs around.** Production Firestore already holds `farmers_markets/wlrfm` (Saturdays 08:00–12:00 America/Chicago, season 2026-04-18..2026-10-31, `workflow` = `DEFAULT_WORKFLOW` `{60, [1440, 2880], 4320, 4380}`, `quiet_hours` = `{21:00, 08:00}`), 23 past `market_dates` (`wlrfm_2026-04-18` … `wlrfm_2026-09-19`, all `status: 'collecting'`, `actions` untouched, `source: 'import'`), 39 producers with `phone: null`, 39 `active` memberships, 508 `checkins` with `source: 'import'`, and `rollMarketDates` adds upcoming Saturdays nightly. The `processMarketDates` scheduler runs every 5 minutes from the moment it deploys. It must never send anything for a date older than 7 days, never send 23 deadline summaries, never text a producer without an E.164 phone, without an `active` membership at that market, or with `sms_opt_out_at` set, and never send a producer-facing text after that date's deadline has passed.

---

## 1. FILE OWNERSHIP MAP

### 1.1 Rules

1. Touch only the paths under your name. Creating a file another executor owns is a merge conflict.
2. **Shared byte-identical modules (two, §1.4):** `src/utils/quiet-hours.ts` (B owns, A copies) and `src/services/open-checkin.ts` (A owns, B copies). Copy the fenced source exactly (file ends with a single `\n`, no formatter run), then `shasum -a 256 <file>` must print the hash above the block.
3. **One shared identical hunk:** both A and B replace the `SmsKind` union in `src/services/sms.ts` with exactly the text in §1.5 and change nothing else in that file. Identical hunks merge cleanly; the post-edit file hash is given so both can verify.
4. Nobody edits `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `docs/SPEC.md`, `docs/MONITORING.md`, `docs/phase2-contract.md`, `package.json`, `package-lock.json`, `firebase.json`, `firestore.indexes.json` (stays `[]` by construction — every new query is one equality filter), `.env.example` (no new env keys in Phase 3), `tests/helpers/fake-db.ts`, `tests/setup/test-mode.ts`, `vitest.config.ts`, `.github/**`. Each executor writes release notes to a NEW file `docs/phase3/notes-<A|B|C>.md` (what you built, what you could not verify, owner actions, deviations).
5. Firestore envelope (Phase 2 §1.1.4): `doc().get/set/set(merge)/update/delete`, `where(field,'==',v)` chains, `limit`, `get()`, `add`. No `orderBy`, `in`, `array-contains`, `batch`, `runTransaction`, `FieldValue`. `update()` replaces top-level fields (so `actions` is always rewritten whole: read → spread → update). All timestamps `new Date()`; readers tolerate Firestore Timestamps and ISO strings via the `toDate` helper in `open-checkin.ts`.
6. Conventions: ESM `.js` suffixes, zod at every route boundary, `snake_case` fields, route plugins registered with a prefix only in `src/app.ts`, no hard-coded day/time/zone/quiet window anywhere (every instant comes from `market.timezone`, `market.workflow`, `market.quiet_hours`).
7. Every branch is green on `npm run typecheck && npm test` on its own (C: `cd web && npx tsc --noEmit && npm run build`). No `@ts-ignore` scaffolds are needed this phase: A's `app.ts` imports only A's files; B's inbound imports only B's files plus its own copy of `open-checkin.ts`.

### 1.2 Ownership

**A — workflow engine, link tokens, public check-in API, staff market-date routes**
- Modifies: `src/app.ts` (register the two new plugins, §4.0), `src/functions.ts` (add `processMarketDates`, §3.1), `src/db/firestore.ts` (documentary `collections` map gains `producers`, `producer_memberships`, `applications`, `checkins`, `link_tokens`), `src/types/schema.ts` (add `CheckinSource`, `LinkTokenPurpose`, `WorkflowActionKey`, §2.7), `src/services/market-dates.ts` (**only** the `MarketDateActions` / `MarketDateDoc` interfaces per §2.2 — no logic change), `src/services/sms.ts` (**only** the §1.5 hunk).
- Creates: `src/routes/checkin-public.ts` (`checkinPublicRoutes`), `src/routes/market-dates.ts` (`marketDateRoutes`), `src/services/link-tokens.ts`, `src/services/checkin-workflow.ts`, `src/services/checkins-submit.ts`, `src/services/open-checkin.ts` (owner, §1.4), `src/utils/quiet-hours.ts` (copy of B's, §1.4), `tests/link-tokens.test.ts`, `tests/checkin-workflow.test.ts`, `tests/checkin-public.test.ts`, `tests/market-dates-routes.test.ts`, `tests/checkins-submit.test.ts`, `docs/phase3/notes-A.md`.

**B — messaging: inbound upgrade, delivery-status endpoint, quiet-hours utility**
- Modifies: `src/services/inbound.ts`, `src/routes/sms.ts` (the `/status` handler only), `src/services/sms.ts` (**only** the §1.5 hunk), `tests/sms-webhook-auth.test.ts` (only if a `REPLIES` wording change requires it — the constants are referenced, so wording changes should not).
- Creates: `src/utils/quiet-hours.ts` (owner, §1.4), `src/services/open-checkin.ts` (copy of A's, §1.4), `tests/quiet-hours.test.ts`, `tests/inbound-checkin.test.ts`, `tests/sms-status.test.ts`, `docs/phase3/notes-B.md`.
- B never edits `src/services/sms.ts` beyond the hunk: any helper B needs lives in `inbound.ts` or `quiet-hours.ts`.

**C — web (`web/src/**` only)**
- Modifies: `web/src/lib/api.ts` (append §6.2 helpers; `request<T>` throws `ApiError` with `.status`), `web/src/lib/types.ts` (§6.3), `web/src/components/status-chip.tsx` (new colours), `web/src/app/admin/markets/detail/page.tsx` (per-date "Check-ins" link + actions glyphs), `web/src/app/admin/page.tsx` ("Collecting: <date>" links to the date page), `web/src/app/admin/producers/detail/page.tsx` (check-in history gains Source / Bringing / Feedback columns and a link per row).
- Creates: `web/src/app/checkin/page.tsx`, `web/src/app/checkin/layout.tsx` (robots noindex), `web/src/app/admin/market-dates/page.tsx`, `web/src/components/checkin-form.tsx`, `docs/phase3/notes-C.md`. No `[param]` folders (Phase 2 §8.1).

### 1.3 Exact module and export names

| Path | Exports | Owner |
|---|---|---|
| `src/routes/checkin-public.ts` | `checkinPublicRoutes` | A |
| `src/routes/market-dates.ts` | `marketDateRoutes` | A |
| `src/services/link-tokens.ts` | `LINK_TOKEN_GRACE_MIN`, `LINK_TOKEN_MAX_USES`, `TOKEN_RE`, `generateToken`, `mintCheckinToken`, `resolveCheckinToken`, `markTokenUsed`, `tokensForDate`, type `LinkTokenDoc` | A |
| `src/services/checkin-workflow.ts` | `processMarketDates`, `computeSchedule`, `listRecipients`, `sendCheckinLink`, `processDeadline`, `sendDeadlineSummary`, `formatLocalStamp`, `TEMPLATES`, `SCAN_WINDOW_MS`, `CLAIM_TTL_MS`, types `EngineResult`, `DateSchedule`, `Recipient`, `ExcludedProducer` | A |
| `src/services/checkins-submit.ts` | `checkinSubmitSchema`, `parseMoney`, `parseCount`, `splitItems`, `validateExtraAnswers`, `upsertFormCheckin`, `toFormValues`, types `CheckinSubmitInput`, `CheckinFormValues` | A |
| `src/services/open-checkin.ts` | `CHECKIN_PATH`, `checkinUrl`, `toDate`, `findOpenCheckin`, `staffForMarket`, `recordAttendingNext`, types `OpenCheckin`, `StaffContact`, `AttendingNextResult` | A (B copies) |
| `src/utils/quiet-hours.ts` | `minutesOfDay`, `isQuiet`, `nextAllowedInstant`, type `QuietHours` | B (A copies) |
| `src/services/inbound.ts` | `handleInboundText` (signature unchanged), `STOP_KEYWORDS`, `START_KEYWORDS`, `HELP_KEYWORDS`, `YES_KEYWORDS`, `NO_KEYWORDS`, `REPLIES`, `normalizeKeyword` | B |
| `src/functions.ts` | `api`, `processReminders`, `rollMarketDates`, **`processMarketDates`** | A |

### 1.4 Shared modules (complete sources; copy verbatim)

**`src/utils/quiet-hours.ts`** — B owns, A copies. sha256 `6bc96097823460541df4c217dcfdf26792756ce37f50db30f367cf57b400af34`, 62 lines, ends with one `\n`. Verified against the repo's compiler options (strict, ES2022, bundler) and the assertions in §7.2.

```ts
/**
 * Quiet-hours deferral (SPEC §6.5): an automated text whose instant falls
 * inside a market's quiet window is deferred to the window's end, computed
 * in the market's own timezone. Pure functions, no I/O.
 *
 * SHARED VERBATIM: executor B owns this file; executor A copies it
 * byte-for-byte. Do not reformat or extend it here.
 *
 * `quietHours` is the market's `{ start: 'HH:mm', end: 'HH:mm' }`. When
 * `end < start` the window wraps midnight (21:00 → 08:00); when
 * `end === start` there is no quiet window at all. The interval is half-open:
 * the start minute is quiet, the end minute is allowed.
 *
 * DST: the window end is resolved with `localToUtc`, so on the spring-forward
 * night an end time inside the 02:00–03:00 gap resolves to the later instant
 * and on the fall-back night an end time inside the repeated 01:00–02:00 hour
 * resolves to its first occurrence. A deferral that crosses a transition is
 * therefore one real hour shorter (spring) or longer (fall) than the wall
 * clock suggests, which is what "no texts before 08:00 local" means.
 */
import { addDays, localToUtc, parseTime, utcToLocalDate, wallClock } from './tz.js';

export interface QuietHours {
  start: string;
  end: string;
}

/** Minutes since local midnight of an 'HH:mm' time; throws on bad input. */
export function minutesOfDay(time: string): number {
  const { hh, mm } = parseTime(time);
  return hh * 60 + mm;
}

/** True when the instant's market-local wall clock is inside the quiet window. */
export function isQuiet(instant: Date, quietHours: QuietHours, timeZone: string): boolean {
  const s = minutesOfDay(quietHours.start);
  const e = minutesOfDay(quietHours.end);
  if (s === e) return false;
  const w = wallClock(instant, timeZone);
  const t = w.hh * 60 + w.mm;
  if (s < e) return t >= s && t < e;
  return t >= s || t < e;
}

/**
 * The first instant at or after `instant` that is outside the quiet window:
 * `instant` itself when it is not quiet, otherwise the window's end. A
 * wrapped window entered before midnight ends on the next local date; every
 * other case ends on the instant's own local date. Never returns an instant
 * earlier than the input.
 */
export function nextAllowedInstant(instant: Date, quietHours: QuietHours, timeZone: string): Date {
  if (!isQuiet(instant, quietHours, timeZone)) return instant;
  const s = minutesOfDay(quietHours.start);
  const e = minutesOfDay(quietHours.end);
  const w = wallClock(instant, timeZone);
  const t = w.hh * 60 + w.mm;
  const today = utcToLocalDate(instant, timeZone);
  const endDate = s > e && t >= s ? addDays(today, 1) : today;
  const end = localToUtc(endDate, quietHours.end, timeZone);
  return end.getTime() > instant.getTime() ? end : instant;
}
```

**`src/services/open-checkin.ts`** — A owns, B copies. sha256 `7b93c44eef72e36cd229a0f8337acedc10c48ec115bde2232e9c03ef144c2715`, 164 lines, ends with one `\n`. Verified: typechecks; against `fake-db` it returns the newest valid token whose date is `collecting` (ignoring expired, exhausted and `lineup_final` dates), filters staff correctly, and writes/updates the minimal check-in.

```ts
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Producer-side check-in lookups shared by the workflow engine and the staff
 * routes (executor A) and by the inbound text handler (executor B).
 *
 * SHARED VERBATIM: executor A owns this file; executor B copies it
 * byte-for-byte. Do not reformat or extend it here — put extensions in your
 * own module and import from this one.
 *
 * Firestore access stays inside the fake-db envelope (Phase 2 contract
 * §1.1.4): one equality filter per query, everything else in memory.
 */

export const CHECKIN_PATH = '/checkin';

/** The no-login link a producer receives: `${APP_URL}/checkin?t=<token>`. */
export function checkinUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}${CHECKIN_PATH}?t=${encodeURIComponent(token)}`;
}

/** Date | Firestore Timestamp | ISO string → Date (null when absent or invalid). */
export function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value as { toDate?: () => Date };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface OpenCheckin {
  /** The link token (= the `link_tokens` doc id). */
  token: string;
  producer_id: string;
  market_id: string;
  market_date_id: string;
  expires_at: Date;
  created_at: Date | null;
}

/**
 * The producer's most recently minted, still-valid `checkin` link token whose
 * market date is still `collecting`, or null. Valid = purpose 'checkin',
 * `expires_at > now`, `uses < max_uses`. One query on `producer_id`, then at
 * most one `market_dates` read per distinct candidate date.
 */
export async function findOpenCheckin(db: Firestore, producerId: string, now: Date): Promise<OpenCheckin | null> {
  const snap = await db.collection('link_tokens').where('producer_id', '==', producerId).get();
  const candidates: OpenCheckin[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (d.purpose !== 'checkin') continue;
    const expires = toDate(d.expires_at);
    if (!expires || expires.getTime() <= now.getTime()) continue;
    const uses = typeof d.uses === 'number' ? d.uses : 0;
    const maxUses = typeof d.max_uses === 'number' ? d.max_uses : Number.POSITIVE_INFINITY;
    if (uses >= maxUses) continue;
    candidates.push({
      token: doc.id,
      producer_id: String(d.producer_id ?? ''),
      market_id: String(d.market_id ?? ''),
      market_date_id: String(d.market_date_id ?? ''),
      expires_at: expires,
      created_at: toDate(d.created_at),
    });
  }
  candidates.sort((a, b) => (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0));

  const collecting = new Map<string, boolean>();
  for (const c of candidates) {
    let ok = collecting.get(c.market_date_id);
    if (ok === undefined) {
      const dateDoc = await db.collection('market_dates').doc(c.market_date_id).get();
      ok = dateDoc.exists && (dateDoc.data() as Record<string, unknown> | undefined)?.status === 'collecting';
      collecting.set(c.market_date_id, ok);
    }
    if (ok) return c;
  }
  return null;
}

export interface StaffContact {
  user_id: string;
  name: string;
  phone: string;
  role: string;
}

/**
 * Staff who receive texts about a market: `users` with role 'admin', or
 * 'market_manager' with the market in `assigned_market_ids`; active (absent
 * = true); with a phone; not opted out. Sorted by user id for stable order.
 */
export async function staffForMarket(db: Firestore, marketId: string): Promise<StaffContact[]> {
  const snap = await db.collection('users').get();
  const out: StaffContact[] = [];
  for (const doc of snap.docs) {
    const u = doc.data() as Record<string, unknown>;
    if (u.active === false) continue;
    if (u.sms_opt_out_at) continue;
    const phone = typeof u.phone === 'string' ? u.phone.trim() : '';
    if (!phone) continue;
    const role = String(u.role ?? '');
    const assigned = Array.isArray(u.assigned_market_ids) ? (u.assigned_market_ids as unknown[]) : [];
    const eligible = role === 'admin' || (role === 'market_manager' && assigned.includes(marketId));
    if (!eligible) continue;
    out.push({ user_id: doc.id, name: String(u.name ?? ''), phone, role });
  }
  return out.sort((a, b) => a.user_id.localeCompare(b.user_id));
}

export interface AttendingNextResult {
  checkin_id: string;
  created: boolean;
}

/**
 * Record a YES/NO answer texted by a producer. Creates a minimal
 * `source: 'sms'` check-in (every §2.6 field present, empty) when none exists
 * for the date, otherwise only updates `attending_next` on the existing one.
 */
export async function recordAttendingNext(
  db: Firestore,
  open: OpenCheckin,
  attending: boolean,
  raw: string,
  now: Date,
): Promise<AttendingNextResult> {
  const id = `${open.market_date_id}_${open.producer_id}`;
  const ref = db.collection('checkins').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    await ref.update({ attending_next: attending, attending_next_raw: raw, updated_at: now });
    return { checkin_id: id, created: false };
  }
  await ref.set({
    producer_id: open.producer_id,
    market_id: open.market_id,
    market_date_id: open.market_date_id,
    submitted_at: now,
    source: 'sms',
    token_id: open.token,
    estimated_sales: { value: null, raw: '', kind: 'none' },
    transactions_estimate: { value: null, raw: '' },
    sold_out_items: [],
    sold_out_raw: '',
    unsold_items: [],
    unsold_raw: '',
    attending_next: attending,
    attending_next_raw: raw,
    bringing_next: [],
    bringing_next_raw: '',
    feedback: '',
    extra_answers: {},
    flags: [],
    raw_import: null,
    submissions: 1,
    partial: true,
    created_at: now,
    updated_at: now,
  });
  return { checkin_id: id, created: true };
}
```

### 1.5 The shared `sms.ts` hunk (A and B apply identically; nothing else in the file changes)

`src/services/sms.ts` before: sha256 `bc85465d78cc4ade1af32dde911b2472eca0533a4e2ccffd2a0dde52a0efff89`. Replace the two lines
```ts
  | 'checkin'
  | 'booth';
```
with
```ts
  | 'checkin'
  | 'booth'
  // Phase 3 (contract §2.6): the check-in workflow and the inbound upgrade.
  | 'checkin_link'
  | 'checkin_reminder'
  | 'deadline_summary'
  | 'forwarded_inbound';
```
After: sha256 `a484b7b62d9c16ccbcae44f1001ef2acdaf2961ae1e5e9ad157f2c0f5aeca360` (typechecks; `tests/messaging.test.ts` unaffected).

### 1.6 MERGE ORDER (the integrator, not an executor)

Merge **A → B → C**, from `main`, running `npm run typecheck && npm test` after **each** merge and fixing forward before the next one; after C also `cd web && npx tsc --noEmit && npm run build`.

Why this order: A's `src/app.ts` registrations depend only on A's own files (`routes/checkin-public.ts`, `routes/market-dates.ts`, the services, A's copies of the two shared modules) and on the `SmsKind` hunk A carries itself, so A alone must boot (`tests/app-boot.test.ts` now exercises the full route list — a duplicate route or missing export shows up here, isolated from B). B then adds identical files (`quiet-hours.ts`, `open-checkin.ts`) and the identical `sms.ts` hunk — git resolves identical additions and identical hunks without conflict — plus `inbound.ts` and `routes/sms.ts`, which A never touches; B's inbound behaviour depends on `link_tokens` rows A's engine produces, so the integration test in §7.5 is meaningful only once A is in. C touches `web/src/**` only and depends on A's routes at runtime, never at compile time, so it goes last and its `next build` is the final gate.

Integrator checklist after the three merges: (1) `shasum -a 256 src/utils/quiet-hours.ts src/services/open-checkin.ts src/services/sms.ts` = the three hashes above; if git reported add/add on a shared module, keep the copy matching the hash. (2) Write and run `tests/phase3-e2e.test.ts` (§7.5). (3) `grep -rn "America/Chicago" src/services/checkin-workflow.ts src/services/inbound.ts src/utils/quiet-hours.ts` must print nothing. (4) Fold `docs/phase3/notes-*.md` into `CHANGELOG.md`, update CLAUDE.md's status/repo map and SPEC status. (5) Owner actions §8 before `npm run deploy:functions` / `deploy:hosting`.

---

## 2. DATA (extends Phase 2 §2; types: Timestamp stored as `new Date()`, `'YYYY-MM-DD'`, `'HH:mm'`)

### 2.1 `link_tokens` — doc id = the token (43 chars base64url)

| Field | Type | Notes |
|---|---|---|
| `token` | string req | equals the doc id; `crypto.randomBytes(32).toString('base64url')`; matches `TOKEN_RE = /^[A-Za-z0-9_-]{43}$/` |
| `purpose` | `'checkin'` req | the only purpose in Phase 3 |
| `producer_id`, `market_id`, `market_date_id` | string req | |
| `expires_at` | Timestamp req | `deadline_at + LINK_TOKEN_GRACE_MIN` minutes, `LINK_TOKEN_GRACE_MIN = 4320` (3 days of late submissions; late responses stay `non_responders` at the deadline but are visible as "responded late") |
| `used_at` | Timestamp\|null req | last successful POST |
| `uses` | number req | successful POSTs; GET never counts |
| `max_uses` | number req | `LINK_TOKEN_MAX_USES = 25`; re-openable until expiry, latest submission wins; `uses >= max_uses` → 410 |
| `created_at` | Timestamp req | |
| `created_by` | string req | `'engine'`, or the staff user id for a resend |
| `sent_message_id` | string\|null req | the `messages` row id of the text that carried it (null until sent / when the send failed) |

Never mints a session: `link-tokens.ts`, `checkin-public.ts` and `checkins-submit.ts` must not import `src/utils/jwt.ts` (test-enforced, §7.1). A resend mints a fresh token and leaves older tokens valid (an old text still works).

### 2.2 `market_dates` additions (A edits the interfaces in `src/services/market-dates.ts`; the generator's spread `{ ...existing.actions, deadline_at }` preserves every new key)

```ts
export interface ReminderSent { offset_min: number; sent_at: Date; recipients: number; failed: number; skipped: 'superseded' | null }
export interface MarketDateActions {
  checkin_sent_at: Date | null;
  reminders_sent: ReminderSent[];            // Phase 2 declared Timestamp[]; no production doc has an entry, so the shape changes here
  deadline_at: Date;                          // informational since Phase 2; the engine recomputes from end_at + workflow (§3.3)
  deadline_processed_at: Date | null;
  drafts_generated_at: Date | null;           // Phase 6; the Phase 3 hook never sets it
  approved_at: Date | null;
  booth_texts_sent_at: Date | null;
  // Phase 3 — absent on every existing doc; readers default them
  checkin_recipients?: number; checkin_failed?: number;
  summary_sent_at?: Date | null;
  summary_skipped?: 'no_recipients' | 'notify_false' | null;
  claims?: Record<string, Date>;              // keys: 'checkin' | `reminder_${offset_min}` | 'deadline' | 'summary'
}
export interface MarketDateDoc { …existing…; non_responders?: string[]; spot_not_held?: string[]; deadline_recipient_count?: number; deadline_responded_count?: number }
```
`isDateDecided` is unchanged (claims never count; `checkin_sent_at` and `reminders_sent.length` still do).

### 2.3 `checkins` written by the form / by text (id `${market_date_id}_${producer_id}`, same as import)

Every field of Phase 2 §2.6 is always present, plus: `source: 'form' | 'sms'` (`'import'` stays for imported rows), `token_id: string` (the token used), `submissions: number` (incremented on every overwrite), `partial: boolean` (true only for a text-created check-in that no form submission has replaced), `raw_import: null`, `flags: string[]` (`'sales_outlier'` when value > 20000, `'transactions_ambiguous'`), `created_at` preserved across overwrites, `updated_at = submitted_at = now` on each submission. `estimated_sales` is parsed exactly as the importer does (§4.1 rules) and stays admin-only in every staff response (existing `checkinRoutes` strips it; the public token endpoint returns it only to the producer who typed it, as raw text).

### 2.4 `messages.kind` values added: `'checkin_link'` (`producer_id`, `market_date_id`, `extra: { token }`), `'checkin_reminder'` (`producer_id`, `market_date_id`, `extra: { token, offset_min }` — `offset_min` is the per-recipient dedupe key), `'deadline_summary'` (`user_id`, `market_date_id`), `'forwarded_inbound'` (`user_id` = the staff recipient, `producer_id`, `extra: { inbound_message_id }`). `status` is terminal at `'sent'` for voip.ms (§5.4).

### 2.5 `farmers_markets.workflow` and `quiet_hours` — exactly SPEC §6.5 / Phase 2 §2.1; no new fields. Defaults `DEFAULT_WORKFLOW = { checkin_offset_min: 60, reminder_offsets_min: [1440, 2880], deadline_offset_min: 4320, drafts_offset_min: 4380 }`, `DEFAULT_QUIET_HOURS = { start: '21:00', end: '08:00' }`; a market doc missing either field is read with these defaults. Offsets are minutes from `market_date.end_at`. A reminder offset ≥ `deadline_offset_min` is never sent (the deadline has passed by then); the status endpoint reports it as `unreachable`.

### 2.6 `producers` touched by B: STOP sets `sms_opt_out_at: now` and `sms_consent: { status: 'opted_out', at: now, source: 'sms' }`; START clears `sms_opt_out_at` and sets `sms_consent: { status: 'opted_in', at: now, source: 'sms' }`. Phase 3 does **not** require `sms_consent.status === 'opted_in'` to send (imported producers are `unknown`; an admin-added phone is the consent event for now) — recorded as a decision the owner may tighten.

### 2.7 `src/types/schema.ts` (A): `export type CheckinSource = 'form' | 'import' | 'sms'; export type LinkTokenPurpose = 'checkin'; export type WorkflowActionKey = 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts';`

---

## 3. THE ENGINE (A, `src/services/checkin-workflow.ts`)

### 3.1 Scheduler (A, `src/functions.ts`)
```ts
export const processMarketDates = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Chicago', timeoutSeconds: 300 },   // the zone only anchors the cron
  async () => {
    const db = getDb(); const env = getEnv();
    try {
      const { processMarketDates: run } = await import('./services/checkin-workflow.js');
      const r = await run(db, env);
      console.log(`processMarketDates: scanned=${r.scanned} considered=${r.considered} checkin_sent=${r.checkin_sent} reminders_sent=${r.reminders_sent} deadlines=${r.deadlines_processed} summaries=${r.summaries_sent} claimed=${r.skipped_claimed} errors=${r.errors.length}`);
      if (r.errors.length > 0) { const { notifyError } = await import('./services/error-notify.js'); await notifyError({ env, err: new Error(r.errors.join('\n')), source: 'scheduler:processMarketDates' }).catch(() => {}); }
    } catch (err) { const { notifyError } = await import('./services/error-notify.js'); await notifyError({ env, err, source: 'scheduler:processMarketDates' }).catch(() => {}); throw err; }
  },
);
```

### 3.2 Signatures
```ts
export const SCAN_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const CLAIM_TTL_MS = 10 * 60_000;
export interface EngineResult { scanned: number; considered: number; checkin_sent: number; reminders_sent: number; deadlines_processed: number; summaries_sent: number; skipped_claimed: number; errors: string[] }
export async function processMarketDates(db: Firestore, env: Env, opts?: { now?: Date }): Promise<EngineResult>
export interface DateSchedule { checkin_at: Date; checkin_effective_at: Date; reminders: { offset_min: number; at: Date; effective_at: Date; reachable: boolean }[]; deadline_at: Date; summary_effective_at: Date; drafts_at: Date }
export function computeSchedule(market: FarmersMarket, date: MarketDateDoc): DateSchedule           // pure
export interface Recipient { producer_id: string; business_name: string; contact_name: string; phone: string }
export interface ExcludedProducer { producer_id: string; business_name: string; reason: 'no_phone' | 'invalid_phone' | 'opted_out' | 'inactive_producer' }
export async function listRecipients(db: Firestore, marketId: string): Promise<{ recipients: Recipient[]; excluded: ExcludedProducer[] }>
export async function sendCheckinLink(db, env, market, date, recipient, opts: { now: Date; kind: 'checkin_link' | 'checkin_reminder'; offset_min?: number; created_by: string; sent_by?: string | null }): Promise<{ token: string; message_id: string | null; status: 'sent' | 'simulated' | 'failed'; error?: string }>
export async function processDeadline(db, env, market, date, opts: { now: Date; notify: boolean; actor: string }): Promise<{ recipients: number; responded: number; non_responders: string[]; summary: 'sent' | 'skipped_no_recipients' | 'skipped_notify_false' | 'failed' }>
export async function sendDeadlineSummary(db, env, market, date, stats, opts: { now: Date }): Promise<{ sms: number; email: boolean }>
export function formatLocalStamp(instant: Date, timeZone: string): string      // 'Tue Sep 22, 12:00 PM' (wallClock from tz.ts; Sun..Sat, Jan..Dec, 12-hour, market-local)
```

### 3.3 Algorithm (one run, `now = opts.now ?? new Date()`)
1. `markets` = one `farmers_markets.get()`, indexed by id (workflow/quiet_hours defaulted per §2.5).
2. `snap = market_dates.where('status','==','collecting').get()` — the ONE equality filter. `scanned = snap.size`. Keep in memory only docs with `now − SCAN_WINDOW_MS ≤ end_at ≤ now` whose market exists and is `active`. Older `collecting` dates are ignored forever by this engine (the `close` route is the admin's tool for them); future dates wait. `considered` = kept count.
3. For each kept date (sequentially, each inside its own try/catch that pushes `"${date.id}: ${message}"` to `errors` and continues):
   - `schedule = computeSchedule(market, date)`: `checkin_at = end_at + checkin_offset_min`, `reminders[i].at = end_at + reminder_offsets_min[i]` (sorted ascending, deduped), `deadline_at = end_at + deadline_offset_min` (**recomputed from the market's current workflow, not read from `actions.deadline_at`** — an offset edit takes effect on the next run), `drafts_at = end_at + drafts_offset_min`; every `*_effective_at = nextAllowedInstant(at, market.quiet_hours, market.timezone)` (deadline processing itself is not a send and is never deferred; `summary_effective_at = nextAllowedInstant(deadline_at, …)` defers only the staff text); `reachable = at < deadline_at`.
   - `deadlinePassed = schedule.deadline_at ≤ now`.
   - **Check-in send** is due iff `checkin_effective_at ≤ now && !actions.checkin_sent_at && !deadlinePassed`. Run through `claim(dateRef, 'checkin')` (§3.4). Body: `recipients, excluded = listRecipients`; `sent = messages.where('market_date_id','==',date.id).get()` indexed by `(producer_id, kind, extra.offset_min)` for rows with status `queued|sent|simulated`; for each recipient lacking a `checkin_link` row: `sendCheckinLink(..., kind: 'checkin_link', created_by: 'engine')` (mint token → `sendSms` via `trySendSms` → `link_tokens.update({ sent_message_id })`). Then `update({ actions: { ...fresh.actions, checkin_sent_at: now, checkin_recipients, checkin_failed }, updated_at: now })` — set even when `recipients.length === 0` (zero sends, but the date is marked handled). Failures are not retried by the engine; the resend button exists.
   - **Reminders**: a reminder `r` is due iff `r.reachable && r.effective_at ≤ now && actions.checkin_sent_at != null && r.at > actions.checkin_sent_at && !deadlinePassed && no reminders_sent entry with r.offset_min`. If `checkin_sent_at != null && r.at ≤ checkin_sent_at` (the check-in text went out late, after this slot) → append `{ offset_min, sent_at: now, recipients: 0, failed: 0, skipped: 'superseded' }` without sending. When several reminders are due in one run, send only the latest-due one and mark the earlier ones `superseded`. Sending (under `claim('reminder_<offset>')`): recipients = `listRecipients` minus producers with any `checkins` doc for the date (`checkins.where('market_date_id','==',date.id)`; a `source: 'sms'` partial check-in counts as a response — the producer already answered the question that holds the spot); per recipient skip if a `checkin_reminder` row with that `offset_min` exists; reuse the producer's newest unexpired token for the date (`tokensForDate`) or mint one; send `TEMPLATES.checkin_reminder`. Append the `ReminderSent` entry.
   - **Deadline** is due iff `schedule.deadline_at ≤ now && !actions.deadline_processed_at`. Under `claim('deadline')`: `processDeadline(notify: true)` — `recipients = listRecipients`, `responded = recipients with a checkins doc`, `non_responders = recipients without one` (producer ids, sorted), `spot_not_held = non_responders`; `update({ non_responders, spot_not_held, deadline_recipient_count, deadline_responded_count, actions: { ...fresh.actions, deadline_processed_at: now, …(recipients.length === 0 ? { summary_sent_at: null, summary_skipped: 'no_recipients' } : {}) }, updated_at: now })`.
   - **Summary** is due iff `actions.deadline_processed_at != null && actions.summary_sent_at == null && actions.summary_skipped == null && schedule.summary_effective_at ≤ now`. Under `claim('summary')`: ONE `sendDeadlineSummary`: `TEMPLATES.deadline_summary` via `trySendSms` to every `staffForMarket(db, market.id)` phone (`kind: 'deadline_summary'`, `user_id`, `market_date_id`), and one `sendEmail({ to: env.ALERT_EMAIL, subject, message })` when `env.ALERT_EMAIL` is non-empty (wrapped in try/catch; a `SendsDisabledError` is logged, not fatal). Then `summary_sent_at: now`. Rule from §2: a date with zero recipients gets no summary at all (`summary_skipped: 'no_recipients'`) — this is what keeps the 23 imported dates and any phone-less market silent.
   - **Drafts hook**: `if (schedule.drafts_at ≤ now && !actions.drafts_generated_at) generateDrafts(/* Phase 6 */)` — a no-op stub that returns `'not_implemented'` and **never sets the flag**.
4. Return the counts. No date is ever cancelled, re-timed or status-changed by the engine.

### 3.4 Idempotency across overlapping runs — `claim(dateRef, key, now, doneCheck, fn)`
```
fresh = await dateRef.get()                      // always a fresh read, never the scan snapshot
actions = normalizeActions(fresh.actions)        // defaults for absent Phase 3 keys
if doneCheck(actions) → return 'done'
claimedAt = actions.claims?.[key]; if claimedAt && now − claimedAt < CLAIM_TTL_MS → skipped_claimed++; return 'claimed'
await dateRef.update({ actions: { ...actions, claims: { ...(actions.claims ?? {}), [key]: now } }, updated_at: now })
await fn()                                       // sends; each recipient additionally deduped against existing messages rows
```
The `*_sent_at`/`*_processed_at` flag is written by `fn` **after** the sends from a re-read `actions`. A run that dies mid-loop leaves a claim younger than 10 minutes, so the next two ticks skip the date; the third re-enters and the per-recipient `messages` dedupe (which counts `queued` rows too) guarantees nobody is texted twice. Claims are never cleared.

### 3.5 Recipients — `listRecipients(db, marketId)`
`producer_memberships.where('market_id','==',marketId)` → keep `status === 'active'`; one `producers.get()` indexed by id; a producer is a recipient iff the doc exists, `active !== false`, `phone` matches `/^\+[1-9]\d{6,14}$/`, and `!sms_opt_out_at`. Everything else lands in `excluded` with a reason (`no_phone` when null/empty, `invalid_phone`, `opted_out`, `inactive_producer`). Recipients sorted by `business_name`. A producer in two markets gets one text per market date (SPEC §6.6).

### 3.6 First production run (worked example, deploy on 2026-09-22)
Scanned: 23 imported dates + the upcoming Saturdays. Considered: only `wlrfm_2026-09-19` (end 2026-09-19T17:00Z is within 7 days); the 22 older ones are ignored, futures wait. For 09-19: check-in due only if its deadline (2026-09-22T17:00Z) has not passed — if deployed after 12:00 CT Tuesday, nothing producer-facing is sent, ever; deadline processing runs with 0 recipients (no phones) → `non_responders: []`, `summary_skipped: 'no_recipients'`, no text, no email. If deployed before the deadline: check-in "send" to 0 recipients sets `checkin_sent_at`; reminders superseded or 0 recipients; same silent deadline. Net effect on production at deploy time: **zero sends**. The first real text goes to the first producer the owner gives a phone to (§8).

### 3.7 Message templates (`TEMPLATES` in `checkin-workflow.ts`; pure ASCII so the splitter keeps GSM-7; measured with the repo's `splitMessage`: worst case 40-char market name + 20-char first name = 258 chars = 2 segments; the link is 73 chars: `https://farmlink.us/checkin?t=` + 43)

`first_name` = first whitespace token of `contact_name`, max 20 chars, omitted (and its comma) when empty. `deadline_label = formatLocalStamp(deadline_at, tz)`. `link = checkinUrl(env.APP_URL, token)`.

- **checkin_link** (234 chars typical): `SJCA Markets: thanks for selling at ${market_name}, ${first_name}! Please complete your weekly check-in by ${deadline_label}: ${link}\nReply STOP to opt out.`
- **checkin_reminder** (236): `SJCA Markets reminder: your ${market_name} check-in is due by ${deadline_label}. Spots are not held without a check-in: ${link}\nReply STOP to opt out.`
- **deadline_summary** to staff (≤ 300 chars, 2 segments): `SJCA Markets: ${market_name} check-in deadline passed for ${date_short}. ${responded} of ${recipients} responded. No response: ${names}. Details: ${admin_link}` where `date_short = 'Sat Sep 19'`, `admin_link = ${APP_URL}/admin/market-dates?id=${date.id}`, and `names` = non-responder business names joined by `, `, added greedily while the whole body stays ≤ 300 chars, then `, +N more`; when `non_responders` is empty the sentence is `Everyone responded.` and the `No response:` clause is omitted.
- **deadline_summary email**: subject `[SJCA Markets] ${market_name} check-in deadline: ${responded}/${recipients} responded (${date_short})`; message (newlines become `<br>`): market, date, deadline label, then three lists — Responded (business name + attending next Yes/No/unknown), No response (spots not held), Excluded (name + reason) — then the admin link. No sales figures in any text or email.

Nothing in these texts promises a call-back, a held spot, or a follow-up.

---

## 4. ROUTES

### 4.0 `src/app.ts` (A) — after `checkinRoutes`:
```ts
import { checkinPublicRoutes } from './routes/checkin-public.js';
import { marketDateRoutes } from './routes/market-dates.js';
…
await app.register(checkinPublicRoutes, { prefix: '/api/checkin' });
await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
```
Everything existing stays unchanged (`/api/checkins` read-only routes included).

### 4.1 Public check-in (A, `checkinPublicRoutes`, prefix `/api/checkin`)

| Method | Path | Auth | Request (zod) | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/:token` | public; `config: { rateLimit: { max: 60, timeWindow: '1 minute' } }` | param must match `TOKEN_RE` else 404 | 200 `{ producer_name, contact_name, market_id, market_name, market_date_id, date, date_label, start_time, end_time, deadline_at, deadline_label, past_deadline, expires_at, questions: { extra_questions: ExtraQuestion[] }, existing: (CheckinFormValues & { submitted_at, source, partial }) \| null }`; 404 `{ error: 'Unknown link' }` (no doc / regex fail); 410 `{ error: 'This link has expired' }` (`expires_at ≤ now`, `uses ≥ max_uses`, market date missing or `cancelled`) | no |
| POST | `/:token` | public; `config: { rateLimit: { max: 30, timeWindow: '1 hour' } }` | `checkinSubmitSchema` (below); 400 on zod / unknown extra key / bad choice | 200 `{ ok: true, checkin: CheckinFormValues & { submitted_at, submissions } }`; 404 / 410 as GET | no (producers are not admins; the `checkins` doc and `link_tokens.uses` are the record) |

```ts
export const checkinSubmitSchema = z.object({
  attending_next: z.boolean(),
  bringing_next: z.string().trim().max(1000).default(''),
  sold_out: z.string().trim().max(1000).default(''),
  unsold: z.string().trim().max(1000).default(''),
  estimated_sales: z.string().trim().max(50).default(''),
  transactions_estimate: z.string().trim().max(50).default(''),
  feedback: z.string().trim().max(2000).default(''),
  extra_answers: z.record(z.union([z.string().trim().max(1000), z.boolean()])).default({}),
});
export type CheckinSubmitInput = z.infer<typeof checkinSubmitSchema>;
export interface CheckinFormValues { attending_next: boolean | null; bringing_next: string; sold_out: string; unsold: string; estimated_sales: string; transactions_estimate: string; feedback: string; extra_answers: Record<string, string | boolean> }
```
Parsing in `checkins-submit.ts` (identical rules to the importer, Phase 2 §7): `parseMoney(raw)` strips `$ , spaces`; `^\d+(\.\d+)?$` → `{ value, kind: 'exact' }`; `^\d+(\.\d+)?\s*[-–to]+\s*\d+(\.\d+)?$` → midpoint `'range'`; else `{ value: null, kind: 'none' }`; value > 20000 → flag `sales_outlier`. `parseCount(raw)`: first integer, `ambiguous` when more than one → flag `transactions_ambiguous`. `splitItems(raw)`: split on `/[,;\n]|\band\b/i`, trim, drop empties and `/^(no|none|nope|nothing|n\/?a|-|no\.)$/i`. `validateExtraAnswers(date.extra_questions, answers)`: keys must exist in the date's questions (400 `extra_answers.<key>: unknown question`), `choice` values ∈ options, `yes_no` must be boolean, `text` must be string; missing answers are allowed. `upsertFormCheckin` writes the full §2.3 shape with `source: 'form'`, `partial: false`, `submissions: (existing?.submissions ?? 0) + 1`, `created_at: existing?.created_at ?? now`; then `markTokenUsed` (`uses + 1`, `used_at: now`, read-modify-write). `toFormValues(checkin)` maps a stored doc back to `CheckinFormValues` using the `_raw` fields. Responses never include a JWT, a cookie, or the token.

### 4.2 Staff market-date routes (A, `marketDateRoutes`, prefix `/api/market-dates`; auth = `authenticate(app)` + `requireStaff()`, then the handler loads `market_dates/:id` → 404, then `canAccessMarket(user, date.market_id)` → 403 — the memberships-PATCH pattern)

| Method | Path | Auth | Request | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/:id/status` | staff (market-scoped) | — | `MarketDateStatus` (below) | no |
| POST | `/:id/resend-checkin` | staff (market-scoped) | query `{ producer_id: z.string().min(1) }` (400 without); 404 unknown producer; 409 `{ error, reason }` when the producer is not an eligible recipient (`no_phone`/`invalid_phone`/`opted_out`/`inactive_producer`/`no_active_membership`), when `date.status !== 'collecting'`, or when `deadline_at + LINK_TOKEN_GRACE_MIN ≤ now` | 200 `{ sms: { status: 'sent'\|'simulated'\|'failed', error? }, token_expires_at, message_id }` — mints a fresh token, sends `TEMPLATES.checkin_link` with `kind: 'checkin_link'`, `sent_by: user.id`, `created_by: user.id`; works before the engine's own send too | yes `market_date.checkin.resend` (target `market_dates/:id`, `after: { producer_id, message_id, status }`) |
| POST | `/:id/close` | **admin** | `{ notify: z.boolean().default(false) }`; 409 unless `status === 'collecting' && end_at < now && !actions.deadline_processed_at` | 200 `{ result: ReturnType<processDeadline>, date: MarketDate }` — runs `processDeadline({ notify, actor: user.id })`: flags + lists always; the summary only when `notify` (sent immediately, no quiet-hours deferral — it is a manual admin act); with `notify: false` sets `summary_skipped: 'notify_false'` | yes `market_date.close` (`after: { non_responders, notify }`) |

```ts
export interface MarketDateStatus {
  date: MarketDate;                                   // full doc incl. actions, non_responders, spot_not_held
  market: { id: string; name: string; timezone: string; workflow: Workflow; quiet_hours: QuietHours };
  schedule: { checkin_at: string; checkin_effective_at: string; reminders: { offset_min: number; at: string; effective_at: string; reachable: boolean }[]; deadline_at: string; summary_effective_at: string };
  next_due: { action: 'checkin' | 'reminder' | 'deadline' | 'summary' | 'none'; at: string | null; offset_min?: number };
  in_window: boolean;                                 // end_at within the engine's 7-day scan window
  recipients: { producer_id: string; business_name: string; contact_name: string; phone: string; responded: boolean; late: boolean; checkin: { submitted_at: string; source: CheckinSource; partial: boolean; attending_next: boolean | null } | null; link_sent_at: string | null; link_sends: number; reminders_sent: number; last_status: 'sent' | 'simulated' | 'failed' | 'queued' | null; token_expires_at: string | null }[];
  excluded: { producer_id: string; business_name: string; reason: ExcludedProducer['reason'] }[];
  counts: { recipients: number; responded: number; non_responders: number; excluded: number };
  messages: { id: string; kind: string; to: string; producer_id: string | null; user_id: string | null; status: string; segments: number; created_at: string }[];   // this date's checkin_link / checkin_reminder / deadline_summary rows, newest first
}
```
`late` = responded after `deadline_processed_at` (still listed in `non_responders`). Queries: `checkins.where('market_date_id','==',id)`, `messages.where('market_date_id','==',id)`, `link_tokens.where('market_date_id','==',id)`, plus `listRecipients`.

---

## 5. MESSAGING (B)

### 5.1 `src/services/inbound.ts` — handler order (signature of `handleInboundText` unchanged)
1. Log the inbound row exactly as today (`kind: 'inbound'`, `status: 'received'`, `segments: 1`). Keep its id as `inboundMessageId`.
2. Lookups: `users.where('phone','==',from).limit(1)` (as today) and `producers.where('phone','==',from).limit(1)`. `keyword = normalizeKeyword(body)` = `body.trim().toUpperCase().replace(/[.!?,\s]+$/, '')`.
3. **STOP** keywords: update the user (as today) **and** the producer per §2.6; reply `REPLIES.unsubscribed` (`opt_out_confirm`). **START**: clear both; reply `REPLIES.resubscribed` (`opt_in_confirm`). These always reply, even to unknown numbers (carrier norm, as today).
4. If a producer matched: `open = await findOpenCheckin(db, producer.id, now)` (from B's copy of `open-checkin.ts`); when `open`, `link = checkinUrl(env.APP_URL, open.token)` and `market = farmers_markets/<open.market_id>` (name only).
   - **HELP**: reply `REPLIES.help_with_link(market_name, link)` when `open`, else `REPLIES.help` (`kind: 'help'`).
   - **YES** (`YES_KEYWORDS = new Set(['YES','Y','YEAH','YEP','YUP'])`) / **NO** (`NO_KEYWORDS = new Set(['NO','N','NOPE','NAH'])`) **with `open`**: `recordAttendingNext(db, open, true|false, body.trim(), now)`; reply `REPLIES.attending_yes(market_name, link)` / `REPLIES.attending_no(market_name, link)` (`kind: 'auto_reply'`, `producer_id`, `market_date_id: open.market_date_id`). Without an open check-in, YES/NO fall through to forwarding.
   - **Anything else from a known producer**: forward once per inbound to `staffForMarket(db, open?.market_id ?? firstActiveMembershipMarketId ?? '')` (`producer_memberships.where('producer_id','==',producer.id)` → first `active`, sorted by market_id), skipping a staff phone equal to `from`: body `Text from ${producer.business_name} (${market_name}): ${body}` (omit ` (${market_name})` when no market is known; truncate the total body to 300 chars with `…` → use ASCII `...`), `kind: 'forwarded_inbound'`, `user_id: staff.user_id`, `producer_id`, `extra: { inbound_message_id: inboundMessageId }`; each via `trySendSms`, failures logged. Then the courtesy reply at most once per 24 h: if `producer.sms_opt_out_at` → nothing; else if `repliedRecently(db, from, now)` → nothing; else reply `REPLIES.received_with_link(link)` when `open` else `REPLIES.received` (`kind: 'auto_reply'`).
5. **Unknown numbers** (no producer): today's behaviour unchanged — opted-out user → silent; `repliedRecently` → silent; else `REPLIES.closed` (`auto_reply`).

`repliedRecently` refinement: counts only outbound rows with `kind === 'auto_reply'` and status `sent|simulated` within 24 h (a check-in link or a forwarded text must not suppress the acknowledgement). Every existing test in `tests/sms-webhook-auth.test.ts` seeds `auto_reply` rows and keeps passing.

`REPLIES` (all pure ASCII; `link` is 73 chars; every body ≤ 2 GSM-7 segments at a 40-char market name — measured):
```ts
export const REPLIES = {
  unsubscribed: "You're unsubscribed from SJCA Markets texts. Reply START to resubscribe.",
  resubscribed: "You're resubscribed to SJCA Markets texts.",
  help: 'SJCA Markets: farmers market texts from St. Joseph Center of Arkansas. Reply STOP to opt out, START to rejoin.',
  help_with_link: (market: string, link: string) => `SJCA Markets: your ${market} check-in link is ${link}\nReply STOP to opt out.`,
  attending_yes: (market: string, link: string) => `Got it - you're marked as attending the next ${market}. Please add what you're bringing and the rest of your check-in here: ${link}`,
  attending_no: (market: string, link: string) => `Got it - you're marked as not attending the next ${market}. You can change that here: ${link}`,
  received: 'Thanks - your message has been passed to SJCA Markets staff.',
  received_with_link: (link: string) => `Thanks - your message has been passed to SJCA Markets staff. Your check-in link: ${link}`,
  closed: "Thanks. FarmLink's ordering service has closed and is becoming the SJCA farmers market manager. A team member will follow up.",   // unchanged: unknown numbers keep today's behaviour
} as const;
```

### 5.2 `src/utils/quiet-hours.ts` — B owns the file in §1.4 and `tests/quiet-hours.test.ts` (§7.2). B does not add a quiet-hours helper to `sms.ts`.

### 5.3 Delivery status — finding and design
voip.ms's SMS API offers `sendSMS` (returns only an `sms` id — see `src/services/voipms.ts`), `getSMS`/`deleteSMS` and a per-DID **inbound** "SMS URL Callback" (GET with `id, date, from, to, message`, expecting `ok`, retried every 30 minutes otherwise). There is **no outbound delivery-receipt callback**: the wiki documents callbacks for received messages only, and third-party voip.ms integrations poll `getSMS` for their own view of sent messages rather than receiving DLRs. Sources: [SMS-MMS — VoIP.ms Wiki](https://wiki.voip.ms/article/SMS-MMS), [SMS — VoIP.ms Wiki (beta)](https://wikibeta.voip.ms/article/SMS), [matrisms (voip.ms bridge that polls getSMS)](https://github.com/Leicas/matrisms).

Consequence (documented in `notes-B.md` and as a comment in `sms.ts`'s status enum context): **`messages.status` is terminal at `'sent'` for the voip.ms provider** — it means "accepted by voip.ms", not "delivered to the handset"; `'delivered'` and post-send `'failed'` are reserved for a future provider. `POST /api/sms/status` stays registered as a **documented no-op**: it accepts any body, writes nothing (an unauthenticated endpoint must not mutate `messages` by provider id), logs `sms/status callback received (no provider supports delivery receipts)` at info level, and returns 200 `{ ok: true, updated: false }`. When a provider with DLRs arrives, the endpoint gets that provider's signature check and a `provider_message_id` lookup; the shape `{ ok, updated }` is fixed now so the future change is additive.

### 5.4 Producer STOP and the engine
The engine reads `producers.sms_opt_out_at` on every send (§3.5), so a STOP takes effect on the next tick; a STOP after the check-in text still stops reminders. START re-enables. B records both on `sms_consent` (§2.6).

---

## 6. WEB (C, `web/src/**`)

### 6.1 Pages
- **`/checkin?t=<token>`** — `web/src/app/checkin/page.tsx` (`'use client'`, `useSearchParams().get('t')` inside `<Suspense>`), `web/src/app/checkin/layout.tsx` exporting `metadata = { title: 'Weekly check-in — SJCA Markets', robots: { index: false, follow: false } }`. Mobile-first single column, max width 560, no `<Header>` (no Log in button for producers): a slim top bar with the SJCA Markets wordmark and the existing "Text (501) 753-6622" `smsHref` link, and the same link in the footer ("Prefer to text? Reply to our message or text us"). Loads `api.getCheckinByToken(t)`; shows `producer_name`, `market_name`, `weekdayLabel(date), formatDateLabel(date)`, and "Due by {deadline_label}" (or "The deadline was {deadline_label} — you can still send your answers" when `past_deadline`). `<CheckinForm>` (`web/src/components/checkin-form.tsx`, props `{ questions, initial: CheckinFormValues | null, submitting, onSubmit(values) }`) renders, in this order: **Are you attending next {market_name}?** (two large radio buttons Yes / No, required — submit disabled until chosen); **What are you bringing next time?** (textarea); **What sold out?** (textarea); **What did not sell?** (textarea); **Estimated total sales** (text, inputmode decimal, placeholder `$`, hint exactly `SJCA staff only, reported in aggregate`); **About how many transactions?** (text, inputmode numeric); **Anything else SJCA should know?** (textarea); then each `extra_questions` entry by type — `text` → textarea, `choice` → radio group of `options`, `yes_no` → Yes/No radios (boolean). Submit → `api.submitCheckin(t, values)` → thank-you card: "Thanks, {producer_name} — your check-in for {date label} is saved." + "Need to change something? Open this link again before {deadline_label}." + text-us link. Errors: `ApiError.status === 404` → "We don't recognise this link. Text us at (501) 753-6622 and we'll help."; `410` → "This link has expired. Text us at (501) 753-6622 if you still need to check in."; other → the message inline. No login, no auth context use (the global `AuthProvider` is harmless: it only calls `/auth/me` when a staff token is stored). Numbers/dates are rendered from the API's market-local strings — never from browser timezone math.
- **`/admin/market-dates?id=<market_date_id>`** — `web/src/app/admin/market-dates/page.tsx` (staff guard, `<Suspense>`): header `{weekday}, {date} · {market name}` with `StatusChip(date.status)` and "Back to market" (`/admin/markets/detail?id=`). Sections: **Timeline** (cards for Check-in text / each Reminder (offset shown as "1 day after", "2 days after") / Deadline / Staff summary: each shows scheduled (`at`), effective (`effective_at`, with a "deferred by quiet hours" note when different), and done/pending/skipped/superseded/unreachable state from `actions`; plus `next_due`; a warning when `!in_window && !deadline_processed_at`: "This date is older than the automatic window — close it by hand."); **Recipients** table: business name (link to producer detail), phone, responded chip (`responded` / `no_response` / `late`), submitted, attending next, link sent (count + last status chip), reminders, "Resend check-in link" `ConfirmButton` → `api.resendCheckin(id, producer_id)` → toast with `sms.status`; **Excluded** table (name, reason in words: "no phone number", "invalid phone", "opted out", "inactive producer"); **After the deadline**: counts, `non_responders` / `spot_not_held` lists (chips `spot_not_held`); **Messages** table (kind, to, status chip, when). Admin-only "Close date" `ConfirmButton` (shown when `status === 'collecting' && end_at < now && !deadline_processed_at`) with a "Text the summary to staff" checkbox → `api.closeMarketDate(id, { notify })`. Every write re-fetches the status.
- **`/admin/markets/detail`**: each date row gains a "Check-ins" link to `/admin/market-dates?id=${d.id}` and small glyphs for `checkin_sent_at` (✓ link), `reminders_sent.length`, `deadline_processed_at` (✓ deadline). **`/admin`**: "Collecting: <date>" becomes a link to the same page. **`/admin/producers/detail`**: the check-ins table gains Source (`form`/`sms`/`import` chip; `partial` shown as "text only"), Bringing and Feedback columns; the market-day cell links to `/admin/market-dates?id=${c.market_date_id}`.
- Header nav unchanged.

### 6.2 `web/src/lib/api.ts` (append; `request<T>` now throws `ApiError` — `export class ApiError extends Error { constructor(message: string, readonly status: number) }` — with `res.status`, everything else unchanged)
```ts
getCheckinByToken: (t: string) => request<CheckinTokenView>(`/checkin/${encodeURIComponent(t)}`),
submitCheckin: (t: string, data: CheckinSubmitInput) => request<{ ok: true; checkin: CheckinFormValues & { submitted_at: string; submissions: number } }>(`/checkin/${encodeURIComponent(t)}`, { method: 'POST', body: JSON.stringify(data) }),
getMarketDateStatus: (id: string) => request<MarketDateStatus>(`/market-dates/${encodeURIComponent(id)}/status`),
resendCheckin: (id: string, producer_id: string) => request<{ sms: SmsOutcome; token_expires_at: string; message_id: string | null }>(`/market-dates/${encodeURIComponent(id)}/resend-checkin${qs({ producer_id })}`, { method: 'POST' }),
closeMarketDate: (id: string, data: { notify: boolean }) => request<{ result: CloseResult; date: MarketDate }>(`/market-dates/${encodeURIComponent(id)}/close`, { method: 'POST', body: JSON.stringify(data) }),
```

### 6.3 `web/src/lib/types.ts` (append / amend)
`MarketDateActions` → `reminders_sent: ReminderSent[]` (`{ offset_min: number; sent_at: string; recipients: number; failed: number; skipped: 'superseded' | null }`) plus optional `checkin_recipients`, `checkin_failed`, `summary_sent_at`, `summary_skipped`, `claims?: Record<string, string>`; `MarketDate` gains optional `non_responders`, `spot_not_held`, `deadline_recipient_count`, `deadline_responded_count`; `Checkin.source: 'form' | 'import' | 'sms'`, optional `submissions`, `partial`; new `CheckinSource`, `CheckinFormValues`, `CheckinSubmitInput` (the §4.1 body), `CheckinTokenView` (the §4.1 GET 200 shape), `MarketDateStatus` (§4.2, ISO strings), `CloseResult = { recipients: number; responded: number; non_responders: string[]; summary: 'sent' | 'skipped_no_recipients' | 'skipped_notify_false' | 'failed' }`. `status-chip.tsx` gains `responded` (green), `no_response` (amber), `late` (blue), `spot_not_held` (red), `form`/`sms`/`import` (neutral greys), `deferred`/`pending` (grey), `done` (green), `superseded`/`unreachable` (grey).

---

## 7. TESTS (vitest; `fakeDb()`; console providers are structural — never mock `sendSms`; spy on `console.log` for `[sms:console]` / `[email:console]`; engine and routes take an injected `now`; env object `{ NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false', APP_URL: 'https://test.example', VOIPMS_DID: '5015550999', ALERT_EMAIL: 'alerts@example.com', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test' } as Env`; FAKE names and `+1501555xxxx` phones only)

Fixtures every A test reuses (define once in the test file): WLRFM as in `tests/market-dates.test.ts`; `wlrfm_2026-09-19` (`end_at 2026-09-19T17:00:00Z`, `status: 'collecting'`, Phase 2 `actions`); a Thursday market `argenta` 17:00–20:00 with date `argenta_2026-09-17` (`end_at 2026-09-18T01:00:00Z`); producers `p1` (phone `+15015550101`), `p2` (`+15015550102`), `p3` (`phone: null`), `p4` (phone, `sms_opt_out_at` set), `p5` (phone, membership `inactive`), `p6` (phone, `active: false`); memberships accordingly; users `admin1` (phone), `mgr_w` (`market_manager`, `['wlrfm']`, phone), `mgr_a` (`['argenta']`, phone), `nophone` (admin, no phone).

### 7.1 A
`tests/checkin-workflow.test.ts`:
1. **Saturday timeline** — run at `2026-09-19T17:59Z` → nothing; `18:00Z` → exactly 2 `checkin_link` rows (p1, p2; never p3–p6), 2 `link_tokens` (`expires_at = 2026-09-25T17:00Z`, `created_by: 'engine'`, `sent_message_id` set), body contains `/checkin?t=` and `by Sat Sep 22` is NOT present but `Tue Sep 22, 12:00 PM` is, `actions.checkin_sent_at` set, `checkin_recipients: 2`, `claims.checkin` set; run again `18:01Z` → no new rows. Seed a `checkins` doc for p1; run `2026-09-20T17:00Z` → one `checkin_reminder` (p2, `extra.offset_min 1440`, reuses p2's token), `reminders_sent[0] = { offset_min: 1440, recipients: 1, … }`; `2026-09-21T17:00Z` → offset 2880 to p2 only; `2026-09-22T17:00Z` → `deadline_processed_at`, `non_responders: ['p2']`, `spot_not_held: ['p2']`, `deadline_recipient_count: 2`, `deadline_responded_count: 1`, exactly 2 `deadline_summary` rows (admin1, mgr_w — never mgr_a or nophone) whose body contains `1 of 2 responded` and p2's business name, exactly one `[email:console]` log to `alerts@example.com`, `summary_sent_at` set; run again → nothing new. Total outbound rows at the end: 6.
2. **Thursday timeline from the same code** — `2026-09-18T02:00Z` (21:00 local, quiet) → nothing; `2026-09-18T13:00Z` → check-in texts; `2026-09-19T01:00Z` → reminder 1440 (20:00 local, allowed); `2026-09-21T01:00Z` → deadline + summary to admin1 and mgr_a only. `computeSchedule` for this date returns `checkin_at 2026-09-18T02:00Z`, `checkin_effective_at 2026-09-18T13:00Z`, `deadline_at 2026-09-21T01:00Z`.
3. **Late deploy supersedes reminders** — Saturday date, first run at `2026-09-21T12:00Z`: check-in texts go out (deadline not passed), `reminders_sent` has both offsets with `skipped: 'superseded'`, no reminder rows.
4. **After the deadline nothing producer-facing is sent** — untouched Saturday date, first run at `2026-09-22T18:00Z`: zero `checkin_link`/`checkin_reminder` rows, `checkin_sent_at` stays null, deadline processed, summary sent (recipients 2, responded 0).
5. **Past-date guard** — `wlrfm_2026-03-21` collecting, run at `2026-09-21T12:00Z`: zero outbound rows, doc deep-equal before/after, `considered: 0`, `scanned: 1`.
6. **Zero recipients = silence** — the 39-phoneless situation: memberships active but every producer `phone: null`; run through the whole timeline: no outbound rows, no email, `checkin_sent_at` set with `checkin_recipients: 0`, `deadline_processed_at` set, `summary_skipped: 'no_recipients'`, `summary_sent_at: null`.
7. **Exclusions** — `listRecipients` returns `[p1, p2]` and `excluded` with reasons `no_phone` (p3), `opted_out` (p4), `inactive_producer` (p6); p5 absent from both (membership inactive); a producer with `phone: '501-555-0107'` → `invalid_phone`.
8. **Idempotency across overlapping runs** — seed `actions.claims.checkin = now − 3 min`, run → `skipped_claimed: 1`, no rows; set the claim to `now − 11 min` and seed one `checkin_link` row for p1 (`status: 'queued'`) → run sends only to p2. Same for `claims.deadline` (no second summary).
9. **Inactive market / cancelled date** — `farmers_markets.active: false` → considered 0; `status: 'cancelled'` never scanned.
10. **Templates** — every `TEMPLATES.*` body with a 40-char market name and a 20-char first name has `splitMessage(body).length ≤ 2` and matches `/^[\x20-\x7e\n]*$/`; the summary with 12 long non-responder names stays ≤ 300 chars and ends with `, +N more. Details: …`.

`tests/link-tokens.test.ts`: `generateToken()` matches `TOKEN_RE` and 1000 tokens are unique; `mintCheckinToken` writes the §2.1 shape with `uses: 0`, `max_uses: 25`; `resolveCheckinToken`: unknown → `unknown`, `expires_at ≤ now` → `expired/expired`, `uses ≥ max_uses` → `expired/exhausted`, date `cancelled` → `expired/date_cancelled`, missing date → `expired/date_missing`; `markTokenUsed` increments; `tokensForDate` returns the newest unexpired per producer.

`tests/checkin-public.test.ts` (routes on a bare Fastify with `createErrorHandler({ env, notify: false })`): GET unknown → 404 `{ error: 'Unknown link' }`; malformed param (`abc`) → 404; expired → 410; valid → 200 with `producer_name`, `market_name`, `date_label: 'Saturday, Sep 19, 2026'`, `deadline_label: 'Tue Sep 22, 12:00 PM'`, `questions.extra_questions` from the date, `existing: null`; POST valid body → 200, `checkins/wlrfm_2026-09-19_p1` has `source: 'form'`, `token_id`, `estimated_sales { value: 750, raw: '500-1000', kind: 'range' }`, `transactions_estimate.value 29` + flag `transactions_ambiguous` for `'29 cards, 5 Cash App'`, `sold_out_items ['tomatoes','eggs']` from `'tomatoes, eggs'`, `attending_next true`, `extra_answers` kept, `submissions 1`, `partial false`; `link_tokens.uses 1`; **resubmission overwrites** (second POST → same doc id, new values, `submissions 2`, `created_at` unchanged, `uses 2`) and GET now returns `existing` with the second values; unknown extra key → 400; choice outside options → 400; `attending_next` missing → 400; POST to an expired token → 410 and no write; `uses` at `max_uses` → 410; a `source: 'sms'` partial doc is overwritten by the form with `partial: false`; **no JWT minted**: no response has a `token`/`jwt` key or a `set-cookie` header, and (structural) the source of `src/routes/checkin-public.ts`, `src/services/checkins-submit.ts`, `src/services/link-tokens.ts` contains no `jwt.js` import.

`tests/market-dates-routes.test.ts` (rbac mocked as in `tests/checkins.test.ts`): status 401/403/404 rules (`mgr_a` on a wlrfm date → 403); status shape after the Saturday timeline (`counts`, `next_due.action: 'none'`, recipient rows with `link_sends`, `responded`); resend → new token, `checkin_link` row with `sent_by`, audit `market_date.checkin.resend`; resend to p3 → 409 `reason: 'no_phone'`; resend after grace → 409; close as manager → 403; close on a future date → 409; close on `wlrfm_2026-03-21` with `notify: false` → flags written, no rows, audit `market_date.close`; with `notify: true` → summary rows.

`tests/checkins-submit.test.ts`: the parser table (`$1,000.00` → 1000 exact; `500-1000` → 750 range; `N/a` → null none; `$45,690.00` → flag; `80ish` → 80; none → null; `splitItems('No.')` → `[]`).

### 7.2 B
`tests/quiet-hours.test.ts` (America/Chicago unless stated; window `21:00`–`08:00`): `isQuiet` at 20:59 false, 21:00 true, 00:30 true, 07:59 true, 08:00 false; `nextAllowedInstant(2026-09-17 22:40 local = 2026-09-18T03:40Z) = 2026-09-18T13:00Z`; `2026-09-18 00:30 local → 2026-09-18T13:00Z`; allowed instants return the same `Date` value; **DST week**: `2026-03-07 22:40 CST (2026-03-08T04:40Z) → 2026-03-08T13:00Z` (8 h 20 m real), `2026-03-08 01:30 CST (07:30Z) → 13:00Z`, `2026-10-31 22:40 CDT (2026-11-01T03:40Z) → 2026-11-01T14:00Z` (10 h 20 m real); same-day window `12:00`–`14:00`: 12:30 → 14:00 same date, 14:00 allowed; empty window `08:00`–`08:00` never quiet; `America/New_York` 22:40 → next 08:00 in that zone (13:00Z in September); bad `'25:00'` throws.

`tests/inbound-checkin.test.ts` (route built as in `tests/sms-webhook-auth.test.ts`; seed producer `Testfield Farm` phone `+15015550100`, market wlrfm, date `wlrfm_2026-09-19` collecting, a valid `link_tokens` doc, staff admin1/mgr_w/mgr_a with phones): `YES` → `checkins/wlrfm_2026-09-19_<p>` created with `source: 'sms'`, `attending_next: true`, `partial: true`; one outbound `auto_reply` whose body contains `/checkin?t=<token>` and `attending the next West Little Rock Farmers Market`; `no thanks` → false, `attending_next_raw: 'no thanks'`; `YES` when a form check-in exists → only `attending_next` changes; `HELP` → `help` row containing the link; `help` without a token → `REPLIES.help`; `running late today` → exactly 2 `forwarded_inbound` rows (admin1, mgr_w; never mgr_a) with body `Text from Testfield Farm (West Little Rock Farmers Market): running late today`, `extra.inbound_message_id` = the inbound row id, plus 1 `auto_reply` = `REPLIES.received_with_link(link)`; a second free text 5 min later → 2 more forwards, no second `auto_reply`; a check-in link row sent 1 h earlier does **not** suppress the acknowledgement; `YES` with an expired token → forwarded, not recorded; producer with a phone but no token and no membership → forwarded to admins only, `REPLIES.received`; `STOP` from a producer → `producers.<id>.sms_opt_out_at` set, `sms_consent.status 'opted_out'`, confirmation sent; then `hello` → forwarded, no courtesy reply; `START` → cleared, `opted_in`; unknown number → exactly today's behaviour (`REPLIES.closed` once per 24 h, STOP confirmation); the real-provider gate and 200-on-failure cases from the existing file hold for the new kinds (voipms mock throws → forward row `failed`, webhook still 200).

`tests/sms-status.test.ts`: `POST /status` with `{}` , with a JSON delivery-report-shaped body, and with a form body → 200 `{ ok: true, updated: false }`; `db.dump('messages')` unchanged; a seeded `sent` row stays `sent`.

### 7.3 C
`cd web && npx tsc --noEmit` clean; `npm run build` output has no `ƒ` (dynamic) routes and lists `/checkin` and `/admin/market-dates` as static; no `[` folder under `web/src/app`; every `useSearchParams` usage is inside a `<Suspense>` page; `grep -rn "toLocale\|getTimezoneOffset" web/src/app/checkin web/src/app/admin/market-dates` prints nothing (labels come from the API); `grep -n "SJCA staff only, reported in aggregate" web/src/components/checkin-form.tsx` matches.

### 7.4 Every executor
`npm run typecheck && npm test` green on the branch alone; the existing 186 tests untouched except as §1.2 allows.

### 7.5 Integrator — `tests/phase3-e2e.test.ts` (after the A → B → C merges)
Boot `buildApp({ db: fakeDb(seed), env })`; run `processMarketDates` at `2026-09-19T18:00Z` → read the token from p1's `checkin_link` row; `GET /api/checkin/<token>` → 200 `existing: null`; inject the voip.ms webhook `from=5015550101&message=YES` → check-in `source: 'sms'`; `GET /api/checkin/<token>` → `existing.attending_next: true`, `partial: true`; `POST /api/checkin/<token>` with a full body → `partial: false`; run the engine at `2026-09-20T17:00Z` → reminder to p2 only; at `2026-09-22T17:00Z` → `non_responders: ['p2']`, summary rows to staff; `GET /api/market-dates/wlrfm_2026-09-19/status` as admin → `counts { recipients: 2, responded: 1, non_responders: 1 }`; `POST /api/sms/status` → `{ ok: true, updated: false }`.

---

## 8. OWNER ACTIONS (to demo Phase 3 in production)

1. **Before deploying functions**, confirm `.env.arkansaslocalfoodnetwork` carries `APP_URL=https://farmlink.us` (every texted link is built from it — the code default is `http://localhost:3001`) and `ALERT_EMAIL=<the inbox that should get deadline summaries>`. No new keys are needed. `firebase login --reauth` and `gcloud auth login` (done), then `npm run deploy:functions` (creates `processMarketDates` and its Cloud Scheduler job — verify with `gcloud scheduler jobs list --location us-central1`) and `npm run deploy:hosting` (ships `/checkin` and `/admin/market-dates`). Deploy order: functions first (the web page needs the routes), hosting second.
2. **What happens on the first tick** (§3.6): nothing is sent. The only date in the 7-day window is `wlrfm_2026-09-19`, whose recipients are zero because no producer has a phone. Check `/admin/market-dates?id=wlrfm_2026-09-19` afterwards: it should show `deadline processed`, `summary skipped: no recipients`, 0 messages. The 22 older imported dates stay untouched and show "older than the automatic window" — leave them; do not Close them (a Close with the summary box unticked is harmless but pointless).
3. **Give one test producer a phone**: open `/admin/producers`, pick a producer you control (or create "SJCA Test Farm" with your own mobile), set Phone in E.164 (`+1501…`), make sure its WLRFM membership is `active`. Check the dashboard shows real providers (no "Test mode" banner) — `GET /api/admin/providers` must say `voipms` / `resend` / `allow_real_sends: true`.
4. **Watch a real Saturday**: on 2026-09-26 the check-in text arrives at 13:00 CT (12:00 close + 60 min), reminders on Sunday and Monday at 12:00 CT if you do not respond, the deadline summary Tuesday 12:00 CT to every admin/manager phone and to `ALERT_EMAIL`. Reply `YES`, `HELP` and free text to the SMS number to exercise the inbound paths (the voip.ms inbound webhook is live, still unauthenticated pending S7). Reply `STOP` and confirm the reminders stop; `START` to resume.
5. **To test outside a real Saturday** (any weekday, before 21:00 CT so quiet hours do not defer): in `/admin/markets/detail?id=wlrfm` → Special dates add today with `start_time` = now − 1 h and `end_time` = now + 10 min (note "Phase 3 demo") → Save → "Regenerate window" (the date appears as `collecting`). In Workflow offsets set Check-in `1`, Reminder offsets `[4]`, Deadline `8`, Drafts `9` → Save. Within ~5–10 minutes after the end time the scheduler texts the link; do not respond and the reminder follows ~4 minutes after close, the deadline summary ~8 minutes after close (each within the 5-minute tick granularity). Open `/admin/market-dates?id=wlrfm_<today>` and use "Resend check-in link" on the test producer to see the manual path. **Afterwards restore** the workflow to `60 / [1440, 2880] / 4320 / 4380` and remove the special date (the demo date stays as frozen history; cancel it with a reason if you prefer it hidden).
6. **Quiet hours**: WLRFM keeps `21:00`–`08:00`; to see a deferral, run the step-5 demo after 21:00 CT and observe the link arrives at 08:00 the next morning (the status page shows the effective time in advance).
7. **Still pending from earlier phases**: the voip.ms portal callback secret (S7) and D15 page-2 application fields. Producers other than your test one remain silent until you add their phones deliberately (each addition is the consent event recorded on the producer; Phase 3 does not require `opted_in` — tighten this when SJCA has a written opt-in flow).
