# Phase 2 Contract — SJCA Market Manager (markets, producers, applications, roles, test mode, importer)

Five executors (A1, A2, B, C, D) implement this in parallel on separate branches from `main` (`3843a4d`) without talking to each other. Every rule below exists so the five branches merge without conflicts and the merged tree passes `npm run typecheck`, `npm test` and `cd web && npx tsc --noEmit`. Where this contract and SPEC.md differ, this contract wins for Phase 2; SPEC §6.3–6.5, §7.1–7.3, §7.9 are the source it refines.

## 1. FILE OWNERSHIP MAP

### 1.1 Rules that apply to everyone

1. **Touch only the paths listed under your name.** Creating a file another executor owns is a merge conflict. If you need something from another executor, it is defined in this contract — code against the contract, not against their branch.
2. **Shared byte-identical modules.** Four leaf modules are created by two executors each, from the complete sources in §6 (identity) and §1.4 (tz, market-scope, audit). Copy the fenced block exactly (file ends with a single `\n`, no formatter run), then verify with `shasum -a 256 <file>` against the hash printed above each block. Git auto-merges identical additions; a hash mismatch means you changed something — fix it before you finish.
3. **No executor edits** `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `docs/SPEC.md`, `docs/MONITORING.md`, `package-lock.json`. Each executor writes its release notes to a NEW file `docs/phase2/notes-<A1|A2|B|C|D>.md` (what you built, what you could not, owner actions). The integrator folds them into CHANGELOG/SPEC after the merge.
4. **Firestore operations allowed in production code** are exactly what `tests/helpers/fake-db.ts` supports today, because every executor's tests run against it and only D may extend it (§1.6): `collection(name).doc(id).get() | .set(data) | .set(data, {merge:true}) | .update(data) | .delete()`, `collection(name).where(field, '==', value)` (chainable, any number of equality filters), `.limit(n)`, `.get()`, `.add(data)`. No `orderBy`, `in`, `array-contains`, `batch()`, `runTransaction`, `FieldValue`, `count()`. Filter and sort in memory (`src/utils/sort.ts`). One equality filter at the DB is the repo convention and keeps `firestore.indexes.json` empty — nobody edits that file.
5. **Conventions** (CLAUDE.md): ESM imports with `.js` suffixes; zod at every route boundary via `schema.parse(request.body)` (the global handler turns ZodError into 400); ids `uuid` v4 unless this contract fixes the id; fields `snake_case`; timestamps `new Date()`; route plugins registered with a prefix only in `src/app.ts`; no hard-coded market day/time/timezone anywhere.
6. **Branch typecheck expectation.** Every branch must be green on `npm run typecheck` and `npm test` on its own, EXCEPT the four `// @ts-ignore` scaffold lines A1 places in `src/app.ts` (§1.2, A1) — those exist precisely so A1 is green before A2's modules exist.
7. **Never read or copy** `.env`, `service-account.json`, `.claude/`, or the survey TSV. D reads the TSV only through its CLI at run time and never commits a row, a name, an email or a sales figure anywhere.

### 1.2 Ownership

**A1 — markets, schedules, market-date generator, roles/admin users, audit_log, dashboard, app wiring**
- Modifies: `src/app.ts`, `src/db/firestore.ts` (update the documentary `collections` map), `src/functions.ts` (add the `rollMarketDates` scheduler, keep `api` + `processReminders`), `src/middleware/rbac.ts`, `src/types/schema.ts` (`UserRole`), `src/routes/auth.ts` (`/me` and `/otp/verify` return `assigned_market_ids` + `email`; `active:false` users get 403 on `/otp/request`).
- Creates: `src/routes/markets.ts` (`marketRoutes`), `src/routes/admin-users.ts` (`adminUserRoutes`), `src/routes/audit-log.ts` (`auditLogRoutes`), `src/routes/dashboard.ts` (`dashboardRoutes`), `src/services/market-dates.ts` (generator), `src/services/markets.ts` (market zod schemas + defaults + validation), `src/utils/tz.ts` (shared, §1.4), `src/middleware/market-scope.ts` (shared, §1.4), `src/services/audit.ts` (shared, §1.4), `tests/tz.test.ts`, `tests/market-dates.test.ts`, `tests/markets-routes.test.ts`, `tests/rbac.test.ts`, `tests/admin-users.test.ts`, `tests/app-boot.test.ts`, `docs/phase2/notes-A1.md`.
- `src/app.ts` final route block (A1 writes exactly this; A2 and B do not touch app.ts):
  ```ts
  import { marketRoutes } from './routes/markets.js';
  import { adminUserRoutes } from './routes/admin-users.js';
  import { auditLogRoutes } from './routes/audit-log.js';
  import { dashboardRoutes } from './routes/dashboard.js';
  // Created by executor A2 on a parallel branch. The ts-ignore lines make this
  // branch typecheck before those files exist; the integrator deletes them.
  // @ts-ignore
  import { producerRoutes } from './routes/producers.js';
  // @ts-ignore
  import { membershipRoutes } from './routes/memberships.js';
  // @ts-ignore
  import { applicationRoutes } from './routes/applications.js';
  // @ts-ignore
  import { checkinRoutes } from './routes/checkins.js';
  …
  await app.register(marketRoutes, { prefix: '/api/markets' });
  await app.register(producerRoutes, { prefix: '/api/producers' });
  await app.register(membershipRoutes, { prefix: '/api/memberships' });
  await app.register(applicationRoutes, { prefix: '/api/applications' });
  await app.register(checkinRoutes, { prefix: '/api/checkins' });
  await app.register(adminUserRoutes, { prefix: '/api/admin/users' });
  await app.register(auditLogRoutes, { prefix: '/api/audit-log' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  ```
  (four `@ts-ignore` imports, one per A2 module). A1 also sets `trustProxy: true` in `Fastify({...})` so `req.ip` (rate-limit key) is the client behind Firebase Hosting, not `127.0.0.1`. A1 does not create `src/routes/producers.ts`, `memberships.ts`, `applications.ts` or `checkins.ts` — ever.

**A2 — producers, memberships, applications, check-in reads (new route/service files only)**
- Creates: `src/routes/producers.ts` (`producerRoutes`), `src/routes/memberships.ts` (`membershipRoutes`), `src/routes/applications.ts` (`applicationRoutes`), `src/routes/checkins.ts` (`checkinRoutes`), `src/services/producers.ts` (zod schemas, `upsertProducerByEmail`, transition table), `src/services/identity.ts` (copy of D's, §6), `src/middleware/market-scope.ts` (copy of A1's, §1.4), `src/services/audit.ts` (copy of A1's, §1.4), `tests/producers.test.ts`, `tests/memberships.test.ts`, `tests/applications.test.ts`, `tests/checkins.test.ts`, `docs/phase2/notes-A2.md`.
- Modifies nothing that exists. Uses only `authenticate` and `requireRole('admin')` from `rbac.ts` (both exist today) plus `requireStaff`/`requireMarketAccess`/`canAccessMarket` from its own copy of `market-scope.ts`. Never writes `requireRole('market_manager')` (the union on its branch lacks it).

**B — messaging + test mode**
- Modifies: `src/services/sms.ts`, `src/services/inbound.ts` (delete `sendAndLogSms`, import `trySendSms` from `./sms.js`), `src/services/reminders.ts`, `src/services/email.ts`, `src/services/otp.ts`, `src/services/push.ts`, `src/services/error-notify.ts`, `src/services/support-notify.ts`, `src/routes/invite.ts`, `src/routes/admin.ts` (broadcast path; delete the `GET /users` handler — A1's module takes that path; add `GET /providers`), `src/config/env.ts`, `.env.example`, `vitest.config.ts` (add `setupFiles`), `.github/workflows/ci.yml` (env block), `tests/sms-webhook-auth.test.ts` (adapt to the new row lifecycle), `tests/validation-error-handler.test.ts` (only if its `sendSms` mock shape must change).
- Creates: `tests/setup/test-mode.ts`, `tests/messaging.test.ts`, `tests/email.test.ts`, `tests/reminders.test.ts`, `docs/phase2/notes-B.md`.

**C — web app (`web/src/**` only)**
- Modifies: `web/src/lib/api.ts` (append the §8 helpers; keep the existing ones), `web/src/lib/auth-context.tsx` (`AuthUser` gains `assigned_market_ids: string[]`, `email: string | null`), `web/src/components/header.tsx`, `web/src/app/admin/page.tsx` (becomes the dashboard), `web/src/app/settings/page.tsx` (import the kit from `components/form.tsx`), `web/src/app/login/page.tsx` (redirect `market_manager` to `/admin` too), `web/src/app/page.tsx` (add an "Apply to sell at our markets" link to `/apply`).
- Creates: `web/src/components/form.tsx`, `web/src/components/staff-guard.tsx`, `web/src/components/status-chip.tsx`, `web/src/lib/types.ts`, `web/src/app/admin/broadcast/page.tsx` (the old broadcast tabs, moved), `web/src/app/admin/markets/page.tsx`, `web/src/app/admin/markets/detail/page.tsx`, `web/src/app/admin/producers/page.tsx`, `web/src/app/admin/producers/detail/page.tsx`, `web/src/app/admin/applications/page.tsx`, `web/src/app/admin/users/page.tsx`, `web/src/app/apply/page.tsx`, `docs/phase2/notes-C.md`. No `[param]` folders (§8.1).

**D — survey importer + identity**
- Creates: `scripts/import-survey.mjs`, `src/services/identity.ts` (owner; §6), `src/utils/tz.ts` (copy of A1's, §1.4), `tests/identity.test.ts`, `tests/import-survey.test.ts`, `tests/helpers/survey-fixture.ts` (synthetic TSV builder), `docs/phase2/notes-D.md`.
- Modifies: `package.json` (add `"import:survey": "tsx scripts/import-survey.mjs"`; no new dependencies — `tsx` and `firebase-admin` are already present), `firebase.json` (add `"scripts"` to `functions.ignore`), `tests/helpers/fake-db.ts` (§1.6 only).

### 1.3 Exact module and export names (the merge relies on these)

| Path | Export | Owner |
|---|---|---|
| `src/routes/markets.ts` | `marketRoutes` | A1 |
| `src/routes/admin-users.ts` | `adminUserRoutes` | A1 |
| `src/routes/audit-log.ts` | `auditLogRoutes` | A1 |
| `src/routes/dashboard.ts` | `dashboardRoutes` | A1 |
| `src/services/market-dates.ts` | `generateMarketDates`, `isDateDecided`, `computeWindow` | A1 |
| `src/services/markets.ts` | `createMarketSchema`, `updateMarketSchema`, `scheduleVersionSchema`, `skippedDatesSchema`, `specialDatesSchema`, `extraQuestionSchema`, `DEFAULT_WORKFLOW`, `DEFAULT_QUIET_HOURS` | A1 |
| `src/routes/producers.ts` | `producerRoutes` | A2 |
| `src/routes/memberships.ts` | `membershipRoutes` | A2 |
| `src/routes/applications.ts` | `applicationRoutes` | A2 |
| `src/routes/checkins.ts` | `checkinRoutes` | A2 |
| `src/services/producers.ts` | `upsertProducerByEmail`, `MEMBERSHIP_TRANSITIONS`, `canTransition`, `createProducerSchema`, `updateProducerSchema`, `applicationSchema` | A2 |
| `src/services/sms.ts` | `sendSms`, `trySendSms`, `splitMessage`, `selectSmsProvider`, `SendsDisabledError`, `SmsSendError`, types `SmsKind`, `SendSmsArgs`, `SendSmsResult` | B |
| `src/services/email.ts` | `sendEmail` (signature unchanged), `selectEmailProvider`, `baseLayout` | B |
| `src/services/identity.ts` | see §6 | D (A2 copies) |
| `src/utils/tz.ts`, `src/middleware/market-scope.ts`, `src/services/audit.ts` | see §1.4 | A1 (D / A2 / A2 copy) |

### 1.4 Shared modules (complete sources; A1 owns, copy verbatim)

**`src/utils/tz.ts`** — A1 creates, D copies. sha256 `b1f27a8513ba22e02e9392949b6760ea095b843328d9003ae7b6b19ce4d9ef5a`, 150 lines.
```ts
/**
 * Market-local wall clock ↔ UTC with Intl only (no timezone dependency).
 *
 * SHARED VERBATIM: executor A1 owns this file; executor D copies it
 * byte-for-byte for the survey importer. Do not reformat or extend it here.
 *
 * Dates are 'YYYY-MM-DD' strings, times 'HH:mm' (24 h), zones IANA names.
 */

export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: DayOfWeek;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Parse 'YYYY-MM-DD'; throws on bad format or an impossible calendar date. */
export function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date '${date}': expected YYYY-MM-DD`);
  const parts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const probe = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (probe.getUTCFullYear() !== parts.y || probe.getUTCMonth() !== parts.m - 1 || probe.getUTCDate() !== parts.d) {
    throw new Error(`Invalid date '${date}': not a calendar date`);
  }
  return parts;
}

/** Parse 'HH:mm' (24 h); throws on bad format. */
export function parseTime(time: string): { hh: number; mm: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time '${time}': expected HH:mm`);
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Wall-clock parts of an instant in a zone. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'long',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24; // some engines print '24' at midnight
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: hour,
    mm: Number(get('minute')),
    ss: Number(get('second')),
    weekday: get('weekday').toLowerCase() as DayOfWeek,
  };
}

function wallMillis(w: WallClock): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
}

/**
 * The UTC instant at which `timeZone` shows `date` `time`.
 *
 * Iteration 1 treats the wall clock as if it were UTC, measures the zone's
 * offset at that guess and corrects by it. Iteration 2 repeats the
 * measurement at the corrected instant, which only differs when a DST
 * transition lies between the two. A wall-clock time inside a spring-forward
 * gap never round-trips; it resolves to the later instant (the clock has
 * already jumped). An ambiguous fall-back time resolves to its first
 * occurrence.
 */
export function localToUtc(date: string, time: string, timeZone: string): Date {
  const { y, m, d } = parseDate(date);
  const { hh, mm } = parseTime(time);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);

  const guessOffset = wallMillis(wallClock(new Date(target), timeZone)) - target;
  let candidate = target - guessOffset;

  const drift = wallMillis(wallClock(new Date(candidate), timeZone)) - target;
  if (drift !== 0) {
    const second = candidate - drift;
    if (wallMillis(wallClock(new Date(second), timeZone)) === target) candidate = second;
  }
  return new Date(candidate);
}

/** 'YYYY-MM-DD' of an instant in a zone. */
export function utcToLocalDate(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return formatDate(w.y, w.m, w.d);
}

/** 'HH:mm' of an instant in a zone. */
export function utcToLocalTime(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${pad2(w.hh)}:${pad2(w.mm)}`;
}

/** Calendar weekday of a 'YYYY-MM-DD' date (zone-independent). */
export function weekdayOf(date: string): DayOfWeek {
  const { y, m, d } = parseDate(date);
  return DAYS_OF_WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Add (or subtract) calendar days to a 'YYYY-MM-DD' date. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** Every date from `from` to `to` inclusive (empty when from > to). */
export function eachDate(from: string, to: string): string[] {
  parseDate(from);
  parseDate(to);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
```

**`src/middleware/market-scope.ts`** — A1 creates, A2 copies. sha256 `d12e18c91b42f9ba9fd8d7c8dd8ceddc31059c66ba91c62681e79a484a77964c`, 68 lines.
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Market scoping for staff users (SPEC §6.9): admins see every market,
 * market managers only their `assigned_market_ids`.
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte. It deliberately reads `role` as a plain string and
 * `assigned_market_ids` structurally so it compiles both before and after
 * rbac.ts adds the `market_manager` role and the new AuthUser field.
 */

export interface ScopedUser {
  role: string;
  assigned_market_ids?: string[] | null;
}

export function isStaff(user: ScopedUser | null | undefined): boolean {
  return !!user && (user.role === 'admin' || user.role === 'market_manager');
}

export function canAccessMarket(user: ScopedUser | null | undefined, marketId: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'market_manager') return false;
  return Array.isArray(user.assigned_market_ids) && user.assigned_market_ids.includes(marketId);
}

/** Markets the user may read; `null` means "all" (admin). */
export function accessibleMarketIds(user: ScopedUser | null | undefined): string[] | null {
  if (!user) return [];
  if (user.role === 'admin') return null;
  if (user.role !== 'market_manager') return [];
  return Array.isArray(user.assigned_market_ids) ? [...user.assigned_market_ids] : [];
}

export type MarketIdResolver = (request: FastifyRequest) => string | undefined | Promise<string | undefined>;

export const marketIdFromParams = (key = 'id'): MarketIdResolver =>
  (request) => (request.params as Record<string, string | undefined>)[key];

export const marketIdFromQuery = (key = 'market_id'): MarketIdResolver =>
  (request) => (request.query as Record<string, string | undefined>)[key];

/** preHandler: 401 unauthenticated, 403 unless admin or market_manager. */
export function requireStaff() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser as ScopedUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isStaff(user)) return reply.status(403).send({ error: 'Forbidden: staff only' });
  };
}

/**
 * preHandler: 401 unauthenticated, 403 for non-staff, 400 when the resolver
 * finds no market id, 403 when the market is not assigned to the manager.
 * Admins always pass once a market id is present.
 */
export function requireMarketAccess(resolve: MarketIdResolver) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser as ScopedUser | undefined;
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isStaff(user)) return reply.status(403).send({ error: 'Forbidden: staff only' });
    const marketId = await resolve(request);
    if (!marketId) return reply.status(400).send({ error: 'market_id is required' });
    if (!canAccessMarket(user, marketId)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });
  };
}
```

**`src/services/audit.ts`** — A1 creates, A2 copies. sha256 `c0cdb8aaad2dbe1d13c87487cf0dcdd92240b89e20833867c697a7561b8de02e`, 45 lines.
```ts
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';

/**
 * audit_log writer (SPEC §6.9: every admin action writes audit_log).
 *
 * SHARED VERBATIM: executor A1 owns this file; executor A2 copies it
 * byte-for-byte.
 */

export interface AuditEntry {
  actor_id: string;
  actor_role: string;
  /** Dotted verb, e.g. 'market.create', 'membership.transition'. */
  action: string;
  target: { collection: string; id: string };
  before?: unknown;
  after?: unknown;
  note?: string | null;
}

/**
 * Append one entry. Never throws: the action it records has already
 * happened, so a failed audit write is reported to the console instead of
 * failing the request. Resolves to the entry id.
 */
export async function writeAudit(db: Firestore, entry: AuditEntry): Promise<string> {
  const id = uuid();
  const row = {
    actor_id: entry.actor_id,
    actor_role: entry.actor_role,
    action: entry.action,
    target: entry.target,
    before: entry.before ?? null,
    after: entry.after ?? null,
    note: entry.note ?? null,
    at: new Date(),
  };
  try {
    await db.collection('audit_log').doc(id).set(row);
  } catch (err) {
    console.error(`audit_log write failed: ${entry.action} ${entry.target.collection}/${entry.target.id}`, err);
  }
  return id;
}
```

### 1.5 Integration (after all five branches merge — the integrator, not an executor)

1. Delete the four `// @ts-ignore` lines above the A2 imports in `src/app.ts`.
2. `npm run typecheck && npm test && (cd web && npx tsc --noEmit)`. `tests/app-boot.test.ts` now runs (it self-skips while A2's files are absent) and catches duplicate routes.
3. `shasum -a 256` the four shared modules — one hash each. If git reported add/add on any of them, the two copies differed; keep the one matching this contract's hash.
4. Fold `docs/phase2/notes-*.md` into `CHANGELOG.md`, update CLAUDE.md's repo map and the "dummy .env" line (`SMS_PROVIDER=console`), record D15/D20 status in SPEC §9.
5. Owner actions (§5.6) before `npm run deploy:functions`.

### 1.6 `tests/helpers/fake-db.ts` — D may extend, nobody else

D's importer tests may add to fake-db only: `collection().get()` with zero filters returning every doc (already works), and a test-only `db.count(name)`. D must not change existing behaviour. A1/A2/B code against the current helper unchanged.

## 2. FIRESTORE COLLECTIONS

Types: `string`, `string|null`, `number|null`, `bool`, `Timestamp` (stored as `new Date()`; the `preSerialization` hook emits ISO strings), `'YYYY-MM-DD'` (market-local calendar date string), `'HH:mm'` (24 h market-local). "req" = always present; "opt" = may be absent or null. Every doc carries `created_at` (Timestamp, req) and `updated_at` (Timestamp, req) unless noted.

### 2.1 `farmers_markets` — doc id = `slug` (`/^[a-z0-9][a-z0-9-]{1,31}$/`, immutable; WLRFM is `wlrfm`, Argenta is `argenta`)

| Field | Type | Notes |
|---|---|---|
| `name` | string req | "West Little Rock Farmers Market" |
| `slug` | string req | equals the doc id |
| `location` | `{ name: string, address: string }` req | address may be `''` |
| `timezone` | string req | IANA; validated with `isValidTimeZone`; default `'America/Chicago'` |
| `schedule.versions[]` | `ScheduleVersion[]` req, ≥1 | sorted by `effective_from` asc, unique `effective_from` |
| `schedule.skipped_dates[]` | `{ date: 'YYYY-MM-DD', reason: string }[]` req | default `[]` |
| `schedule.special_dates[]` | `{ date, start_time: 'HH:mm', end_time: 'HH:mm', note: string }[]` req | default `[]`; a special date is a market day even if its weekday is not in `days_of_week` |
| `workflow` | `{ checkin_offset_min: number, reminder_offsets_min: number[], deadline_offset_min: number, drafts_offset_min: number }` req | defaults `60`, `[1440, 2880]`, `4320`, `4380`; all offsets from `market_date.end_at` |
| `quiet_hours` | `{ start: 'HH:mm', end: 'HH:mm' }` req | default `{ start: '21:00', end: '08:00' }`; wraps midnight when `end < start` |
| `website` | `{ duda_site_id: string, thisweek_page_id: string, vendor_collection_id: string }` opt | Phase 6 |
| `mailchimp` | `{ audience_id: string, template_id: string }` opt | Phase 6 |
| `active` | bool req | inactive markets are hidden from `/apply` and from date generation |
| `created_by` | string req | user id or `'import'` |

`ScheduleVersion = { id: uuid, effective_from: 'YYYY-MM-DD', season_start: 'YYYY-MM-DD', season_end: 'YYYY-MM-DD', days_of_week: DayOfWeek[] (≥1, values from tz.ts DAYS_OF_WEEK), start_time: 'HH:mm', end_time: 'HH:mm' (> start_time), created_at: Timestamp, created_by: string }`.

WLRFM as the importer creates it: `{ name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: 'Breckenridge Village', address: '' }, timezone: 'America/Chicago', schedule: { versions: [{ effective_from: '2026-04-18', season_start: '2026-04-18', season_end: '2026-10-31', days_of_week: ['saturday'], start_time: '08:00', end_time: '12:00', created_by: 'import' }], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS, active: true, created_by: 'import' }`.

### 2.2 `market_dates` — doc id = `${market_id}_${date}` (e.g. `wlrfm_2026-04-18`)

| Field | Type | Notes |
|---|---|---|
| `market_id` | string req | |
| `date` | 'YYYY-MM-DD' req | market-local |
| `start_time`, `end_time` | 'HH:mm' req | resolved (version or special) |
| `start_at`, `end_at` | Timestamp req | `localToUtc(date, time, market.timezone)` |
| `status` | `'collecting' \| 'lineup_final' \| 'published' \| 'cancelled'` req | new dates start `collecting` |
| `schedule_version` | string req | the `ScheduleVersion.id` that produced it, or `'special'` |
| `special` | bool req | true when `special_dates` supplied the times |
| `note` | string req | from `special_dates.note` or admin; default `''` |
| `actions` | `{ checkin_sent_at: Timestamp\|null, reminders_sent: Timestamp[], deadline_at: Timestamp, deadline_processed_at: Timestamp\|null, drafts_generated_at: Timestamp\|null, approved_at: Timestamp\|null, booth_texts_sent_at: Timestamp\|null }` req | `deadline_at = end_at + workflow.deadline_offset_min` minutes; all others start null/`[]` |
| `extra_questions` | `ExtraQuestion[]` req | default `[]`; `{ key: /^[a-z][a-z0-9_]{1,31}$/, prompt: string, type: 'text'\|'choice'\|'yes_no', options?: string[] (req when choice) }`; keys unique per date |
| `sponsor_id` | string\|null req | Phase 5 |
| `cancellation_reason` | string\|null req | |
| `cancelled_at` | Timestamp\|null req | |
| `cancelled_by` | string\|null req | user id, `'generator'` (schedule change/skip) |
| `generated_at` | Timestamp req | last generator touch |
| `source` | `'generator' \| 'import'` req | |

### 2.3 `producers` — doc id = uuid

| Field | Type | Notes |
|---|---|---|
| `business_name` | string req | canonical display name |
| `name_key` | string req | `nameKey(business_name)`; recomputed on rename |
| `contact_name` | string req | default `''` |
| `phone` | string\|null req | E.164; unique among producers when present; imported producers have `null` |
| `email` | string\|null req | primary, normalized |
| `emails[]` | string[] req | every normalized address ever seen, unique; the import identity key |
| `aliases[]` | string[] req | every other name variant seen, unique, never contains `business_name` |
| `products[]` | string[] req | `[]` in Phase 2 (the importer never parses "bringing") |
| `category` | string req | default `''` |
| `documents[]` | `{ name, url, uploaded_at }[]` req | default `[]` |
| `sms_consent` | `{ status: 'unknown'\|'opted_in'\|'opted_out', at: Timestamp\|null, source: string }` req | import: `unknown`; application: `opted_in`, source `'application'` |
| `sms_opt_out_at` | Timestamp\|null req | |
| `user_id`, `legacy_farm_id` | string\|null req | |
| `notes` | string req | admin-only free text |
| `source` | `'application' \| 'import' \| 'admin'` req | |
| `active` | bool req | |

### 2.4 `producer_memberships` — doc id = `${producer_id}_${market_id}`

| Field | Type | Notes |
|---|---|---|
| `producer_id`, `market_id` | string req | |
| `status` | `'applied' \| 'under_review' \| 'approved' \| 'active' \| 'inactive'` req | transitions in §4.3 |
| `usual_booth_id` | string\|null req | Phase 4 |
| `fee_plan` | `'weekly' \| 'season' \| 'both'` req | default `'weekly'` |
| `approved_at`, `approved_by` | Timestamp\|null, string\|null req | set on the first transition into `approved` (or straight to `active`) |
| `history[]` | `{ from: string\|null, to: string, at: Timestamp, by: string, note: string\|null }[]` req | append-only |
| `source` | `'application' \| 'import' \| 'admin'` req | |

### 2.5 `applications` — doc id = uuid

| Field | Type | Notes |
|---|---|---|
| `email` | string req | normalized |
| `business_name`, `contact_person` | string req | |
| `phone` | string req | E.164 via `normalizePhone` (copy the 5-line function from `src/routes/sms.ts`; do not import it) |
| `markets_applied[]` | string[] req, ≥1 | market ids, each an `active` market |
| `extra` | `Record<string, string \| boolean \| string[]>` req | page-2 answers; default `{}`; ≤ 50 keys, key `/^[a-z][a-z0-9_]{0,63}$/`, strings ≤ 2000 chars |
| `status` | `'new' \| 'under_review' \| 'approved' \| 'declined'` req | |
| `reviewed_by`, `reviewed_at`, `decision_note` | string\|null, Timestamp\|null, string\|null req | |
| `producer_id` | string\|null req | set on approve |
| `membership_ids[]` | string[] req | set on approve |
| `submitted_at` | Timestamp req | |
| `source` | `'web'` req | |

### 2.6 `checkins` — doc id = `${market_date_id}_${producer_id}`

| Field | Type | Notes |
|---|---|---|
| `producer_id`, `market_id`, `market_date_id` | string req | |
| `submitted_at` | Timestamp req | import: the row timestamp in the market's zone |
| `source` | `'form' \| 'import'` req | |
| `token_id` | string\|null req | Phase 3 |
| `estimated_sales` | `{ value: number\|null, raw: string, kind: 'exact'\|'range'\|'none' }` req | **admin-only**: stripped from every API response unless `authUser.role === 'admin'` |
| `transactions_estimate` | `{ value: number\|null, raw: string }` req | |
| `sold_out_items[]`, `sold_out_raw` | string[], string req | |
| `unsold_items[]`, `unsold_raw` | string[], string req | |
| `attending_next`, `attending_next_raw` | bool\|null, string req | |
| `bringing_next[]`, `bringing_next_raw` | string[] (always `[]` from import), string req | |
| `feedback` | string req | |
| `extra_answers` | `{ weekly_question?: string, winter_interest?: 'yes'\|'maybe'\|'no', [key: string]: unknown }` req | keys match the date's `extra_questions[].key` |
| `flags[]` | string[] req | `'sales_outlier'` (value > 20000), `'transactions_ambiguous'`, `'duplicate_response'` |
| `raw_import` | `{ row_hash: string, source: string, cells: string[] (13), timestamp_raw: string, duplicates: number } \| null` req | admin-only in responses; null for `form` |

### 2.7 `users` (adapted, existing docs untouched)

`name` string, `phone` string (E.164, identity key), `email` string\|null, `role: 'admin' | 'market_manager' | 'farmer' | 'market' | 'both'` (last three are v1 leftovers: they may log in but every Phase 2 route answers 403), `assigned_market_ids: string[]` (absent on old docs → treat as `[]`), `fcm_tokens: string[]`, `active: bool` (absent → `true`), `sms_opt_out_at`, `invited_by` string\|null, `invited_at` Timestamp\|null, `logo_url` (v1, tolerated).

### 2.8 `audit_log` — doc id = uuid

`actor_id` string, `actor_role` string, `action` string (dotted, §4 lists them), `target: { collection: string, id: string }`, `before` object\|null, `after` object\|null, `note` string\|null, `at` Timestamp. Written by `writeAudit` (§1.4).

### 2.9 `messages` (exists; fields confirmed and completed)

`direction: 'inbound'|'outbound'`, `to` string, `from` string (`env.VOIPMS_DID ?? ''`, `'console'` for the console provider on outbound), `body` string, `provider: 'voipms'|'console'`, `provider_message_id` string\|null, `status: 'queued'|'sent'|'delivered'|'failed'|'received'|'simulated'`, `status_at` Timestamp, `error` string\|null, `kind` `SmsKind` (§5.2), `segments` number, `producer_id`, `market_date_id`, `user_id`, `sent_by` string\|null each, `created_at`. Existing rows lack `status_at`/`segments`/the null-able ids — readers tolerate absence. Extra keys (`broadcast_id`, `reminder_id`) are allowed via `extra`.

### 2.10 `invites` (exists) — `invited_phone`, `invited_name`, `invited_by`, `created_at`; A1's admin invites add `kind: 'admin_user'`, `user_id`, `role`, `assigned_market_ids`, `message_id` (the `messages` row id).

## 3. THE MARKET-DATE GENERATOR (A1, `src/services/market-dates.ts`)

```ts
export interface GenerateOptions { scope: 'window' | 'season'; now?: Date; actor: string /* user id | 'scheduler' | 'import' */ }
export interface GenerateResult { created: number; updated: number; cancelled: number; unchanged: number; skipped: number; frozen: number; from: string; to: string }
export function computeWindow(market: FarmersMarket, scope: 'window'|'season', now: Date): { from: string; to: string }
export function isDateDecided(doc: MarketDateDoc, now: Date): boolean
export async function generateMarketDates(db: Firestore, market: FarmersMarket, opts: GenerateOptions): Promise<GenerateResult>
```

**Window.** `today = utcToLocalDate(now, market.timezone)`. `scope: 'window'` → `from = addDays(today, -7)`, `to = addDays(today, 56)`. `scope: 'season'` → `from = min(version.season_start)`, `to = max(version.season_end)` over all versions, extended to include every `special_dates.date`. The nightly scheduler `rollMarketDates` (`src/functions.ts`, `onSchedule({ schedule: '15 3 * * *', timeZone: 'America/Chicago' })` — that zone only anchors the cron; every computation uses `market.timezone`) runs `scope: 'window'` for every `active` market with `actor: 'scheduler'`.

**Expected dates.** For each `date` in `eachDate(from, to)`:
1. `version` = the last version (sorted by `effective_from` asc) with `effective_from <= date`; none → not a market day.
2. `special` = `special_dates.find(s => s.date === date)`. If special → market day with `start_time/end_time/note` from the special entry, `schedule_version: 'special'`, `special: true` (season and weekday checks do not apply).
3. Else market day iff `version.season_start <= date <= version.season_end` and `weekdayOf(date) ∈ version.days_of_week`; times from the version; `schedule_version = version.id`.
4. `skipped = skipped_dates.find(s => s.date === date)` → not a market day; remember `reason`.
5. `start_at = localToUtc(date, start_time, tz)`, `end_at = localToUtc(date, end_time, tz)`, `deadline_at = end_at + workflow.deadline_offset_min * 60_000`.

**Existing docs.** One query: `db.collection('market_dates').where('market_id', '==', market.id).get()`, indexed by `date` in memory. Docs outside `[from, to]` are never touched.

**Decided** (`isDateDecided`): `status !== 'collecting'` OR any of `actions.checkin_sent_at | deadline_processed_at | drafts_generated_at | approved_at | booth_texts_sent_at` is non-null OR `actions.reminders_sent.length > 0` OR `end_at < now` (a past date is frozen even if untouched). `deadline_at` is a computed value, not an action, and never counts. Exception used below: a doc with `status === 'cancelled' && cancelled_by === 'generator'` and no action timestamps and `end_at >= now` is *revivable*.

**Upsert per expected date (id `${market.id}_${date}`):**
- no doc → `set` the full §2.2 shape (`status: 'collecting'`, `source: 'generator'`, `generated_at: now`) → `created++`.
- doc exists and decided (and not revivable) → untouched → `frozen++`.
- doc exists, revivable → `update({ status: 'collecting', cancellation_reason: null, cancelled_at: null, cancelled_by: null, ...times })` → `updated++`.
- doc exists, undecided: compare `start_time,end_time,start_at,end_at,schedule_version,special,note-if-special`; identical → `unchanged++`; else `update` exactly those fields plus `actions.deadline_at`, `generated_at`, `updated_at` — never `extra_questions`, `sponsor_id`, `status`, `created_at`, an admin-written `note` (only overwrite `note` when `special`) → `updated++`.

**Docs in range that are no longer expected** (weekday removed, season shrunk, newly skipped): decided → `frozen++`; undecided → `update({ status: 'cancelled', cancelled_by: 'generator', cancelled_at: now, cancellation_reason: skipped ? `skipped: ${reason}` : 'schedule_change' })` → `cancelled++`. A skipped date with no doc → `skipped++`. Docs are never deleted.

**Schedule versions.** Because the applicable version is chosen per date by `effective_from`, adding a version with `effective_from: '2026-10-01'` changes only dates ≥ Oct 1, and among those only the undecided future ones (rule above). Deleting a version re-runs the same logic; the last remaining version cannot be deleted (409). Changing `market.timezone` or `workflow.deadline_offset_min` re-runs the window generation (times/deadlines of undecided future dates move; decided dates keep their instants).

**Cancellation by an admin** (`PATCH /markets/:id/dates/:date_id { status: 'cancelled', cancellation_reason }`) sets `cancelled_by = <user id>`; the generator treats it as decided forever. Un-cancelling (`status: 'collecting'`) is allowed only when no action timestamp is set and `end_at >= now`.

**Idempotency.** Running any scope twice with the same market yields `created: 0, updated: 0, cancelled: 0` the second time. All writes are `set`/`update` on deterministic ids; no reads outside the one query.

**Timezone (`src/utils/tz.ts`, §1.4).** `localToUtc` is the two-iteration Intl algorithm: guess the wall clock as UTC, measure the zone offset at the guess with `Intl.DateTimeFormat(...).formatToParts`, correct, re-measure at the corrected instant and correct once more; a spring-forward gap resolves to the later instant, a fall-back overlap to the first occurrence. The 2026 America/Chicago transitions the tests must cover are **2026-03-08 02:00 → 03:00 (CST→CDT, UTC−6→−5)** and **2026-11-01 02:00 → 01:00 (CDT→CST)**; expected instants are in §9.1.

## 4. ROUTES

All paths are under `/api`. Auth column: `public`; `staff` = `authenticate(app)` + `requireStaff()`; `admin` = `authenticate(app)` + `requireRole('admin')`; `market(x)` = `authenticate(app)` + `requireMarketAccess(x)` (admins pass; market managers only for assigned markets). Error shape everywhere: `{ error: string }` (400 zod, 401, 403, 404, 409 conflict, 502 provider). `MarketDate`, `Market`, `Producer`, `Membership`, `Application`, `Checkin`, `User` are the §2 docs plus `id`. Every response passes through the timestamp serializer. Existing endpoints (`/auth/*`, `/profile/*`, `/feedback/*`, `/reminders/*`, `/push/*`, `/errors`, `/sms/*`, `/invite`, `/uploads`, `/admin/utilization`, `/admin/broadcast`, `/admin/broadcasts`) are unchanged except as noted in §5.

### 4.1 Markets (A1, `marketRoutes`, prefix `/api/markets`)

| Method | Path | Auth | Request (zod) | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/public` | public | — | `{ markets: { id, name, location, timezone, active, next: { date, start_time, end_time } \| null }[] }` active markets only | no |
| GET | `/` | staff | — | `{ markets: Market[] }` filtered by `accessibleMarketIds` | no |
| POST | `/` | admin | `createMarketSchema` = `{ slug, name, location: { name, address? }, timezone?, schedule: { versions: [scheduleVersionInput] (exactly 1), skipped_dates?, special_dates? }, workflow?, quiet_hours?, website?, mailchimp?, active? }` | 201 `{ market, generation: GenerateResult }` (runs `scope: 'window'`) | yes `market.create` |
| GET | `/:id` | market(params.id) | — | `{ market }` | no |
| PATCH | `/:id` | admin | `updateMarketSchema` = partial of `{ name, location, timezone, workflow, quiet_hours, website, mailchimp, active }` (never `slug`, never `schedule`) | `{ market, generation? }` (generation present when `timezone` or `workflow.deadline_offset_min` changed) | yes `market.update` (before/after = changed fields) |
| POST | `/:id/schedule/versions` | admin | `scheduleVersionSchema` = `{ effective_from, season_start, season_end, days_of_week: DayOfWeek[] (min 1), start_time, end_time }` with `season_start <= season_end`, `end_time > start_time`, `effective_from` unique | 201 `{ market, generation }` | yes `market.schedule_version.add` |
| DELETE | `/:id/schedule/versions/:version_id` | admin | — | `{ market, generation }`; 409 if it is the only version | yes `market.schedule_version.delete` |
| PUT | `/:id/schedule/skipped` | admin | `skippedDatesSchema` = `{ skipped_dates: { date, reason: string.min(1) }[] }` (replaces the list; unique dates) | `{ market, generation }` | yes `market.skipped_dates.set` |
| PUT | `/:id/schedule/special` | admin | `specialDatesSchema` = `{ special_dates: { date, start_time, end_time, note }[] }` (replaces; unique dates; a date may not be both skipped and special → 409) | `{ market, generation }` | yes `market.special_dates.set` |
| POST | `/:id/dates/generate` | admin | `{ scope: z.enum(['window','season']).default('window') }` | `{ generation: GenerateResult }` | yes `market.dates.generate` (after = result) |
| GET | `/:id/dates` | market(params.id) | query `{ from?: date, to?: date, status?: enum }` (defaults: none → all docs of the market, sorted by `date` asc) | `{ dates: MarketDate[] }` | no |
| PATCH | `/:id/dates/:date_id` | market(params.id) | `{ status?: z.enum(['cancelled','collecting']), cancellation_reason?: string.min(1), note?: string, extra_questions?: extraQuestionSchema[], sponsor_id?: string\|null }`; cancelling requires a reason; 409 on an illegal status change (§3) | `{ date: MarketDate }` | yes `market_date.cancel` / `market_date.uncancel` / `market_date.update` |

`z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` for dates (then `parseDate` in `.refine`), `/^([01]\d|2[0-3]):[0-5]\d$/` for times, `isValidTimeZone` in a refine. Market-manager `GET /:id` and `GET /:id/dates` never expose `mailchimp`/`website` (strip for non-admins).

### 4.2 Producers (A2, `producerRoutes`, prefix `/api/producers`)

| Method | Path | Auth | Request | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/` | staff | query `{ market_id?, status?: membership status, q?: string, include_inactive?: 'true' }`; **market_manager must send `market_id` ∈ assigned** (400 without, 403 outside) | `{ producers: (Producer & { memberships: { market_id, status }[] })[] }` sorted by `business_name`; `q` matches business_name/aliases/contact_name case-insensitively in memory; `notes` stripped for non-admins | no |
| POST | `/` | admin | `createProducerSchema` = `{ business_name: min(1), contact_name?, phone?: E.164, email?: email, emails?: email[], aliases?: string[], products?: string[], category?, notes?, memberships?: { market_id, status?: default 'approved', fee_plan? }[] }`; 409 `{ error, producer_id }` when `normalizeEmail(email)` already belongs to a producer or `phone` is taken | 201 `{ producer, memberships }` | yes `producer.create` (+ `membership.create` each) |
| GET | `/:id` | staff (market_manager: only if the producer has a membership in an assigned market, else 404) | — | `{ producer, memberships: Membership[], checkins_summary: { count, last_submitted_at } }` | no |
| PATCH | `/:id` | admin | `updateProducerSchema` = partial of the create fields except `memberships`, plus `active`; renaming pushes the old `business_name` into `aliases` (dedup, never equal to the new name) and recomputes `name_key`; `email` change adds to `emails[]` | `{ producer }` | yes `producer.update` |

### 4.3 Memberships (A2, `membershipRoutes`, prefix `/api/memberships`)

`MEMBERSHIP_TRANSITIONS: Record<Status, Status[]>` = `applied → [under_review, approved, inactive]`, `under_review → [applied, approved, inactive]`, `approved → [active, inactive]`, `active → [inactive]`, `inactive → [active, approved]`. `canTransition(from, to)`.

| Method | Path | Auth | Request | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/` | staff | query `{ market_id? , producer_id? }` — exactly one (400 otherwise); market_manager: `market_id` must be assigned, `producer_id` results filtered to assigned markets | `{ memberships: (Membership & { producer: { id, business_name } })[] }` | no |
| POST | `/` | admin | `{ producer_id, market_id, status?: default 'approved', fee_plan?, usual_booth_id? }`; 404 unknown producer/market; 409 exists | 201 `{ membership }` | yes `membership.create` |
| PATCH | `/:id` | market(membership.market_id — resolver loads the doc; 404 when missing) | `{ status?, fee_plan?, usual_booth_id?, note? }`; status must satisfy `canTransition` else 409 `{ error, from, to }`; appends `history`, sets `approved_at/by` on first entry into approved/active | `{ membership }` | yes `membership.transition` (before/after status) or `membership.update` |

### 4.4 Applications (A2, `applicationRoutes`, prefix `/api/applications`)

| Method | Path | Auth | Request | Response | audit_log |
|---|---|---|---|---|---|
| POST | `/` | public; `config: { rateLimit: { max: 5, timeWindow: '1 hour' } }` | `applicationSchema` = `{ email: z.string().email(), business_name: min(1).max(200), contact_person: min(1).max(200), phone: min(10) → normalizePhone, markets_applied: z.array(z.string()).min(1), extra: z.record(z.union([z.string().max(2000), z.boolean(), z.array(z.string().max(500)).max(50)])).default({}) }`; every market must exist and be `active` (400); a `status: 'new'` application with the same normalized email submitted < 24 h ago → 409 | 201 `{ id, status: 'new' }` | no |
| GET | `/` | admin | query `{ status? }` | `{ applications: Application[] }` newest first | no |
| GET | `/:id` | admin | — | `{ application }` | no |
| PATCH | `/:id` | admin | discriminated union on `action`: `{ action: 'review' }` (new → under_review) · `{ action: 'decline', note?: string }` · `{ action: 'approve', market_ids: string[].min(1) ⊆ markets_applied, note?: string }`; 409 when already approved/declined | `{ application, producer?, memberships? }` | yes `application.review` / `application.decline` / `application.approve` (+ `producer.create` or `producer.update`, `membership.create`/`membership.transition`) |

**Approve = upsert BY EMAIL, never by name** (`upsertProducerByEmail(db, { email, business_name, contact_person, phone, source: 'application' })` in `src/services/producers.ts`): scan `producers` (one `get()`), match the first doc whose `emails[]` contains `normalizeEmail(email)`; if found → merge: add the email if missing, add `business_name` to `aliases` when it differs from the canonical (canonical is never changed by an application), set `phone` if null, set `contact_name` if empty, `sms_consent` → `opted_in` when phone supplied; else create the §2.3 shape (`emails: [email]`, `name_key: nameKey(business_name)`, `source: 'application'`, `sms_consent: { status: 'opted_in', at: now, source: 'application' }`). Then for each `market_id`: membership `${producer_id}_${market_id}` → create with `status: 'approved'`, `source: 'application'`, or transition `applied|under_review → approved`; `approved|active` left alone. Application → `approved`, `producer_id`, `membership_ids`, `reviewed_by/at`.

### 4.5 Check-ins (A2, `checkinRoutes`, prefix `/api/checkins`) — read only in Phase 2

| GET | `/` | staff | query `{ market_date_id? , producer_id? }` — exactly one; market scoping via the checkin's `market_id` | `{ checkins: Checkin[] }` sorted `submitted_at` desc; `estimated_sales` and `raw_import` present **only for admins** | no |

### 4.6 Admin users (A1, `adminUserRoutes`, prefix `/api/admin/users`)

| Method | Path | Auth | Request | Response | audit_log |
|---|---|---|---|---|---|
| GET | `/` | admin | — | `{ users: { id, name, phone, email, role, assigned_market_ids, active, sms_opt_out_at, invited_at, created_at }[] }` | no |
| POST | `/invite` | admin | `{ phone: min(10) → normalizePhone, name: min(1), role: z.enum(['admin','market_manager']), assigned_market_ids: z.array(z.string()).default([]), email?: email }`; `market_manager` needs ≥1 existing market id (400); 409 when the phone is taken | 201 `{ user, sms: { status: 'sent'\|'simulated'\|'failed', error?: string } }` — the user is created even if the text fails | yes `user.invite` |
| POST | `/:id/resend-invite` | admin | — | `{ sms: {...} }` | yes `user.invite.resend` |
| PATCH | `/:id` | admin | `{ name?, email?, role?, assigned_market_ids?, active? }`; an admin may not demote or deactivate themselves (409) | `{ user }` | yes `user.update` |

Invite text: `` `${inviter} added you to the SJCA Market Manager (${role === 'admin' ? 'admin' : 'market manager'}). Sign in with this phone number at ${APP_URL}/login` ``. A1 sends it through B's new `sendSms` **using a non-literal argument object** so the call typechecks on A1's branch against the old signature too:
```ts
const args = { env: app.env, db: app.db, to, body, kind: 'admin_invite' as const, user_id: userId, sent_by: request.authUser!.id };
try { await sendSms(args); sms = { status: app.env.NODE_ENV === 'production' ? 'sent' : 'simulated' }; } catch (err) { sms = { status: 'failed', error: String(err) }; }
```
(A1's tests `vi.mock('../src/services/sms.js')`. After merge the real result carries `status`; the integrator may switch to `result.status`.)

### 4.7 Audit log (A1, `auditLogRoutes`, prefix `/api/audit-log`)

| GET | `/` | admin | query `{ limit?: 1..500 default 100, collection?, actor_id?, action_prefix? }` — `where('actor_id','==',…)` when given, otherwise a full `get()`; the rest filtered in memory, sorted `at` desc, then `limit` | `{ entries: (AuditEntry & { id })[] }` | no |

(A1 records the full-scan growth caveat in `notes-A1.md`; a bounded query arrives when fake-db grows `orderBy`.)

### 4.8 Dashboard (A1, `dashboardRoutes`, prefix `/api/dashboard`)

| GET | `/` | staff | — | `{ generated_at, markets: { market: { id, name, timezone, active }, next_date: MarketDate \| null, collecting_date: MarketDate \| null, progress: { active_memberships: number, checkins: number, percent: number } \| null, upcoming_count: number }[] }` | no |

`next_date` = earliest `status === 'collecting'` with `start_at >= now`; `collecting_date` = latest date with `end_at <= now` and `status !== 'cancelled'` whose `end_at` is within the last `workflow.deadline_offset_min + 1440` minutes (the date whose check-ins are being collected); `progress` counts `producer_memberships` with `status === 'active'` for the market versus `checkins` with that `market_date_id` (`where('market_date_id','==',…)`). Markets filtered by `accessibleMarketIds`.

### 4.9 B's additions inside existing modules

| GET | `/admin/providers` | admin | — | `{ sms_provider: 'voipms'\|'console', email_provider: 'resend'\|'console', allow_real_sends: boolean, node_env: string, real_sends_possible: boolean }` (`real_sends_possible = selectSmsProvider` would return `'voipms'`) | no |

B deletes `GET /admin/users` from `src/routes/admin.ts` (A1's module owns that path; a duplicate route throws at boot).

## 5. MESSAGING + TEST MODE (B)

### 5.1 `src/config/env.ts`

```ts
import dotenv from 'dotenv';
dotenv.config(); // no override: a value already in process.env (tests, CI, Cloud Functions) always wins
…
SMS_PROVIDER: z.enum(['voipms', 'console']).default('console'),
EMAIL_PROVIDER: z.enum(['resend', 'console']).default('console'),
// Real providers are reachable only when NODE_ENV=production AND this is 'true' (SPEC §7.3).
ALLOW_REAL_SENDS: z.enum(['true', 'false']).default('false'),
```
Everything else in the schema stays. `.env.example` ships `SMS_PROVIDER=console`, `EMAIL_PROVIDER=console`, `ALLOW_REAL_SENDS=false` with the comment block from §5.6 and drops the "no console provider yet" warning. `.github/workflows/ci.yml` env: `SMS_PROVIDER: console`, `EMAIL_PROVIDER: console`, `ALLOW_REAL_SENDS: "false"`.

### 5.2 `src/services/sms.ts` — the single logged send

```ts
export type SmsProvider = 'voipms' | 'console';
export type SmsKind = 'otp' | 'invite' | 'admin_invite' | 'reminder' | 'broadcast' | 'opt_out_confirm' | 'opt_in_confirm' | 'help' | 'auto_reply' | 'alert' | 'support' | 'checkin' | 'booth';
export interface SendSmsArgs {
  env: Env; db: Firestore; to: string; body: string; kind: SmsKind;
  producer_id?: string | null; market_date_id?: string | null; user_id?: string | null; sent_by?: string | null;
  extra?: Record<string, unknown>;        // e.g. { broadcast_id }, { reminder_id }
}
export interface SendSmsResult { message_id: string; provider: SmsProvider; provider_message_id: string; status: 'sent' | 'simulated'; segments: number }
export class SendsDisabledError extends Error { readonly code = 'SENDS_DISABLED' }
export class SmsSendError extends Error { constructor(message: string, readonly message_id: string, readonly cause_message: string) }

/** Structural guard. Throws SendsDisabledError before any I/O. */
export function selectSmsProvider(env: Env): SmsProvider {
  if (env.SMS_PROVIDER === 'console') return 'console';
  if (env.NODE_ENV === 'production' && env.ALLOW_REAL_SENDS === 'true') return 'voipms';
  throw new SendsDisabledError(`SMS_PROVIDER=${env.SMS_PROVIDER} needs NODE_ENV=production and ALLOW_REAL_SENDS=true (got NODE_ENV=${env.NODE_ENV}, ALLOW_REAL_SENDS=${env.ALLOW_REAL_SENDS})`);
}
export function splitMessage(body: string): string[]            // unchanged
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult>   // throws SendsDisabledError | SmsSendError | (pre-write Firestore error)
export async function trySendSms(args: SendSmsArgs): Promise<({ ok: true } & SendSmsResult) | { ok: false; message_id: string | null; error: string }>
```

Lifecycle inside `sendSms`: (1) `provider = selectSmsProvider(env)` — throws before anything is written; (2) `message_id = uuid()`; `set` the `messages` row `{ direction: 'outbound', to, from: provider === 'console' ? 'console' : env.VOIPMS_DID ?? '', body, provider, provider_message_id: null, status: 'queued', status_at: now, error: null, kind, segments: chunks.length, producer_id ?? null, market_date_id ?? null, user_id ?? null, sent_by ?? null, created_at: now, ...extra }` — a failed pre-write throws (nothing is sent unlogged); (3) send every chunk: `voipms` → `voipmsSend` per chunk, `console` → `console.log('[sms:console] to=%s kind=%s segments=%d\n%s', to, kind, n, body)` and `provider_message_id = 'console-' + message_id`; (4) `update({ status: provider === 'console' ? 'simulated' : 'sent', provider_message_id, status_at })` — on failure retry once, then `console.error(...provider_message_id=...)` and still return (the text is out; same rule the Phase 1 code documented); (5) on a provider throw → `update({ status: 'failed', error, status_at })` (best-effort) and throw `SmsSendError`. `trySendSms` wraps `sendSms` and converts every throw into `{ ok: false }` (`SendsDisabledError` included — the webhook and broadcast loops must not 500). `src/services/voipms.ts` is imported by `sms.ts` and by nothing else (test-enforced, §9.4).

Callers B rewrites to the new signature (kind in brackets): `otp.ts` [`otp`], `routes/invite.ts` [`invite`, `user_id: inviter`], `reminders.ts` [`reminder`, `user_id`, `extra: { reminder_id }`] — delete the `notifications` write; the `messages` row is the audit row; `last_sent_date` updates only on success —, `push.ts notifyByPhoneSmsFirst` [`kind` param, default `'alert'`], `error-notify.ts` [`alert`, `db: getDb()`], `support-notify.ts` [`support`, `db: getDb()`], `inbound.ts` (replace `sendAndLogSms` with `trySendSms`, kinds unchanged; the inbound row gains `status_at`, `segments: 1`, `kind: 'inbound'`), `routes/admin.ts` broadcast (`trySendSms`, `kind: 'broadcast'`, `user_id`, `sent_by`, `extra: { broadcast_id }`; the `admin_broadcasts` summary row stays). `inbound.ts` `repliedRecently` counts `status === 'sent' || status === 'simulated'`.

### 5.3 `src/services/email.ts`

`sendEmail({ env, to, subject, message })` keeps its signature. Inside: `selectEmailProvider(env)` mirrors `selectSmsProvider` (`'console'` | `'resend'` only when production + flag, else throws `SendsDisabledError`); console provider logs `[email:console] to=… subject=…` and resolves. No `messages` row for email in Phase 2. The `resend` package is imported only here (test-enforced).

### 5.4 Vitest setup — `tests/setup/test-mode.ts` (+ `vitest.config.ts` `setupFiles: ['tests/setup/test-mode.ts']`)

```ts
import { beforeEach } from 'vitest';
process.env.NODE_ENV = 'test';
process.env.SMS_PROVIDER = 'console';
process.env.EMAIL_PROVIDER = 'console';
process.env.ALLOW_REAL_SENDS = 'false';
process.env.JWT_SECRET ??= 'test-secret';
process.env.ANTHROPIC_API_KEY ??= 'test';
function assertTestMode() {
  if (process.env.SMS_PROVIDER !== 'console' || process.env.EMAIL_PROVIDER !== 'console' || process.env.ALLOW_REAL_SENDS !== 'false' || process.env.NODE_ENV === 'production')
    throw new Error(`Refusing to run tests outside console test mode: SMS_PROVIDER=${process.env.SMS_PROVIDER} EMAIL_PROVIDER=${process.env.EMAIL_PROVIDER} ALLOW_REAL_SENDS=${process.env.ALLOW_REAL_SENDS} NODE_ENV=${process.env.NODE_ENV}`);
}
assertTestMode();
beforeEach(assertTestMode);
```
It runs before every test file's imports, so `getEnv()` in any test sees console providers regardless of the developer's `.env` (which `env.ts` no longer lets override). Tests that build their own `env` object (`app.decorate('env', {...})`) must also pass `SMS_PROVIDER: 'console'` unless they mock `../src/services/voipms.js` — never `sendSms` itself when the messages row is under test.

### 5.5 The proof that a real provider is unreachable without the flag (`tests/messaging.test.ts`, cases in §9.4)

`vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'vm-1') }))`; then `sendSms({ env: { ...base, SMS_PROVIDER: 'voipms', NODE_ENV: 'development', ALLOW_REAL_SENDS: 'true' }, … })` rejects with `SendsDisabledError`, the mock is never called and `db.dump('messages')` is empty; same with `NODE_ENV: 'production', ALLOW_REAL_SENDS: 'false'`; only `production` + `'true'` reaches the mock and writes a `sent` row.

### 5.6 needs_owner — production env before the Phase 2 functions deploy

The Cloud Functions environment comes from the dotenv files the Firebase CLI reads at deploy time (`.env` is excluded from the *bundle* by `functions.ignore` but still read by the CLI). To keep the dev machine safe, put the production values in **`.env.arkansaslocalfoodnetwork`** (read only for that project at deploy; `env.ts` never loads it locally) and keep `.env` on console providers:

```
# .env.arkansaslocalfoodnetwork  (deploy-time only; never loaded by npm run dev)
NODE_ENV=production
ALLOW_REAL_SENDS=true
SMS_PROVIDER=voipms
EMAIL_PROVIDER=resend
```
Without these three values the deployed `api` and `processReminders` run the console provider: OTP logins, reminders and broadcasts are logged as `simulated` and nothing reaches voip.ms or Resend. After deploying, `GET /api/admin/providers` (as admin) must show `sms_provider: "voipms"`, `email_provider: "resend"`, `allow_real_sends: true`; then one real OTP login is the smoke test. Also in the owner's hands: `VOIPMS_WEBHOOK_SECRET` (pending since 2026-06-12, S7) and the Secret Manager migration (S10, deferred to a later phase — not in this contract).

## 6. IDENTITY HELPER — `src/services/identity.ts` (D owns; A2 copies verbatim)

sha256 `085ca210046cec3c6ce5ab8970238f7c80c17143826424ec8d2bc06e41e45c59`, 290 lines, ends with one newline. Pure functions, no I/O. Verified against the repo's compiler options (`strict`, ES2022, bundler resolution) and the assertions in §9.5.

```ts
/**
 * Producer identity resolution (SPEC §7.9): identity by email, never by name
 * alone. Pure functions, no I/O, fully unit-testable.
 *
 * SHARED VERBATIM: executor D owns this file; executor A2 copies it
 * byte-for-byte. Do not reformat, do not add code here — put extensions in
 * your own module and import from this one.
 *
 * Two survey rows belong to the same producer when they share any of:
 *   1. a normalized email address,
 *   2. a non-generic email domain (a business domain), or
 *   3. the first significant word of the vendor name (see nameKey).
 * Union-find over those three keys yields the clusters.
 */

/** Consumer mail domains that must never link two producers. */
export const GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com', 'gmx.com',
  'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net', 'cox.net', 'charter.net',
  'verizon.net', 'earthlink.net', 'centurylink.net', 'windstream.net', 'suddenlink.net',
  'example.com',
]);

/** Words that mark a name as a business rather than a person. */
export const BUSINESS_WORDS: ReadonlySet<string> = new Set([
  'farm', 'farms', 'farmstead', 'bakery', 'bakehouse', 'bakes', 'baking', 'co', 'company',
  'llc', 'inc', 'ltd', 'market', 'markets', 'coffee', 'kitchen', 'orchard', 'orchards',
  'ranch', 'nursery', 'homestead', 'microgreens', 'crafts', 'project', 'network', 'garden',
  'gardens', 'greenhouse', 'acres', 'apiary', 'honey', 'creamery', 'dairy', 'produce',
  'foods', 'eggs', 'meats', 'soap', 'soaps', 'candles', 'pottery', 'studio', 'sweets',
  'treats', 'mushrooms', 'flowers', 'herbs', 'creations', 'provisions', 'goods',
  'collective', 'cooperative', 'coop', 'bbq', 'jams', 'jellies',
]);

/** Articles and prepositions skipped when looking for the first significant word. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'of', 'at', 'by', 'from', 'for', 'with', 'in', 'on', 'to', 'my', 'our',
]);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Lower-cased, trimmed, stripped of `mailto:` and `Name <addr>` wrapping and
 * of embedded whitespace. Returns null when the result is not an email.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  if (s.startsWith('mailto:')) s = s.slice('mailto:'.length);
  s = s.replace(/\s+/g, '');
  return isValidEmail(s) ? s : null;
}

/** Domain part of a normalized email, or null when the input is not an email. */
export function emailDomain(email: string | null | undefined): string | null {
  const n = normalizeEmail(email);
  if (!n) return null;
  return n.slice(n.lastIndexOf('@') + 1);
}

export function isGenericDomain(domain: string): boolean {
  return GENERIC_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Lower-case ASCII tokens of a name: accents stripped, `&`/`+` mapped to
 * "and", possessive `'s` dropped ("Sarah's" → "sarah"), punctuation removed.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return s ? s.split(' ') : [];
}

/**
 * The first significant word of a name: the first token that is at least two
 * characters long and not a stop word. Empty string when there is none.
 */
export function nameKey(name: string | null | undefined): string {
  for (const t of nameTokens(name)) {
    if (t.length >= 2 && !STOP_WORDS.has(t)) return t;
  }
  return '';
}

export function looksLikeBusiness(name: string | null | undefined): boolean {
  return nameTokens(name).some((t) => BUSINESS_WORDS.has(t));
}

/** Minimal union-find (disjoint set) over integer indexes. */
export class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array<number>(size).fill(0);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[i] !== root) {
      const next = this.parent[i];
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }

  /** Members of every set, each ascending, sets ordered by their smallest member. */
  groups(): number[][] {
    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i += 1) {
      const root = this.find(i);
      const members = byRoot.get(root);
      if (members) members.push(i);
      else byRoot.set(root, [i]);
    }
    return [...byRoot.values()].sort((x, y) => x[0] - y[0]);
  }
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Pick the canonical spelling from `variants` (name → occurrence count):
 * business-looking names beat person-looking ones, then the most frequent,
 * then the longest (most complete), then alphabetical. Names are compared
 * trimmed with whitespace collapsed; the returned name is in that form.
 */
export function chooseCanonicalName(variants: Map<string, number>): string {
  let bestName = '';
  let bestScore: number[] | null = null;
  const counts = new Map<string, number>();
  for (const [name, count] of variants) {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + count);
  }
  for (const [name, count] of counts) {
    const score = [looksLikeBusiness(name) ? 1 : 0, count, name.length];
    const cmp = bestScore ? compareScores(score, bestScore) : 1;
    if (cmp > 0 || (cmp === 0 && name < bestName)) {
      bestName = name;
      bestScore = score;
    }
  }
  return bestName;
}

export interface IdentityRow {
  /** Vendor name as typed on the form (may be a business or a person). */
  name: string;
  /** Every email cell of the row; blanks and invalid values are ignored. */
  emails: Array<string | null | undefined>;
}

export interface IdentityCluster {
  /** Indexes into the input rows, ascending. */
  rows: number[];
  canonical_name: string;
  /** Every other distinct name variant (trimmed, whitespace collapsed), sorted. */
  aliases: string[];
  /** Every normalized email seen in the cluster, sorted. */
  emails: string[];
  /** Non-generic email domains seen in the cluster, sorted. */
  domains: string[];
  /** Distinct name keys seen in the cluster, sorted. */
  name_keys: string[];
}

/**
 * Cluster rows into producers by union-find over normalized email,
 * non-generic email domain and name key, then choose one canonical name per
 * cluster: among the business-looking variants when any exist (otherwise all
 * variants), the largest name-key group by occurrences wins, and
 * chooseCanonicalName picks the spelling within that group.
 */
export function resolveProducerIdentity(rows: IdentityRow[]): IdentityCluster[] {
  const uf = new UnionFind(rows.length);
  const byEmail = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byNameKey = new Map<string, number>();

  const link = (map: Map<string, number>, key: string, index: number) => {
    const first = map.get(key);
    if (first === undefined) map.set(key, index);
    else uf.union(first, index);
  };

  rows.forEach((row, index) => {
    for (const raw of row.emails) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      link(byEmail, email, index);
      const domain = email.slice(email.lastIndexOf('@') + 1);
      if (!isGenericDomain(domain)) link(byDomain, domain, index);
    }
    const key = nameKey(row.name);
    if (key) link(byNameKey, key, index);
  });

  return uf.groups().map((members) => {
    const variants = new Map<string, number>();
    const emails = new Set<string>();
    const domains = new Set<string>();
    const keys = new Set<string>();
    for (const i of members) {
      const clean = rows[i].name.trim().replace(/\s+/g, ' ');
      if (clean) variants.set(clean, (variants.get(clean) ?? 0) + 1);
      for (const raw of rows[i].emails) {
        const email = normalizeEmail(raw);
        if (!email) continue;
        emails.add(email);
        const domain = email.slice(email.lastIndexOf('@') + 1);
        if (!isGenericDomain(domain)) domains.add(domain);
      }
      const key = nameKey(rows[i].name);
      if (key) keys.add(key);
    }

    const business = new Map<string, number>();
    for (const [name, count] of variants) if (looksLikeBusiness(name)) business.set(name, count);
    const pool = business.size > 0 ? business : variants;

    const groups = new Map<string, Map<string, number>>();
    for (const [name, count] of pool) {
      const key = nameKey(name);
      const group = groups.get(key) ?? new Map<string, number>();
      group.set(name, count);
      groups.set(key, group);
    }
    let largest: Map<string, number> = new Map();
    let largestTotal = -1;
    let largestKey = '';
    for (const [key, group] of groups) {
      const total = [...group.values()].reduce((sum, n) => sum + n, 0);
      if (total > largestTotal || (total === largestTotal && key < largestKey)) {
        largest = group;
        largestTotal = total;
        largestKey = key;
      }
    }
    const canonical = chooseCanonicalName(largest);

    return {
      rows: members,
      canonical_name: canonical,
      aliases: [...variants.keys()].filter((n) => n !== canonical).sort(),
      emails: [...emails].sort(),
      domains: [...domains].sort(),
      name_keys: [...keys].sort(),
    };
  });
}
```

## 7. THE IMPORTER (D, `scripts/import-survey.mjs`)

**Invocation.** `npm run import:survey -- --source <path|gs://bucket/object> --market wlrfm [--dry-run | --write] [--db-project <id>] [--json]` (`"import:survey": "tsx scripts/import-survey.mjs"`; tsx is required because the script imports TypeScript with explicit extensions: `import { resolveProducerIdentity, normalizeEmail, nameKey } from '../src/services/identity.ts'` and `import { localToUtc, utcToLocalDate, weekdayOf, addDays, DAYS_OF_WEEK } from '../src/utils/tz.ts'`). `--dry-run` is the default; `--write` is required for any Firestore write. `--db-project` (default `GCLOUD_PROJECT`) is passed to `initializeApp({ projectId })`; credentials come from ADC / `GOOGLE_APPLICATION_CREDENTIALS` (never `service-account.json` in the repo). `firebase-admin` is imported lazily inside `main()` only, so `vitest` can import the module without initialising Firebase. `gs://` sources are downloaded with `getStorage().bucket(b).file(o).download()` to `os.tmpdir()` and deleted after parsing. The CLI runs only under `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`.

**Exports for tests.** `parseTsv(text): string[][]` (records padded to 13 cells), `parseTimestamp(raw, timeZone): { at: Date, local_date: string } | null`, `parseMoney(raw)`, `parseCount(raw)`, `parseYesNo(raw)`, `parseWinter(raw)`, `splitItems(raw)`, `assignMarketDate(localDate, market): string | null`, `rowHash(cells)`, `runImport({ text, marketId, db, write, now, log }): Promise<ImportReport>`.

**TSV parsing** (Google Sheets export, RFC-4180 with tab delimiter): fields separated by `\t`; a field starting with `"` runs until the closing `"` and may contain `\t`, `\n`, `\r\n`; `""` inside quotes is a literal quote; records end at `\n`/`\r\n` outside quotes; the first record is the header and is skipped; a record whose cells are all blank is skipped; every record is padded with `''` to 13 cells. Column indexes 0..12 map to: 0 Timestamp · 1 Vendor Name · 2 Email · 3 Estimated Total Sales · 4 sold out? · 5 attending next week? · 6 bringing next week · 7 feedback · 8 rotating weekly question · 9 transactions/customers · 10 did not sell · 11 Email Address · 12 winter-season interest.

**Field parsing** (raw text is always kept beside the parsed value):
- Timestamp: `M/D/YYYY H:MM:SS`, `M/D/YYYY`, `M/D/YY` (2-digit → 2000+; missing time → `00:00:00`), interpreted in the market's `timezone` with `localToUtc`; unparseable → row skipped, counted `rows_bad_timestamp`.
- Market date: `assignMarketDate(localDate, market)` = the latest date `≤ localDate` whose weekday ∈ the applicable version's `days_of_week` and that lies within `[season_start, season_end]` (for WLRFM: the latest Saturday on or before the response). A response on the market day itself maps to that day. None (before the season) → skipped, counted `rows_unassigned`.
- `estimated_sales`: strip `$`, `,`, spaces; `^\d+(\.\d+)?$` → `{ value, kind: 'exact' }`; `^\d+(\.\d+)?\s*[-–to]+\s*\d+(\.\d+)?$` → midpoint, `kind: 'range'`; else `{ value: null, kind: 'none' }`; `value > 20000` → flag `sales_outlier`.
- `transactions_estimate`: first integer in the text (`80ish` → 80, `about 30` → 30, `29 cards, 5 Cash App, and $200 cash` → 29); more than one integer → flag `transactions_ambiguous`; none → null.
- `attending_next`: `/^\s*y(es)?\b/i` → true, `/^\s*no?\b/i` → false, else null. `winter_interest`: `yes|maybe|no` (case-insensitive prefix) else absent.
- `sold_out_items`/`unsold_items`: split raw on `/[,;\n]|\band\b/i`, trim, drop empties and `/^(no|none|nope|nothing|n\/?a|-|no\.)$/i`; if the whole raw matches that pattern the list is `[]`. `bringing_next` stays `[]`; `bringing_next_raw` = cell 6.
- Identity input per row: `{ name: cell1, emails: [cell2, cell11] }`.

**Writes (only with `--write`; dry-run computes the identical report):**
1. `farmers_markets/wlrfm` — created with the §2.1 WLRFM document if missing; an existing market is never modified (its schedule is read to map dates).
2. `market_dates/wlrfm_<date>` for every date that received ≥1 response: created with the §2.2 shape (`schedule_version` = the applicable version id, `special: false`, `status: 'collecting'`, `source: 'import'`, `cancelled_* null`, `actions` from `end_at + workflow.deadline_offset_min`); existing docs are left alone except that `extra_questions` gains (idempotently, by `key`) `{ key: 'weekly_question', prompt: 'Weekly question (prompt not present in the export)', type: 'text' }` when any row of that date answered it and `{ key: 'winter_interest', prompt: 'Are you interested in a winter season?', type: 'choice', options: ['yes','maybe','no'] }` when any row answered it.
3. `producers`: all existing producers are loaded once; a cluster matches an existing producer when they share a normalized email, or — only for clusters with no email at all — an existing `name_key` or alias equal to the cluster's canonical name. Matched → `set(..., { merge: true })` with `emails` ∪, `aliases` ∪ (minus `business_name`), `updated_at`; unmatched → new doc: `business_name: cluster.canonical_name`, `name_key`, `contact_name: ''`, `phone: null`, `email: cluster.emails[0] ?? null`, `emails`, `aliases`, `products: []`, `category: ''`, `documents: []`, `sms_consent: { status: 'unknown', at: null, source: 'import' }`, `sms_opt_out_at: null`, `user_id: null`, `legacy_farm_id: null`, `notes: ''`, `source: 'import'`, `active: true`. A cluster whose canonical name is empty is skipped (`clusters_unnamed`).
4. `producer_memberships/<producer_id>_wlrfm`: created `status: 'active'`, `fee_plan: 'weekly'`, `source: 'import'`, history `[{ from: null, to: 'active', by: 'import' }]`; existing memberships are never downgraded (an `inactive` one is left alone).
5. `checkins/<market_date_id>_<producer_id>`: `raw_import = { row_hash: sha256(cells.join('\t')), source: <basename of --source>, cells, timestamp_raw, duplicates }`. Missing → create (`checkins_created`). Existing with the same `row_hash` → `checkins_unchanged`. Existing with a different hash: if this row's timestamp is later → overwrite, `duplicates + 1`, flag `duplicate_response` (`checkins_updated`); else leave, count `checkins_duplicates_ignored`. Two rows for the same pair inside one run follow the same rule (latest timestamp wins).

**Idempotency.** The second `--write` run over the same file reports `producers_created: 0, producers_updated: 0, market_dates_created: 0, checkins_created: 0, checkins_updated: 0`.

**Report (stdout; `--json` prints the object).** Counts only: `rows_read, rows_skipped_blank, rows_bad_timestamp, rows_unassigned, dates_seen, market_created, market_dates_created, market_dates_existing, clusters, clusters_unnamed, producers_matched, producers_created, producers_updated, memberships_created, memberships_existing, checkins_created, checkins_updated, checkins_unchanged, checkins_duplicates_ignored, flags: { sales_outlier, transactions_ambiguous, duplicate_response }`, then a table `business name · rows · alias count · email count` (canonical names only — never an email address, never a sales figure, never a raw cell) and the list of dates with their response counts. Log lines go through the injected `log` so tests capture them and assert no `@` appears.

**Tests** (`tests/import-survey.test.ts`): build a 10-row TSV with `tests/helpers/survey-fixture.ts` (fake names such as "Testfield Farm", "Terry Testfield", fake `@example.com` / `@testfield.example` addresses, no real data), run `runImport` against `fakeDb()` with `write: true`, then again, and assert the §9.6 cases. The real file is never read by a test.

## 8. WEB (C, `web/src/**`)

### 8.1 Constraints
- The build must stay **fully static** (Firebase Hosting's frameworks integration would otherwise spin up an SSR function; D11 is pending). Therefore **no `[param]` route folders**: detail pages are `.../detail/page.tsx` reading `useSearchParams().get('id')`, wrapped in `<Suspense>` (required for static prerender in Next 15). Links: `/admin/markets/detail?id=wlrfm`, `/admin/producers/detail?id=<uuid>`.
- `web/src/components/staff-guard.tsx` exports `useStaffGuard(opts?: { adminOnly?: boolean })` → `{ user, isAdmin, ready }`: redirects to `/login` when not authenticated, when the role is not `admin`/`market_manager`, or (adminOnly) not admin. `market_manager` sees only assigned markets — every list the API returns is already scoped; the UI additionally hides "New market", `/admin/applications`, `/admin/users`, `/admin/broadcast`, the producer `notes` field and every sales column from managers.
- `web/src/components/form.tsx` exports `SectionCard`, `Field`, `TextArea`, `SelectField`, `SaveBar` (moved verbatim from `settings/page.tsx`, which now imports them) plus new `CheckboxField`, `DateField` (`type="date"`), `TimeField` (`type="time"`), `ListEditor` (string list with add/remove), `ConfirmButton` (two-click confirm, the broadcast pattern). `status-chip.tsx` exports `StatusChip({ status })` with colours for membership/application/date statuses. `lib/types.ts` mirrors §2 (`Market`, `ScheduleVersion`, `MarketDate`, `Producer`, `Membership`, `Application`, `Checkin`, `StaffUser`, `DashboardCard`, `GenerateResult`).
- `auth-context.tsx`: `AuthUser` = `{ id, name, role, phone, email: string | null, assigned_market_ids: string[] }` (defaults `[]`/`null` when the API omits them). `login/page.tsx` redirects `admin` and `market_manager` to `/admin`. `header.tsx` nav for staff: Dashboard `/admin` · Markets `/admin/markets` · Producers `/admin/producers` · Applications `/admin/applications` (admin) · Users `/admin/users` (admin) · Broadcast `/admin/broadcast` (admin) · Feedback · Settings; `active` = `pathname.startsWith(href)` for the section roots (exact match for `/admin`). The wordmark reads "SJCA Markets".

### 8.2 `web/src/lib/api.ts` — helpers (exact names; all use the existing `request<T>`)

```ts
// Markets
getPublicMarkets: () => request<{ markets: PublicMarket[] }>('/markets/public'),
getMarkets: () => request<{ markets: Market[] }>('/markets'),
getMarket: (id: string) => request<{ market: Market }>(`/markets/${id}`),
createMarket: (data: CreateMarketInput) => request<{ market: Market; generation: GenerateResult }>('/markets', { method: 'POST', body: JSON.stringify(data) }),
updateMarket: (id: string, data: Partial<UpdateMarketInput>) => request<{ market: Market; generation?: GenerateResult }>(`/markets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
addScheduleVersion: (id: string, data: ScheduleVersionInput) => request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/versions`, { method: 'POST', body: JSON.stringify(data) }),
deleteScheduleVersion: (id: string, versionId: string) => request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/versions/${versionId}`, { method: 'DELETE' }),
setSkippedDates: (id: string, skipped_dates: SkippedDate[]) => request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/skipped`, { method: 'PUT', body: JSON.stringify({ skipped_dates }) }),
setSpecialDates: (id: string, special_dates: SpecialDate[]) => request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/special`, { method: 'PUT', body: JSON.stringify({ special_dates }) }),
generateDates: (id: string, scope: 'window' | 'season' = 'window') => request<{ generation: GenerateResult }>(`/markets/${id}/dates/generate`, { method: 'POST', body: JSON.stringify({ scope }) }),
getMarketDates: (id: string, params?: { from?: string; to?: string; status?: string }) => request<{ dates: MarketDate[] }>(`/markets/${id}/dates${qs(params)}`),
updateMarketDate: (id: string, dateId: string, data: UpdateMarketDateInput) => request<{ date: MarketDate }>(`/markets/${id}/dates/${dateId}`, { method: 'PATCH', body: JSON.stringify(data) }),
// Producers / memberships / check-ins
getProducers: (params?: { market_id?: string; status?: string; q?: string; include_inactive?: 'true' }) => request<{ producers: ProducerListItem[] }>(`/producers${qs(params)}`),
getProducer: (id: string) => request<{ producer: Producer; memberships: Membership[]; checkins_summary: { count: number; last_submitted_at: string | null } }>(`/producers/${id}`),
createProducer: (data: CreateProducerInput) => request<{ producer: Producer; memberships: Membership[] }>('/producers', { method: 'POST', body: JSON.stringify(data) }),
updateProducer: (id: string, data: Partial<UpdateProducerInput>) => request<{ producer: Producer }>(`/producers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
getMemberships: (params: { market_id: string } | { producer_id: string }) => request<{ memberships: MembershipWithProducer[] }>(`/memberships${qs(params)}`),
createMembership: (data: { producer_id: string; market_id: string; status?: MembershipStatus; fee_plan?: FeePlan }) => request<{ membership: Membership }>('/memberships', { method: 'POST', body: JSON.stringify(data) }),
updateMembership: (id: string, data: { status?: MembershipStatus; fee_plan?: FeePlan; usual_booth_id?: string | null; note?: string }) => request<{ membership: Membership }>(`/memberships/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
getCheckins: (params: { market_date_id: string } | { producer_id: string }) => request<{ checkins: Checkin[] }>(`/checkins${qs(params)}`),
// Applications
submitApplication: (data: ApplicationInput) => request<{ id: string; status: 'new' }>('/applications', { method: 'POST', body: JSON.stringify(data) }),
getApplications: (params?: { status?: string }) => request<{ applications: Application[] }>(`/applications${qs(params)}`),
getApplication: (id: string) => request<{ application: Application }>(`/applications/${id}`),
reviewApplication: (id: string, data: { action: 'review' } | { action: 'decline'; note?: string } | { action: 'approve'; market_ids: string[]; note?: string }) => request<{ application: Application; producer?: Producer; memberships?: Membership[] }>(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
// Staff users, audit, dashboard, providers
getStaffUsers: () => request<{ users: StaffUser[] }>('/admin/users'),
inviteStaffUser: (data: { phone: string; name: string; role: 'admin' | 'market_manager'; assigned_market_ids: string[]; email?: string }) => request<{ user: StaffUser; sms: SmsOutcome }>('/admin/users/invite', { method: 'POST', body: JSON.stringify(data) }),
resendStaffInvite: (id: string) => request<{ sms: SmsOutcome }>(`/admin/users/${id}/resend-invite`, { method: 'POST' }),
updateStaffUser: (id: string, data: Partial<{ name: string; email: string | null; role: 'admin' | 'market_manager'; assigned_market_ids: string[]; active: boolean }>) => request<{ user: StaffUser }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
getAuditLog: (params?: { limit?: number; collection?: string; actor_id?: string; action_prefix?: string }) => request<{ entries: AuditEntry[] }>(`/audit-log${qs(params)}`),
getDashboard: () => request<{ generated_at: string; markets: DashboardCard[] }>('/dashboard'),
getProviders: () => request<{ sms_provider: string; email_provider: string; allow_real_sends: boolean; node_env: string; real_sends_possible: boolean }>('/admin/providers'),
```
`qs(params)` = `''` when empty, else `'?' + new URLSearchParams(defined entries)`. Existing helpers stay; `getAdminUsers` is deleted (its endpoint moves), `sendBroadcast`/`getBroadcasts`/`getUtilization` stay for `/admin/broadcast`.

### 8.3 Pages

| Page | Guard | Helpers | Content |
|---|---|---|---|
| `/admin` (`admin/page.tsx`, rewritten) | staff | `getDashboard`, `getProviders` (admin; swallow 403) | Banner "Test mode — texts and emails are simulated" when `real_sends_possible === false`. One card per market: name, next date (`date`, `start_time–end_time` shown as market-local strings — no browser tz math), status chip, "Collecting: <date>" with a progress bar `checkins/active_memberships (percent)`, links to `/admin/markets/detail?id=` and `/admin/producers?market_id=`. |
| `/admin/broadcast` | admin | `getUtilization`, `sendBroadcast`, `getBroadcasts` | The three old tabs, unchanged behaviour. |
| `/admin/markets` | staff | `getMarkets`, `createMarket` | Table: name, location, timezone, active, next date; admin "New market" inline form (slug, name, location, timezone select from a short IANA list defaulting to `America/Chicago`, one schedule version, quiet hours) → create → navigate to detail. |
| `/admin/markets/detail?id=` | staff (edits admin-only) | `getMarket`, `updateMarket`, `addScheduleVersion`, `deleteScheduleVersion`, `setSkippedDates`, `setSpecialDates`, `generateDates`, `getMarketDates`, `updateMarketDate` | Sections: Settings (name, location, timezone, active, `SaveBar`) · Workflow offsets (four numeric minutes fields + reminder list) · Quiet hours (two `TimeField`) · Schedule versions (table + "Add version" form with weekday checkboxes; delete with `ConfirmButton`) · Skipped dates (`ListEditor` of date+reason) · Special dates (date, start, end, note) · "Regenerate dates" (`window` button, `season` button; shows the `GenerateResult` counts) · Dates table (date, weekday, times, status chip, schedule version, actions: Cancel with reason prompt / Un-cancel; expandable extra-questions editor: key, prompt, type, options). Every write re-fetches the market and dates. |
| `/admin/producers` | staff | `getProducers`, `getMarkets`, `createProducer` | Filters: market select (managers: assigned only, required), status chips filter, search box (`q`), include inactive. Table: business name (link to detail), contact, phone/email (admin), memberships as `StatusChip` per market. Admin "New producer" form. |
| `/admin/producers/detail?id=` | staff | `getProducer`, `updateProducer`, `getMemberships({producer_id})`, `createMembership`, `updateMembership`, `getCheckins({producer_id})`, `getMarkets` | Edit form (business name, contact, phone, email, category, notes admin-only, `SaveBar`) · Aliases (`ListEditor`; canonical rename moves the old name to aliases automatically — show a hint) · Emails (`ListEditor`) · Memberships: one row per market with status chip and the allowed next transitions as buttons (§4.3 table; `market_manager` only for assigned markets) plus "Add to market" (admin) · Recent check-ins table (date, attending next, transactions, sold out, unsold; **sales column only when `isAdmin`**). |
| `/admin/applications` | admin | `getApplications`, `reviewApplication`, `getMarkets` | Status tabs (new / under_review / approved / declined). Row expands to the page-1 fields, requested markets and `extra` key/values. Actions: "Start review", "Approve…" (modal with a checkbox per requested market, preselected, optional note; calls `approve`), "Decline…" (note). Approved rows link to the producer. |
| `/admin/users` | admin | `getStaffUsers`, `inviteStaffUser`, `resendStaffInvite`, `updateStaffUser`, `getMarkets` | Table: name, phone, role, assigned markets, active, invited. "Invite by text" form (phone, name, role radio, market checkboxes shown for market_manager). Inline edit of role / markets / active (cannot edit self's role/active). Result toast shows `sms.status` (`simulated` is normal in dev). |
| `/apply` (public) | none | `getPublicMarkets`, `submitApplication` | Page 1: email, business name, contact person, phone, "Which markets?" checkboxes from `getPublicMarkets` (name + next date). Page 2: placeholder card "More questions coming — SJCA is finalising the application; you can submit now." and Submit (`extra: {}`). Success: "Thanks — St. Joseph Center of Arkansas will review your application and text you." Errors from the API shown inline (409 duplicate → "We already have a recent application for this email"). Text-first footer link to the SMS number stays. |

Existing `/feedback`, `/settings`, `/changed`, `/login` keep working; `/` gains the "Apply to sell at our markets" link.

## 9. TESTS

All tests: vitest, `tests/**/*.test.ts`, `fakeDb()` from `tests/helpers/fake-db.ts`, routes registered directly on a bare `Fastify()` with `app.decorate('db', db as never)` / `app.decorate('env', {...} as never)` and `app.setErrorHandler(createErrorHandler({ env, notify: false }))` (the existing pattern). Any test that imports a route module `vi.mock`s `../src/services/sms.js` (and `../src/services/otp.js` where reached) unless the messages row is the subject (B). JWTs for auth tests: `signJwt({ sub, role }, 'test-secret')` with a seeded `users` doc.

### 9.1 A1 — `tests/tz.test.ts`
`localToUtc('2026-04-18','08:00','America/Chicago') → 2026-04-18T13:00:00.000Z` and `'12:00' → 17:00Z` · spring forward: `2026-03-07 08:00 → 14:00Z`, `2026-03-08 08:00 → 13:00Z`, `2026-03-08 01:59 → 07:59Z`, gap `2026-03-08 02:30 → 08:30Z` (later instant) · fall back: `2026-10-31 08:00 → 13:00Z`, `2026-11-01 08:00 → 14:00Z`, ambiguous `2026-11-01 01:30 → 06:30Z` (first occurrence), `2026-11-01 00:30 → 05:30Z` · Thursday-night market: `2026-03-05 17:00 → 23:00Z`, `2026-03-12 17:00 → 22:00Z`, `2026-03-12 20:00 → 2026-03-13T01:00Z` · `utcToLocalDate(2026-04-19T04:59Z) = '2026-04-18'`, `(05:00Z) = '2026-04-19'` · `weekdayOf('2026-04-18') = 'saturday'`, `'2026-11-01' = 'sunday'` · `addDays('2026-02-28',1) = '2026-03-01'` · invalid date/time throw · `isValidTimeZone('Mars/Olympus') = false`.

### 9.2 A1 — `tests/market-dates.test.ts` (generator; `now` injected)
1. Saturday 8–12 market, `scope: 'season'` over 2026-04-18..10-31 → exactly 29 dates (every Saturday from `wlrfm_2026-04-18` to `wlrfm_2026-10-31`); `start_at` 13:00Z / `end_at` 17:00Z in CDT; all `collecting`; `actions.deadline_at = end_at + 4320 min`.
2. Thursday 17–20 market spanning both DST transitions (season 2026-03-01..2026-11-30): `2026-03-05` start 23:00Z, `2026-03-12` 22:00Z, `2026-10-29` 22:00Z, `2026-11-05` 23:00Z (both ways).
3. Skipped date: `skipped_dates: [{ date: '2026-07-04', reason: 'Holiday' }]` → no doc on first run (`skipped: 1`); when the doc already existed and was undecided → `cancelled: 1`, `cancelled_by: 'generator'`, reason `'skipped: Holiday'`; un-skipping revives it (`updated`, status back to `collecting`).
4. Special date: `special_dates: [{ date: '2026-12-12', start_time: '10:00', end_time: '14:00', note: 'Holiday market' }]` outside the season and not a Saturday-in-season rule → created with `special: true`, `schedule_version: 'special'`, those times.
5. Mid-season version change: second version `effective_from: '2026-08-01'`, `days_of_week: ['sunday']`; regenerate season → Saturdays before Aug 1 unchanged, undecided Saturdays ≥ Aug 1 cancelled (`schedule_change`), Sundays ≥ Aug 2 created; a past Saturday (`end_at < now`) and a Saturday with `actions.checkin_sent_at` set or `status: 'published'` are `frozen` and byte-identical before/after; a date with `extra_questions` keeps them through a time change.
6. Idempotent regenerate: run twice → second result `{ created: 0, updated: 0, cancelled: 0 }`, docs deep-equal (ignoring `generated_at`/`updated_at`).
7. Window scope with `now = 2026-06-10T12:00Z` → `from '2026-06-03'`, `to '2026-08-05'`, only Saturdays inside are created.
8. Admin-cancelled date (`cancelled_by: 'u1'`) is never revived.

### 9.3 A1 — `tests/rbac.test.ts`, `tests/markets-routes.test.ts`, `tests/admin-users.test.ts`, `tests/app-boot.test.ts`
rbac: `authenticate` populates `assigned_market_ids` (`[]` when absent) and rejects `active: false` with 401; `requireRole('admin')` rejects `market_manager` (403) and legacy `farmer` (403); `requireMarketAccess(marketIdFromParams())`: admin passes any id, manager assigned `['argenta']` gets **403 on `/markets/wlrfm`** and 200 on `/markets/argenta`, missing id → 400. markets-routes: POST creates + generates, `GET /markets` filtered for a manager, PATCH timezone triggers regeneration, PUT skipped/special validate and 409 on overlap, DELETE last version 409, `GET /markets/public` lists only active markets without `mailchimp`, cancel requires a reason, every mutating route leaves exactly one `audit_log` row with the named action. admin-users: invite creates the user + `invites` row and calls the mocked `sendSms` with `kind: 'admin_invite'`; a failing `sendSms` still returns 201 with `sms.status: 'failed'`; market_manager without markets → 400; duplicate phone → 409; self-demotion → 409; `GET /me` returns `assigned_market_ids`. app-boot: `it.skipIf(!existsSync('src/routes/producers.ts'))` → `buildApp({ db: fakeDb(), env })` + `ready()` succeeds (catches duplicate routes post-merge) and `GET /api/health` is 200.

### 9.4 B — `tests/messaging.test.ts`, `tests/email.test.ts`, `tests/reminders.test.ts`, adapted `tests/sms-webhook-auth.test.ts`
messaging: console provider writes one row `{ direction: 'outbound', provider: 'console', status: 'simulated', provider_message_id: 'console-<id>', kind, segments, from: 'console' }` and returns `status: 'simulated'` · a 400-char body writes `segments: 3` and logs once · `SMS_PROVIDER: 'voipms'` with `NODE_ENV: 'development', ALLOW_REAL_SENDS: 'true'` rejects with `SendsDisabledError`, voipms mock not called, no row · `production` + `'false'` same · `production` + `'true'` calls the voipms mock once per segment, row `status: 'sent'`, `provider_message_id: 'vm-1'` · provider throw → row `failed` with `error`, `sendSms` rejects `SmsSendError`, `trySendSms` resolves `{ ok: false }` · pre-write Firestore failure → nothing sent, rejects · post-send update failing twice → still resolves, `console.error` once with the provider id · structural: reading `src/**/*.ts`, only `src/services/sms.ts` imports `voipms.js`; only `src/services/email.ts` imports `'resend'`; `src/config/env.ts` contains no `override: true`; `getEnv()` with `SMS_PROVIDER` unset yields `'console'` and `ALLOW_REAL_SENDS` `'false'`. email: console provider resolves and logs; resend blocked without the flag. reminders: a due reminder sends via the mocked provider and writes a `messages` row `kind: 'reminder'` with `reminder_id` and **no `notifications` doc**; opted-out user skipped; failure leaves `last_sent_date` untouched. sms-webhook-auth: same cases as today re-pointed at rows produced by `trySendSms` (status `simulated` under the console env; the flaky-log cases target the post-send `update`).

### 9.5 D — `tests/identity.test.ts` (FAKE names only)
`normalizeEmail` cases (case, whitespace, `Name <addr>`, `mailto:`, invalid → null) · `emailDomain` · `nameKey`: `'The Testfield Farm' → 'testfield'`, `"Sarah's Sweets" → 'sarah'`, `'Sarah Sample' → 'sarah'`, `'J & J Produce' → 'produce'`, `'Émile Gâteaux' → 'emile'`, `'' → ''` · `looksLikeBusiness` · `chooseCanonicalName(Map{'Quincy Quill':9,'Quill Family Farm':2}) = 'Quill Family Farm'` and the tie/whitespace case · `UnionFind.groups()` · `resolveProducerIdentity` over the survey's alias *patterns* with fake names: (a) business name + person + lower-case variant linked through a business domain and a shared first word → one cluster, canonical = the business spelling, aliases sorted, emails sorted, `name_keys`; (b) person name and business sharing one gmail address → one cluster (email links, gmail domain never does); (c) two unrelated gmail users → separate; (d) `'Terry Testfield'` does **not** join `'Testfield Farm'` (first word differs) while `'Testfield, Terry'` does; (e) rows with no email and no name form singleton clusters with empty canonical.

### 9.6 D — `tests/import-survey.test.ts` (10-row synthetic fixture generated by the test)
Fixture rows: two Saturdays (`2026-04-18`, `2026-04-25`) with responses timestamped Sat 12:30, Sun, Mon and Fri 23:59 (→ the preceding Saturday), one `M/D/YY` timestamp, one before the season (unassigned), one quoted multi-line feedback with `""`, one row missing the trailing columns, sales `$1,000.00`, `500-1000`, `N/a`, `$45,690.00`, transactions `80`, `80ish`, `29 cards, 5 Cash App, and $200 cash`, winter `Maybe`, and three identity variants of one producer. Assertions: `parseTsv` pads to 13 and keeps embedded tabs/newlines · identity clusters → producer count and canonical names · Saturday mapping (Sun/Mon/Fri rows land on the same `market_date_id`; the 12:30 Saturday row on its own day) · `rows_unassigned: 1` · market created with the §2.1 shape; `market_dates` created with `start_at` 13:00Z; `extra_questions` contain `weekly_question` and `winter_interest` exactly once · checkins: ids `wlrfm_<date>_<producer>`, `estimated_sales.raw` kept, range midpoint 750, `N/a` → null/`'none'`, outlier flag, `transactions_estimate.value` 80/80/29 with the ambiguous flag, `attending_next`, `extra_answers.winter_interest: 'maybe'`, `raw_import.cells.length === 13` · memberships `active` · idempotent second run → zero created/updated and identical `db.dump` (ignoring `updated_at`) · a duplicate later response for the same pair overwrites and increments `duplicates` · the captured log output contains no `@` and no `$` figure.

### 9.7 A2 — `tests/producers.test.ts`, `tests/memberships.test.ts`, `tests/applications.test.ts`, `tests/checkins.test.ts`
producers: manager without `market_id` → 400, unassigned → 403, assigned → only producers with a membership there; rename moves the old name to `aliases` and recomputes `name_key`; duplicate email on create → 409 with `producer_id`; `notes` hidden from managers. memberships: every allowed transition in `MEMBERSHIP_TRANSITIONS` succeeds and appends history; `active → approved` is 409; `approved_at/by` set once; manager PATCH on another market's membership → 403. applications: public POST validates, normalizes the phone, rejects an inactive/unknown market (400), 409 on a duplicate email within 24 h; **approve upserts by email, not by name**: (1) existing producer with `emails: ['owner@testfield.example']` and `business_name: 'Testfield Farm'` + an application `business_name: 'Terry T.'`, same email → no new producer, `aliases` gains `'Terry T.'`, membership `approved`; (2) an application with a *different* email but the identical business name → a **new** producer; (3) `market_ids` outside `markets_applied` → 400; (4) approve twice → 409; audit rows `application.approve`, `producer.update`/`producer.create`, `membership.create`. checkins: exactly-one-filter rule (400), sales and `raw_import` present for admin and absent for a manager, manager scoped to assigned markets.

### 9.8 C
`cd web && npx tsc --noEmit` clean; no `[` folder under `web/src/app`; `grep -r "useSearchParams" web/src/app` only inside `<Suspense>` pages; `next build` output contains no `ƒ` (dynamic) routes.
