// Phase 3 contract §5.1 / §7.2: the inbound upgrade — YES/NO on an open
// check-in, HELP with a link, forward-to-staff, the unchanged courtesy
// reply, and STOP/START on both `users` and `producers`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { smsRoutes } from '../src/routes/sms.js';
import { REPLIES } from '../src/services/inbound.js';
import { checkinUrl } from '../src/services/open-checkin.js';
import { sendSms as voipmsSend } from '../src/services/voipms.js';
import { fakeDb } from './helpers/fake-db.js';

vi.mock('../src/services/voipms.js', () => ({ sendSms: vi.fn(async () => 'msg-id') }));
vi.mock('../src/services/error-notify.js', () => ({ notifyError: vi.fn(async () => {}) }));
const voipms = vi.mocked(voipmsSend);

const APP_URL = 'https://test.example';
const MARKET_NAME = 'West Little Rock Farmers Market';
const DATE_ID = 'wlrfm_2026-09-19';

const P1_PHONE = '+15015550101'; // Testfield Farm, open token, active membership
const P2_PHONE = '+15015550102'; // NoLink Farm, no token
const P3_PHONE = '+15015550103'; // Expired Farm, expired token, active membership
const P4_PHONE = '+15015550104'; // Lonely Farm, no token, no membership

const ADMIN_PHONE = '+15015550201';
const MGR_W_PHONE = '+15015550202';
const MGR_A_PHONE = '+15015550203';

const FUTURE = new Date('2026-09-25T17:00:00Z'); // link_tokens.expires_at, still open
const PAST = new Date('2020-01-01T00:00:00Z'); // expired

function baseFixtures() {
  return {
    farmers_markets: {
      wlrfm: { id: 'wlrfm', name: MARKET_NAME, timezone: 'America/Chicago', active: true },
    },
    market_dates: {
      [DATE_ID]: { market_id: 'wlrfm', date: '2026-09-19', status: 'collecting' },
    },
    producers: {
      p1: { business_name: 'Testfield Farm', phone: P1_PHONE, sms_opt_out_at: null },
      p2: { business_name: 'NoLink Farm', phone: P2_PHONE, sms_opt_out_at: null },
      p3: { business_name: 'Expired Farm', phone: P3_PHONE, sms_opt_out_at: null },
      p4: { business_name: 'Lonely Farm', phone: P4_PHONE, sms_opt_out_at: null },
    },
    producer_memberships: {
      p1_wlrfm: { producer_id: 'p1', market_id: 'wlrfm', status: 'active' },
      p3_wlrfm: { producer_id: 'p3', market_id: 'wlrfm', status: 'active' },
    },
    link_tokens: {
      t1: {
        purpose: 'checkin',
        producer_id: 'p1',
        market_id: 'wlrfm',
        market_date_id: DATE_ID,
        expires_at: FUTURE,
        uses: 0,
        max_uses: 25,
        created_at: new Date('2026-09-19T18:00:00Z'),
        created_by: 'engine',
        sent_message_id: null,
      },
      t3: {
        purpose: 'checkin',
        producer_id: 'p3',
        market_id: 'wlrfm',
        market_date_id: DATE_ID,
        expires_at: PAST,
        uses: 0,
        max_uses: 25,
        created_at: new Date('2026-09-12T18:00:00Z'),
        created_by: 'engine',
        sent_message_id: null,
      },
    },
    users: {
      admin1: { name: 'Admin', role: 'admin', phone: ADMIN_PHONE },
      mgr_w: { name: 'WLRFM Manager', role: 'market_manager', phone: MGR_W_PHONE, assigned_market_ids: ['wlrfm'] },
      mgr_a: { name: 'Argenta Manager', role: 'market_manager', phone: MGR_A_PHONE, assigned_market_ids: ['argenta'] },
    },
  };
}

function seededDb(extra: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const base = baseFixtures();
  const merged: Record<string, Record<string, Record<string, unknown>>> = { ...base };
  for (const [col, docs] of Object.entries(extra)) {
    merged[col] = { ...(base as Record<string, Record<string, Record<string, unknown>>>)[col], ...docs };
  }
  return fakeDb(merged);
}

async function buildApp(env: Record<string, string>, db: ReturnType<typeof fakeDb>) {
  const app = Fastify();
  await app.register(formbody);
  app.decorate('db', db as never);
  app.decorate('env', {
    NODE_ENV: 'production',
    SMS_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    ALLOW_REAL_SENDS: 'false',
    JWT_SECRET: 'test-secret',
    APP_URL,
    VOIPMS_DID: '5015550999',
    ...env,
  } as never);
  await app.register(smsRoutes);
  await app.ready();
  return app;
}

const REAL = { SMS_PROVIDER: 'voipms', ALLOW_REAL_SENDS: 'true' };

function inbound(message: string, from: string) {
  return `from=${from.replace('+', '')}&message=${encodeURIComponent(message)}&id=sms-${Math.random().toString(36).slice(2)}`;
}

const outbound = (db: ReturnType<typeof fakeDb>) => Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
const byKind = (db: ReturnType<typeof fakeDb>, kind: string) => outbound(db).filter((m) => m.kind === kind);
const checkinDoc = (db: ReturnType<typeof fakeDb>, id: string) => db.dump('checkins')[id];

const LINK = checkinUrl(APP_URL, 't1');

beforeEach(() => {
  voipms.mockClear();
  voipms.mockImplementation(async () => 'msg-id');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YES / NO against an open check-in', () => {
  it('YES creates a partial sms check-in and replies with the link', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('YES', P1_PHONE)}` });

    expect(res.statusCode).toBe(200);
    const doc = checkinDoc(db, `${DATE_ID}_p1`);
    expect(doc).toMatchObject({ source: 'sms', attending_next: true, partial: true, market_date_id: DATE_ID, producer_id: 'p1' });

    const replies = byKind(db, 'auto_reply');
    expect(replies).toHaveLength(1);
    expect(String(replies[0].body)).toContain(LINK);
    expect(String(replies[0].body)).toContain(`attending the next ${MARKET_NAME}`);
  });

  it('a "no thanks" reply is recognised as NO and keeps the raw text', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('no thanks', P1_PHONE)}` });

    const doc = checkinDoc(db, `${DATE_ID}_p1`);
    expect(doc).toMatchObject({ attending_next: false, attending_next_raw: 'no thanks', partial: true });
  });

  it('YES against an existing form check-in only changes attending_next', async () => {
    const db = seededDb({
      checkins: {
        [`${DATE_ID}_p1`]: {
          producer_id: 'p1',
          market_id: 'wlrfm',
          market_date_id: DATE_ID,
          source: 'form',
          partial: false,
          feedback: 'Great turnout last week',
          bringing_next: ['tomatoes'],
          attending_next: null,
        },
      },
    });
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('YES', P1_PHONE)}` });

    const doc = checkinDoc(db, `${DATE_ID}_p1`);
    expect(doc).toMatchObject({ source: 'form', partial: false, feedback: 'Great turnout last week', attending_next: true });
  });

  it('YES with an expired token is forwarded, not recorded', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('YES', P3_PHONE)}` });

    expect(checkinDoc(db, `${DATE_ID}_p3`)).toBeUndefined();
    const forwards = byKind(db, 'forwarded_inbound');
    expect(forwards).toHaveLength(2); // admin1 + mgr_w (wlrfm), never mgr_a
    expect(forwards.map((m) => m.to).sort()).toEqual([ADMIN_PHONE, MGR_W_PHONE].sort());
  });
});

describe('HELP', () => {
  it('with an open check-in includes the link', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('HELP', P1_PHONE)}` });

    const help = byKind(db, 'help');
    expect(help).toHaveLength(1);
    expect(String(help[0].body)).toContain(LINK);
  });

  it('without a token falls back to the generic help text', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('HELP', P2_PHONE)}` });

    const help = byKind(db, 'help');
    expect(help).toHaveLength(1);
    expect(help[0].body).toBe(REPLIES.help);
  });
});

describe('forwarding free text', () => {
  it('forwards to wlrfm staff only, with the inbound message id, and sends one courtesy reply', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('running late today', P1_PHONE)}` });
    expect(res.statusCode).toBe(200);

    const inboundRowId = Object.entries(db.dump('messages')).find(([, m]) => m.direction === 'inbound')![0];
    const forwards = byKind(db, 'forwarded_inbound');
    expect(forwards).toHaveLength(2);
    expect(forwards.map((m) => m.to).sort()).toEqual([ADMIN_PHONE, MGR_W_PHONE].sort());
    for (const f of forwards) {
      expect(f.body).toBe(`Text from Testfield Farm (${MARKET_NAME}): running late today`);
      expect(f.producer_id).toBe('p1');
      expect(f.inbound_message_id).toBe(inboundRowId);
    }

    const replies = byKind(db, 'auto_reply');
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(REPLIES.received_with_link(LINK));
  });

  it('a second free text minutes later forwards again but does not send a second courtesy reply', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('first message', P1_PHONE)}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('second message', P1_PHONE)}` });

    expect(byKind(db, 'forwarded_inbound')).toHaveLength(4);
    expect(byKind(db, 'auto_reply')).toHaveLength(1);
  });

  it('a check-in link text sent earlier does not suppress the courtesy reply', async () => {
    const db = seededDb({
      messages: {
        prior_link: {
          direction: 'outbound',
          to: P1_PHONE,
          kind: 'checkin_link',
          status: 'sent',
          created_at: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
    });
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('anything else', P1_PHONE)}` });

    expect(byKind(db, 'auto_reply')).toHaveLength(1);
  });

  it('a producer with no open token and no membership is forwarded to admins only, with the plain reply', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('question about my booth', P4_PHONE)}` });

    const forwards = byKind(db, 'forwarded_inbound');
    expect(forwards).toHaveLength(1);
    expect(forwards[0].to).toBe(ADMIN_PHONE);
    expect(forwards[0].body).toBe('Text from Lonely Farm: question about my booth');

    const replies = byKind(db, 'auto_reply');
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(REPLIES.received);
  });
});

describe('STOP / START on a producer', () => {
  it('STOP opts the producer out and confirms; a later free text still forwards but sends no courtesy reply', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);

    const stopRes = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('STOP', P1_PHONE)}` });
    expect(stopRes.statusCode).toBe(200);
    expect(db.dump('producers').p1.sms_opt_out_at).toBeInstanceOf(Date);
    expect(db.dump('producers').p1.sms_consent).toMatchObject({ status: 'opted_out' });
    expect(byKind(db, 'opt_out_confirm')).toHaveLength(1);

    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hello', P1_PHONE)}` });
    expect(byKind(db, 'forwarded_inbound')).toHaveLength(2);
    expect(byKind(db, 'auto_reply')).toHaveLength(0);
  });

  it('START clears the opt-out and confirms', async () => {
    const db = seededDb({
      producers: { p1: { business_name: 'Testfield Farm', phone: P1_PHONE, sms_opt_out_at: new Date() } },
    });
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('START', P1_PHONE)}` });

    expect(db.dump('producers').p1.sms_opt_out_at).toBeNull();
    expect(db.dump('producers').p1.sms_consent).toMatchObject({ status: 'opted_in' });
    expect(byKind(db, 'opt_in_confirm')).toHaveLength(1);
  });
});

describe('unknown numbers — unchanged from Phase 1', () => {
  it('gets the closed reply once per 24h and STOP still confirms', async () => {
    const db = seededDb();
    const app = await buildApp({}, db);
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('hi', '+15015559999')}` });
    await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('STOP', '+15015559999')}` });

    expect(outbound(db)).toHaveLength(2);
    expect(outbound(db).map((m) => m.kind).sort()).toEqual(['auto_reply', 'opt_out_confirm']);
  });
});

describe('real provider + failures', () => {
  it('a forward that fails to send is logged failed and the webhook still returns 200', async () => {
    voipms.mockImplementation(async () => {
      throw new Error('voip.ms sendSMS failed: sms_toolong');
    });
    const db = seededDb();
    const app = await buildApp(REAL, db);
    const res = await app.inject({ method: 'GET', url: `/voipms/inbound?${inbound('running late today', P1_PHONE)}` });

    expect(res.statusCode).toBe(200);
    const forwards = byKind(db, 'forwarded_inbound');
    expect(forwards).toHaveLength(2);
    expect(forwards.every((m) => m.status === 'failed')).toBe(true);
  });
});
