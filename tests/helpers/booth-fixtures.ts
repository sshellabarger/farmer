// Shared fixtures for the Phase 4 fix booth tests (booth-text-changes, season-opener).
// FAKE names and +1501555xxxx phones only. The rbac mock cannot live here (vi.mock
// factories are hoisted per test file), so each file repeats it.
import Fastify from 'fastify';
import { marketDateRoutes } from '../../src/routes/market-dates.js';
import { processMarketDates } from '../../src/services/checkin-workflow.js';
import { DEFAULT_WORKFLOW, DEFAULT_QUIET_HOURS } from '../../src/services/markets.js';
import type { Env } from '../../src/config/env.js';
import { fakeDb } from './fake-db.js';
import { tokenFor } from './staff-auth.js';

export type Db = ReturnType<typeof fakeDb>;

export const env = {
  NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false',
  APP_URL: 'https://test.example', ALERT_EMAIL: '', JWT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test',
} as Env;

export const D0 = new Date('2026-01-01T00:00:00Z');

export function boothDoc(label: string, row: string, order: number, extra: Record<string, unknown> = {}) {
  return { market_id: 'wlrfm', label, row, order, kind: 'stall', power: false, size: '12x12', notes: '', active: true, created_at: D0, updated_at: D0, ...extra };
}

/** A Saturday market 08:00-12:00 America/Chicago; `utcOffset` is 5 in summer (CDT) and 6 in winter (CST). */
export function dateDoc(date: string, actions: Record<string, unknown> = {}, utcOffset = 5) {
  const hh = (h: number) => String(h + utcOffset).padStart(2, '0');
  const end = new Date(`${date}T${hh(12)}:00:00Z`);
  return {
    market_id: 'wlrfm', date, start_time: '08:00', end_time: '12:00',
    start_at: new Date(`${date}T${hh(8)}:00:00Z`), end_at: end,
    status: 'collecting', schedule_version: 'v1', special: false, note: '',
    actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date(end.getTime() + 4320 * 60_000), deadline_processed_at: null, drafts_generated_at: null, approved_at: null, booth_texts_sent_at: null, ...actions },
    extra_questions: [], sponsor_id: null, cancellation_reason: null, cancelled_at: null, cancelled_by: null,
    generated_at: D0, source: 'import', created_at: D0, updated_at: D0,
  };
}

export function checkin(dateId: string, producer: string, attending: boolean | null) {
  return { market_date_id: dateId, producer_id: producer, attending_next: attending, submitted_at: new Date('2026-09-20T12:00:00Z'), source: 'form', partial: false };
}

/** V1-V6 west (V3, V4 powered), V7 east, a retired V8, one food-truck slot. */
export function standardBooths(): Record<string, Record<string, unknown>> {
  return {
    wlrfm_v1: boothDoc('V1', 'west', 1),
    wlrfm_v2: boothDoc('V2', 'west', 2),
    wlrfm_v3: boothDoc('V3', 'west', 3, { power: true }),
    wlrfm_v4: boothDoc('V4', 'west', 4, { power: true }),
    wlrfm_v5: boothDoc('V5', 'west', 5),
    wlrfm_v6: boothDoc('V6', 'west', 6),
    wlrfm_v7: boothDoc('V7', 'east', 1),
    wlrfm_v8: boothDoc('V8', 'east', 2, { active: false }),
    'wlrfm_food-truck': boothDoc('Food truck', 'center', 1, { kind: 'food_truck' }),
  };
}

export const USERS = {
  admin1: { name: 'Admin', role: 'admin', phone: '+15015550001' },
  mgr_w: { name: 'WLRFM Manager', role: 'market_manager', assigned_market_ids: ['wlrfm'] },
  mgr_a: { name: 'Argenta Manager', role: 'market_manager', assigned_market_ids: ['argenta'] },
};

export const PRODUCERS = {
  p1: { business_name: 'Acme Farm', contact_name: 'Alice Apple', phone: '+15015550101', active: true },
  p2: { business_name: 'Beta Farm', contact_name: 'Bob Berry', phone: '+15015550102', active: true },
  p3: { business_name: 'Gamma Farm', contact_name: 'Gus Grape', phone: '+15015550103', active: true },
  p4: { business_name: 'Delta Farm', contact_name: 'Dee Date', phone: '+15015550104', active: true },
  p5: { business_name: 'Epsilon Farm', contact_name: 'Eve Elder', phone: '+15015550105', active: true },
  p6: { business_name: 'Zeta Truck', contact_name: 'Zed Zest', phone: '+15015550106', active: true },
};

export function marketDoc(extra: Record<string, unknown> = {}) {
  return {
    id: 'wlrfm', name: 'West Little Rock Farmers Market', slug: 'wlrfm', location: { name: '', address: '' }, timezone: 'America/Chicago',
    schedule: { versions: [], skipped_dates: [], special_dates: [] }, workflow: DEFAULT_WORKFLOW, quiet_hours: DEFAULT_QUIET_HOURS,
    active: true, created_by: 'test', created_at: D0, updated_at: D0,
    ...extra,
  };
}

export async function buildApp(db: Db) {
  const app = Fastify();
  app.decorate('db', db as never);
  app.decorate('env', env as never);
  await app.register(marketDateRoutes, { prefix: '/api/market-dates' });
  await app.ready();
  return app;
}
export type App = Awaited<ReturnType<typeof buildApp>>;

export const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

export const tick = (db: Db, t: Date) => processMarketDates(db as never, env, { now: t });

/** Every booth text logged, oldest first (creation time, then the per-vendor sequence). */
export function boothMessages(db: Db) {
  return Object.entries(db.dump('messages'))
    .map(([id, m]) => ({ id, ...(m as any) }))
    .filter((m) => m.kind === 'booth')
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.seq ?? 0) - (b.seq ?? 0));
}

export function currentRows(db: Db, targetId: string) {
  return Object.entries(db.dump('booth_assignments'))
    .map(([id, r]) => ({ id, ...(r as any) }))
    .filter((r) => r.market_date_id === targetId && r.superseded_by === null);
}

export const boothsOf = (rows: any[], producer: string) => rows.filter((r) => r.producer_id === producer).map((r) => r.booth_id).sort();

/** The id the booth-text key of a vendor is built on: their newest current assignment row. */
export function newestRowId(db: Db, targetId: string, producer: string): string {
  const mine = currentRows(db, targetId)
    .filter((r) => r.producer_id === producer)
    .sort((a, b) => a.assigned_at.getTime() - b.assigned_at.getTime() || a.id.localeCompare(b.id));
  return mine[mine.length - 1]!.id;
}

export const actionsOf = (db: Db, dateId: string) => (db.dump('market_dates')[dateId] as any).actions;

/** Route helpers bound to one source date (and cycle). */
export function routes(app: App, dateId: string, cycle?: 'next' | 'opener') {
  const withCycle = (body: Record<string, unknown>) => (cycle ? { ...body, cycle } : body);
  const base = `/api/market-dates/${dateId}`;
  return {
    draft: (payload: Record<string, unknown> = {}, user = 'mgr_w') =>
      app.inject({ method: 'POST', url: `${base}/assignments/draft`, headers: auth(user), payload: withCycle(payload) }),
    patch: (changes: unknown, user = 'mgr_w') =>
      app.inject({ method: 'PATCH', url: `${base}/assignments`, headers: auth(user), payload: withCycle({ changes }) }),
    approve: (user = 'mgr_w') => app.inject({ method: 'POST', url: `${base}/assignments/approve`, headers: auth(user), payload: withCycle({}) }),
    resend: (producerId: string, user = 'mgr_w') =>
      app.inject({ method: 'POST', url: `${base}/assignments/resend-text?producer_id=${producerId}${cycle ? `&cycle=${cycle}` : ''}`, headers: auth(user) }),
    status: async (user = 'mgr_w') => (await app.inject({ method: 'GET', url: `${base}/status`, headers: auth(user) })).json(),
    view: async (user = 'mgr_w') => {
      const s = (await app.inject({ method: 'GET', url: `${base}/status`, headers: auth(user) })).json();
      return cycle === 'opener' ? s.opener_assignments : s.assignments;
    },
  };
}
