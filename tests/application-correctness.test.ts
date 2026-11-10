// Fix X3: submission and approval correctness.
//  (a) a repeat of an accepted submission is answered with the original result even when it references uploads;
//  (b) the public duplicate answer never names the other application;
//  (c) the stored SMS consent version is the market's, not whatever the client sent;
//  (d) one live application per email, market and season, atomically (application_keys);
//  (e) one approval of an application at a time, and never two producers for one address.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DRAFT_ID, PDF_BYTES, T_OPEN, adminAuth, boot, multipart, rowsOfKind, seed, validSubmission, type Db } from './helpers/a1-fixtures.js';
import {
  APPLICATION_KEY_PENDING_MS,
  applicationKeyId,
  approvalLockId,
  claimApplicationKey,
  producerIdentityLockId,
} from '../src/services/applications.js';
import { CLAIM_TTL_MS } from '../src/services/checkin-workflow.js';

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DRAFT_2 = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const DRAFT_3 = '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a';
const EMAIL = 'owner@testfield.example';
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const KEY = `wlrfm_2027_${sha(EMAIL)}`;

const submit = (app: FastifyInstance, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/applications', payload: validSubmission(over) as never });
const patch = (app: FastifyInstance, id: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/applications/${id}`, headers: adminAuth(), payload: payload as never });
const approveBody = { action: 'approve', fee_plan: 'seasonal', spaces: 1, electric: false, pay_in_full: false };
const approve = (app: FastifyInstance, id: string, over: Record<string, unknown> = {}) => patch(app, id, { ...approveBody, ...over });
const emailPrints = () => log.mock.calls.filter((c) => String(c[0]).startsWith('[email:console]'));

async function upload(app: FastifyInstance, draft = DRAFT_ID, kind = 'permit') {
  const mp = multipart({ market: 'wlrfm', draft_id: draft, kind }, { name: 'permit.pdf', type: 'application/pdf', data: PDF_BYTES });
  const res = await app.inject({ method: 'POST', url: '/api/applications/uploads', headers: mp.headers, payload: mp.payload });
  expect(res.statusCode).toBe(201);
  return res.json().upload_id as string;
}

const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };

/**
 * Makes requests that are sent together actually overlap. The fake Firestore
 * resolves every call in a microtask, so one injected request would run to
 * completion before the next one starts; here every document read or write
 * and every query first yields to the event loop, the way a network round
 * trip does, so two handlers interleave at each database call. The writes
 * themselves stay atomic (the yield happens before them, not inside them).
 */
function interleave(db: Db): Db {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const collection = db.collection.bind(db);
  db.collection = ((name: string) => {
    const col = collection(name);
    const doc = col.doc.bind(col);
    col.doc = ((id?: string) => {
      const ref = doc(id) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      for (const method of ['get', 'set', 'update', 'create', 'delete']) {
        const original = ref[method]!.bind(ref);
        ref[method] = async (...args: unknown[]) => {
          await tick();
          return original(...args);
        };
      }
      return ref;
    }) as never;
    const get = col.get.bind(col);
    col.get = (async () => {
      await tick();
      return get();
    }) as never;
    return col;
  }) as never;
  return db;
}

describe('(a) a repeat of an accepted submission', () => {
  it('returns the original 201 when the application referenced uploads', async () => {
    const db = seed();
    const app = await boot(db);
    const permitId = await upload(app);
    const certId = await upload(app, DRAFT_ID, 'insurance');
    const body = {
      products: [dairy],
      permits: { dairy: { status: 'uploaded', upload_id: permitId } },
      insurance: { status: 'have', certificate_upload_id: certId, carrier: 'Acme Mutual', expires_on: '2027-12-31' },
    };
    const first = await submit(app, body);
    expect(first.statusCode).toBe(201);

    const again = await submit(app, body);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(db.count('applications')).toBe(1);
    expect(db.dump('application_uploads')[permitId]).toMatchObject({ application_id: first.json().id });
    expect(db.dump('application_uploads')[certId]).toMatchObject({ application_id: first.json().id });
  });

  it('answers with the fee that was recorded, not today\'s', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    await db.collection('farmers_markets').doc('wlrfm').update({ fees: { application_fee: 99 } });
    const again = await submit(app);
    expect(again.statusCode).toBe(201);
    expect(again.json().fee.amount).toBe(first.json().fee.amount);
    expect(again.json().fee.amount).toBe(15);
  });

  it('returns the original 201 whatever has changed since it was accepted: the window closed, the rules, the consent wording, a stall', async () => {
    const db = seed({}, { season: { label: '2027', application_open: '2026-12-01', application_close: '2026-12-15', schedule_version_id: 'v27' } });
    const app = await boot(db);
    const body = { booth: { ...(validSubmission().booth as object), stall_preference: ['wlrfm_v1'] } };
    const first = await submit(app, body); // accepted on the last day of the window
    expect(first.statusCode).toBe(201);
    const stored = JSON.stringify(db.dump('applications'));

    // The applicant's phone retries the same request just after midnight, market time: the window is closed now.
    vi.setSystemTime(new Date('2026-12-16T06:00:05Z'));
    let again = await submit(app, body);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());

    // And after the market has published new rules, new consent wording and retired the stall.
    const legal = (db.dump('farmers_markets').wlrfm as Record<string, any>).legal;
    await db.collection('farmers_markets').doc('wlrfm').update({ legal: { ...legal, rules_version: '2027-2', sms_consent_version: 'sjca-sms-2', sms_consent_text: 'New wording.' } });
    await db.collection('booths').doc('wlrfm_v1').update({ active: false });
    again = await submit(app, body);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());

    // Nothing was written by the repeats.
    expect(db.count('applications')).toBe(1);
    expect(JSON.stringify(db.dump('applications'))).toBe(stored);

    // Anyone who has NOT been accepted is still told the truth: closed.
    const contact = { ...(validSubmission().contact as object), email: 'late@example.test' };
    const late = await submit(app, { draft_id: DRAFT_2, contact });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatch(/closed/);
    // And the same person from a different draft is not "this submission": closed as well.
    expect((await submit(app, { ...body, draft_id: DRAFT_3 })).statusCode).toBe(409);
    expect(db.count('applications')).toBe(1);
  });

  it('a withdrawn or declined application is not answered as a repeat: the applicant is applying again', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    await patch(app, first.json().id, { action: 'withdraw' });
    const again = await submit(app); // the very same draft
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(first.json().id);
    expect(db.count('applications')).toBe(2);
  });

  it('a market that never opened applications has nothing to repeat', async () => {
    const app = await boot(seed({}, { season: null }));
    const res = await submit(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/closed/);
  });

  it('still refuses an upload that belongs to somebody else\'s application', async () => {
    const db = seed();
    const app = await boot(db);
    const theirs = await upload(app, DRAFT_3);
    const contact = { ...(validSubmission().contact as object), email: 'someone.else@example.test' };
    expect((await submit(app, { draft_id: DRAFT_3, contact, products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: theirs } } })).statusCode).toBe(201);
    // A different draft cannot reference it, attached or not.
    const res = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: theirs } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/uploaded files/);
    expect(db.count('applications')).toBe(1);
  });
});

describe('(b) the duplicate answer', () => {
  it('is a 409 that names no application', async () => {
    const app = await boot(seed());
    const first = await submit(app);
    const second = await submit(app, { draft_id: DRAFT_2 });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'We already have an application for this email this season' });
    expect(second.body).not.toContain(first.json().id);
    expect(second.body).not.toMatch(/application_id/);
  });
});

describe('(c) the SMS consent version', () => {
  it('must be the version the market publishes: an invented or stale one is a 409 and nothing is stored', async () => {
    const db = seed();
    const app = await boot(db);
    for (const version of ['anything-the-client-likes', 'sjca-sms-0', 'SJCA-SMS-1']) {
      const res = await submit(app, { sms_consent_version: version });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'sms_consent_changed' });
      expect(res.json().error).toMatch(/reload the form/i);
    }
    expect(db.count('applications')).toBe(0);
    expect(db.count('application_keys')).toBe(0);
    expect((await submit(app, { sms_consent_version: 'sjca-sms-1' })).statusCode).toBe(201);
  });

  it('follows the market when it publishes a new wording', async () => {
    const db = seed();
    await db.collection('farmers_markets').doc('wlrfm').update({ 'legal.sms_consent_version': 'wlrfm-sms-2', 'legal.sms_consent_text': 'New wording.' });
    const app = await boot(db);
    expect((await app.inject({ method: 'GET', url: '/api/applications/config?market=wlrfm' })).json().legal.sms_consent_version).toBe('wlrfm-sms-2');
    expect((await submit(app)).statusCode).toBe(409); // the form still holds sjca-sms-1
    const ok = await submit(app, { sms_consent_version: 'wlrfm-sms-2' });
    expect(ok.statusCode).toBe(201);
    expect((db.dump('applications')[ok.json().id] as Record<string, any>).sms_consent.text_version).toBe('wlrfm-sms-2');
  });
});

describe('(d) one live application per email, market and season', () => {
  it('claims the key before the application: id = market + season + sha256(lower-cased email), value = the application id', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await submit(app); // the fixture sends 'Owner@Testfield.example'
    expect(res.statusCode).toBe(201);
    expect(applicationKeyId('wlrfm', '2027', ' Owner@Testfield.EXAMPLE ')).toBe(KEY);
    expect(Object.keys(db.dump('application_keys'))).toEqual([KEY]);
    expect(db.dump('application_keys')[KEY]).toMatchObject({ market_id: 'wlrfm', season: '2027', email_sha256: sha(EMAIL), application_id: res.json().id });
    // The address itself is not in the key document.
    expect(JSON.stringify(db.dump('application_keys'))).not.toContain('testfield');
  });

  it('two submissions for one address arriving together: exactly one application', async () => {
    const db = interleave(seed());
    const app = await boot(db);
    const [a, b] = await Promise.all([submit(app), submit(app, { draft_id: DRAFT_2 })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(db.count('applications')).toBe(1);
    expect(db.count('application_keys')).toBe(1);
    const winner = a.statusCode === 201 ? a : b;
    const loser = a.statusCode === 201 ? b : a;
    expect(db.dump('application_keys')[KEY]).toMatchObject({ application_id: winner.json().id });
    expect(loser.body).not.toContain(winner.json().id);
  });

  it('the same submission sent twice at once: one application, never two', async () => {
    const db = interleave(seed());
    const app = await boot(db);
    const [a, b] = await Promise.all([submit(app), submit(app)]);
    expect(db.count('applications')).toBe(1);
    const id = Object.keys(db.dump('applications'))[0]!;
    for (const res of [a, b]) {
      // The winner gets 201; the other gets the same 201, or is told to try again while the first is still being written.
      expect([201, 409]).toContain(res.statusCode);
      if (res.statusCode === 201) expect(res.json().id).toBe(id);
      else expect(res.json().error).toMatch(/already being submitted/);
    }
    expect([a.statusCode, b.statusCode]).toContain(201);
    // Either way, sending it once more is the original answer.
    const again = await submit(app);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(id);
  });

  it('the key refuses a second application even when the read of existing applications misses the first', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    expect(first.statusCode).toBe(201);

    // The scan answers "nothing there" (what a concurrent request would have read).
    const collection = db.collection.bind(db);
    db.collection = ((name: string) => {
      const col = collection(name);
      if (name === 'applications') col.where = (() => ({ get: async () => ({ empty: true, size: 0, docs: [] }) })) as never;
      return col;
    }) as never;

    const second = await submit(app, { draft_id: DRAFT_2 });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'We already have an application for this email this season' });
    // And a blind repeat of the first is still the original answer, through the key.
    const repeat = await submit(app);
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().id).toBe(first.json().id);
    expect(db.count('applications')).toBe(1);
  });

  it('a declined or withdrawn application lets the next one take the key', async () => {
    const db = seed();
    const app = await boot(db);
    const first = await submit(app);
    expect((await patch(app, first.json().id, { action: 'decline', reason: 'incomplete' })).statusCode).toBe(200);
    const second = await submit(app, { draft_id: DRAFT_2 });
    expect(second.statusCode).toBe(201);
    expect(db.dump('application_keys')[KEY]).toMatchObject({ application_id: second.json().id, previous_application_id: first.json().id });

    expect((await patch(app, second.json().id, { action: 'withdraw' })).statusCode).toBe(200);
    const third = await submit(app, { draft_id: DRAFT_3 });
    expect(third.statusCode).toBe(201);
    expect(db.dump('application_keys')[KEY]).toMatchObject({ application_id: third.json().id });
    // While the third is live, a fourth is refused.
    expect((await submit(app, { draft_id: '11111111-2222-4333-8444-555555555555' })).statusCode).toBe(409);
    expect(db.count('application_keys')).toBe(1);
  });

  it('is per market and per season', async () => {
    const db = seed();
    const app = await boot(db);
    expect((await submit(app)).statusCode).toBe(201);
    expect((await submit(app, { market_id: 'other', draft_id: DRAFT_2 })).statusCode).toBe(201);
    expect(Object.keys(db.dump('application_keys')).sort()).toEqual([`other_2027_${sha(EMAIL)}`, KEY].sort());
  });

  it('a key whose application was never written: refused while fresh, taken over once stale', async () => {
    const db = seed();
    // A request claimed the key and died before writing its application.
    await db.collection('application_keys').doc(KEY).set({ market_id: 'wlrfm', season: '2027', email_sha256: sha(EMAIL), application_id: 'never-written', claimed_at: T_OPEN, created_at: T_OPEN });
    const app = await boot(db);

    vi.setSystemTime(new Date(T_OPEN.getTime() + APPLICATION_KEY_PENDING_MS - 1000));
    const early = await submit(app);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/already being submitted/);
    expect(db.count('applications')).toBe(0);

    vi.setSystemTime(new Date(T_OPEN.getTime() + APPLICATION_KEY_PENDING_MS));
    const later = await submit(app);
    expect(later.statusCode).toBe(201);
    expect(db.dump('application_keys')[KEY]).toMatchObject({ application_id: later.json().id, previous_application_id: 'never-written' });
  });

  it('lets go of the key when the application could not be written', async () => {
    const db = seed();
    const app = await boot(db);
    const collection = db.collection.bind(db);
    let failures = 1;
    db.collection = ((name: string) => {
      const col = collection(name);
      if (name !== 'applications') return col;
      const doc = col.doc.bind(col);
      col.doc = ((id?: string) => {
        const ref = doc(id);
        const create = ref.create.bind(ref);
        ref.create = (async (data: Record<string, unknown>) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('UNAVAILABLE: simulated Firestore write failure');
          }
          return create(data);
        }) as never;
        return ref;
      }) as never;
      return col;
    }) as never;

    const failed = await submit(app);
    expect(failed.statusCode).toBe(500);
    expect(db.count('applications')).toBe(0);
    expect(db.count('application_keys')).toBe(0);
    // The applicant can try again immediately.
    expect((await submit(app)).statusCode).toBe(201);
    expect(db.count('application_keys')).toBe(1);
  });

  it('claimApplicationKey: the unit', async () => {
    const db = seed();
    const args = { market_id: 'wlrfm', season: '2027', email: EMAIL, now: T_OPEN };
    expect(await claimApplicationKey(db as never, { ...args, application_id: 'a1' })).toEqual({ ok: true });
    // a1 not written yet: in flight.
    expect(await claimApplicationKey(db as never, { ...args, application_id: 'a2' })).toEqual({ ok: false, holder_id: 'a1', holder: null });
    await db.collection('applications').doc('a1').set({ status: 'new', market_id: 'wlrfm', season: '2027' });
    const held = await claimApplicationKey(db as never, { ...args, application_id: 'a2' });
    expect(held).toMatchObject({ ok: false, holder_id: 'a1', holder: { status: 'new' } });
    for (const status of ['under_review', 'approved']) {
      await db.collection('applications').doc('a1').update({ status });
      expect((await claimApplicationKey(db as never, { ...args, application_id: 'a2' })).ok).toBe(false);
    }
    await db.collection('applications').doc('a1').update({ status: 'withdrawn' });
    expect(await claimApplicationKey(db as never, { ...args, application_id: 'a2' })).toEqual({ ok: true });
    expect(db.dump('application_keys')[KEY]).toMatchObject({ application_id: 'a2' });
  });
});

describe('(e) approving', () => {
  const newbie = { ...(validSubmission().contact as object), email: 'newbie@example.test', business_name: 'Newbie Gardens', name: 'Nora Newbie' };

  it('the same application approved twice at once: one approval, one producer, one membership, one acceptance', async () => {
    const db = interleave(seed());
    const app = await boot(db);
    const id = (await submit(app, { contact: newbie })).json().id as string;
    expect(db.count('producers')).toBe(1); // only p1; the applicant is new

    const [a, b] = await Promise.all([approve(app, id), approve(app, id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json()).toMatchObject({ error: 'Approval already in progress', code: 'approval_in_progress' });

    expect(db.count('producers')).toBe(2); // exactly one new producer
    const memberships = Object.values(db.dump('producer_memberships')).filter((m) => m.season === '2027');
    expect(memberships).toHaveLength(1);
    expect(Object.values(db.dump('link_tokens')).filter((t) => t.purpose === 'agreement')).toHaveLength(1);
    expect(rowsOfKind(db, 'acceptance')).toHaveLength(1);
    expect(emailPrints()).toHaveLength(1);
    expect(Object.values(db.dump('audit_log')).filter((x) => x.action === 'application.approve')).toHaveLength(1);
    expect(db.dump('applications')[id]).toMatchObject({ status: 'approved' });

    // A later attempt is the ordinary "already approved".
    const later = await approve(app, id);
    expect(later.statusCode).toBe(409);
    expect(later.json().error).toBe('Application already approved');
  });

  it('a fresh lock held by someone else is a 409; a stale one is taken over', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app)).json().id as string;
    await db.collection('workflow_locks').doc(approvalLockId(id)).set({ key: approvalLockId(id), claimed_at: T_OPEN, claimed_by: 'admin2', run_id: 'someone-else', created_at: T_OPEN });

    vi.setSystemTime(new Date(T_OPEN.getTime() + CLAIM_TTL_MS - 1000));
    const blocked = await approve(app, id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('Approval already in progress');
    expect(db.dump('applications')[id]).toMatchObject({ status: 'new' });
    expect(db.count('link_tokens')).toBe(0);
    expect(db.dump('workflow_locks')[approvalLockId(id)]).toMatchObject({ run_id: 'someone-else' }); // not ours to release

    vi.setSystemTime(new Date(T_OPEN.getTime() + CLAIM_TTL_MS));
    const ok = await approve(app, id);
    expect(ok.statusCode).toBe(200);
    expect(db.dump('workflow_locks')[approvalLockId(id)]).toMatchObject({ claimed_by: 'admin1', taken_over_from: 'someone-else' });
  });

  it('a refused approval releases its locks, so it can be retried at once', async () => {
    const db = seed({
      producers: {
        p1: { business_name: 'Testfield Farm', emails: ['owner@testfield.example'], phone: null, aliases: [], active: true },
        p9: { business_name: 'Holder Farm', emails: ['holder@example.test'], phone: '+15015550142', aliases: [], active: true },
      },
    });
    const app = await boot(db);
    const contact = { ...(validSubmission().contact as object), email: 'brand.new@example.test' };
    const id = (await submit(app, { contact })).json().id as string;
    const refused = await approve(app, id); // p9 holds the applicant's mobile number
    expect(refused.statusCode).toBe(409);
    expect(refused.json().producer_id).toBe('p9');
    expect(db.count('workflow_locks')).toBe(0);

    // The admin clears the conflict and approves again straight away.
    await db.collection('producers').doc('p9').update({ phone: null });
    expect((await approve(app, id)).statusCode).toBe(200);
    // The approval lock of an approved application stays; the identity lock is gone.
    expect(Object.keys(db.dump('workflow_locks'))).toEqual([approvalLockId(id)]);
  });

  it('an approval that throws releases its locks', async () => {
    const db = seed();
    const app = await boot(db);
    const id = (await submit(app, { contact: newbie })).json().id as string;
    const collection = db.collection.bind(db);
    let armed = true;
    db.collection = ((name: string) => {
      if (name === 'producer_memberships' && armed) {
        armed = false;
        throw new Error('UNAVAILABLE: simulated Firestore outage');
      }
      return collection(name);
    }) as never;
    expect((await approve(app, id)).statusCode).toBe(500);
    expect(db.count('workflow_locks')).toBe(0);
    expect(db.dump('applications')[id]).toMatchObject({ status: 'new' });
    expect((await approve(app, id)).statusCode).toBe(200);
  });

  it('one new applicant, two markets, approved at once: one producer', async () => {
    const db = interleave(seed());
    const app = await boot(db);
    const a = (await submit(app, { contact: newbie })).json().id as string;
    const b = (await submit(app, { contact: newbie, market_id: 'other', draft_id: DRAFT_2 })).json().id as string;

    const [ra, rb] = await Promise.all([approve(app, a, { send: false }), approve(app, b, { send: false })]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    expect(db.count('producers')).toBe(2); // p1 and ONE producer for the new applicant

    // The refused one was only waiting for the other: it goes through on the next click.
    const [retryId, retryRes] = ra.statusCode === 409 ? [a, ra] : [b, rb];
    expect(retryRes.json().error).toBe('Approval already in progress');
    const retry = await approve(app, retryId, { send: false });
    expect(retry.statusCode).toBe(200);
    expect(db.count('producers')).toBe(2);
    const producerId = retry.json().producer.id as string;
    expect(Object.keys(db.dump('producer_memberships')).filter((k) => k.startsWith(producerId)).sort()).toEqual([`${producerId}_other_2027`, `${producerId}_wlrfm_2027`]);
    expect(db.dump('workflow_locks')[producerIdentityLockId('newbie@example.test')]).toBeUndefined();
  });
});
