// Fix X2: public uploads and submissions cannot be flooded. The upload route is
// gated on an open application window; a global daily cap (uploads) and a
// per-market daily cap (submissions) hold whatever address the caller uses;
// the nightly purge deletes the files nobody attached within 48 hours.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DRAFT_ID, PDF_BYTES, T_OPEN, boot, env, market, multipart, seed, validSubmission, type Db } from './helpers/a1-fixtures.js';
import { fakeStorage } from './helpers/fake-storage.js';
import { UPLOAD_LIMITS, purgeUnattachedUploads, utcDay } from '../src/services/application-uploads.js';
import { SUBMISSION_LIMITS } from '../src/services/applications.js';

// The alert pipeline is mocked by the shared fixtures (one registration per
// module: a second vi.mock here would hand the app a different spy). The spy
// is fetched the way the app fetches it, through a dynamic import.
let notify: ReturnType<typeof vi.fn>;

// Uploads reach storage only through the injected port.
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => {
    throw new Error('firebase-admin/storage must not be used in these tests');
  },
}));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  notify = vi.mocked((await import('../src/services/error-notify.js')).notifyError) as unknown as ReturnType<typeof vi.fn>;
  expect(vi.isMockFunction(notify)).toBe(true);
  notify.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;
const FILE = { name: 'permit.pdf', type: 'application/pdf', data: PDF_BYTES };

const send = (app: FastifyInstance, fields: Record<string, string>) => {
  const mp = multipart(fields, FILE);
  return app.inject({ method: 'POST', url: '/api/applications/uploads', headers: mp.headers, payload: mp.payload });
};
const upload = (app: FastifyInstance, marketId = 'wlrfm', draft = DRAFT_ID) => send(app, { market: marketId, draft_id: draft, kind: 'permit' });
const submit = (app: FastifyInstance, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/applications', payload: validSubmission(over) as never });

/** The production wiring: 5xx alerts and cap alerts are on. */
async function bootAlerting(db: Db) {
  const storage = fakeStorage();
  const app = await buildApp({ db: db as never, env, storage, notifyOnError: true, logLevel: 'silent' });
  await app.ready();
  return Object.assign(app, { fake: storage });
}

describe('POST /api/applications/uploads — only while the market takes applications', () => {
  it('accepts a file for an open market', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await upload(app);
    expect(res.statusCode).toBe(201);
    expect(db.count('application_uploads')).toBe(1);
    expect(app.fake.dump().size).toBe(1);
  });

  it('404s an unknown or inactive market and stores nothing', async () => {
    const db = seed({ farmers_markets: { wlrfm: market(), gone: market({ active: false }) } });
    const app = await boot(db);
    expect((await upload(app, 'nowhere')).statusCode).toBe(404);
    expect((await upload(app, 'gone')).statusCode).toBe(404);
    expect(db.count('application_uploads')).toBe(0);
    expect(app.fake.dump().size).toBe(0);
  });

  it('409s a market with no season, before the window opens and after it closes', async () => {
    const closed = seed({}, { season: null });
    const a = await boot(closed);
    const r1 = await upload(a);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error).toBe('Applications are closed for this market');

    const early = seed({}, { season: { label: '2027', application_open: '2027-01-01', application_close: null, schedule_version_id: 'v27' } });
    const b = await boot(early);
    expect((await upload(b)).statusCode).toBe(409);

    const late = seed({}, { season: { label: '2027', application_open: '2026-11-01', application_close: '2026-12-14', schedule_version_id: 'v27' } });
    const c = await boot(late);
    expect((await upload(c)).statusCode).toBe(409);

    for (const [db, app] of [[closed, a], [early, b], [late, c]] as const) {
      expect(db.count('application_uploads')).toBe(0);
      expect(app.fake.dump().size).toBe(0);
    }
  });

  it('the window is the market\'s own calendar: open on the last day in the market\'s timezone', async () => {
    // 2026-12-15T05:30Z is still 2026-12-14 23:30 in Chicago: the last open day.
    const db = seed({}, { season: { label: '2027', application_open: '2026-11-01', application_close: '2026-12-14', schedule_version_id: 'v27' } });
    const app = await boot(db);
    vi.setSystemTime(new Date('2026-12-15T05:30:00Z'));
    expect((await upload(app)).statusCode).toBe(201);
    vi.setSystemTime(new Date('2026-12-15T06:00:00Z')); // midnight in Chicago: closed
    expect((await upload(app)).statusCode).toBe(409);
  });

  it('400s a request with no market before anything is stored', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await send(app, { draft_id: DRAFT_ID, kind: 'permit' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('market is required');
    expect(db.count('application_uploads')).toBe(0);
  });
});

/** `n` upload documents already stored on `day`, spread over many drafts and addresses. */
function uploadsOn(day: string, n: number): Record<string, Record<string, unknown>> {
  const docs: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < n; i += 1) {
    docs[`seeded-${day}-${i}`] = {
      draft_id: `draft-${i}`,
      application_id: null,
      kind: 'permit',
      storage_path: `application-uploads/2026/draft-${i}/seeded-${i}.pdf`,
      mime: 'application/pdf',
      bytes: 10,
      ip: `198.51.100.${i % 250}`,
      day,
      uploaded_at: new Date(`${day}T12:00:00Z`),
      attached_at: null,
    };
  }
  return docs;
}

describe('POST /api/applications/uploads — the global daily cap', () => {
  it('is 300 a UTC day', () => {
    expect(UPLOAD_LIMITS.daily_global).toBe(300);
    expect(utcDay(T_OPEN)).toBe('2026-12-15');
    expect(utcDay(new Date('2026-12-15T23:59:59.999Z'))).toBe('2026-12-15');
    expect(utcDay(new Date('2026-12-16T00:00:00Z'))).toBe('2026-12-16');
  });

  it('503s the upload after the 300th of the day with a plain message, stores nothing and alerts staff', async () => {
    const db = seed({ application_uploads: uploadsOn('2026-12-15', 299) });
    const app = await bootAlerting(db);
    expect((await upload(app)).statusCode).toBe(201); // the 300th
    expect(notify).not.toHaveBeenCalled();

    const res = await upload(app, 'wlrfm', '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('We cannot accept more uploads today. Please try again tomorrow, or contact the market manager.');
    expect(db.count('application_uploads')).toBe(300);
    expect(app.fake.dump().size).toBe(1);

    expect(notify).toHaveBeenCalledTimes(1);
    const alert = notify.mock.calls[0]![0] as { source: string; err: Error };
    expect(alert.source).toBe('api:applications/uploads');
    expect(alert.err.message).toContain('daily cap of 300');
  });

  it('does not depend on the caller\'s address', async () => {
    const db = seed({ application_uploads: uploadsOn('2026-12-15', 300) });
    const app = await boot(db);
    for (const client of ['198.51.100.1', '198.51.100.2', '203.0.113.9']) {
      const mp = multipart({ market: 'wlrfm', draft_id: DRAFT_ID, kind: 'permit' }, FILE);
      const res = await app.inject({ method: 'POST', url: '/api/applications/uploads', headers: { ...mp.headers, 'x-forwarded-for': client }, payload: mp.payload });
      expect(res.statusCode).toBe(503);
    }
    expect(db.count('application_uploads')).toBe(300);
  });

  it('counts the UTC day only: yesterday\'s uploads do not count, and the cap lifts at 00:00 UTC', async () => {
    const db = seed({ application_uploads: { ...uploadsOn('2026-12-14', 300), ...uploadsOn('2026-12-15', 300) } });
    const app = await boot(db);
    expect((await upload(app)).statusCode).toBe(503);
    vi.setSystemTime(new Date('2026-12-16T00:00:01Z'));
    expect((await upload(app)).statusCode).toBe(201);
    expect((db.dump('application_uploads') as Record<string, { day?: string }>)[Object.keys(db.dump('application_uploads')).pop()!]!.day).toBe('2026-12-16');
  });

  it('says nothing to staff where 5xx alerts are off (local dev, tests)', async () => {
    const db = seed({ application_uploads: uploadsOn('2026-12-15', 300) });
    const app = await boot(db); // notifyOnError: false
    expect((await upload(app)).statusCode).toBe(503);
    expect(notify).not.toHaveBeenCalled();
  });
});

/** `n` applications already submitted to `marketId` at `at`. */
function applicationsAt(marketId: string, at: Date, n: number): Record<string, Record<string, unknown>> {
  const docs: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < n; i += 1) {
    docs[`flood-${marketId}-${at.getTime()}-${i}`] = {
      market_id: marketId,
      season: '2027',
      status: 'new',
      draft_id: `draft-${i}`,
      contact: { email: `flood${i}@example.test`, business_name: `Flood ${i}`, name: 'F' },
      schema_version: 2,
      submitted_at: at,
    };
  }
  return docs;
}

describe('POST /api/applications — the per-market daily cap', () => {
  it('is 150 a UTC day', () => {
    expect(SUBMISSION_LIMITS.daily_per_market).toBe(150);
  });

  it('503s the application after the 150th of the day, creates nothing and alerts staff', async () => {
    const db = seed({ applications: applicationsAt('wlrfm', new Date('2026-12-15T01:00:00Z'), 149) });
    const app = await bootAlerting(db);
    const ok = await submit(app); // the 150th
    expect(ok.statusCode).toBe(201);
    expect(notify).not.toHaveBeenCalled();

    const contact = { ...(validSubmission().contact as object), email: 'one.too.many@example.test' };
    const res = await submit(app, { draft_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', contact });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('We cannot accept more applications today. Please try again tomorrow, or contact the market manager.');
    expect(db.count('applications')).toBe(150);

    expect(notify).toHaveBeenCalledTimes(1);
    const alert = notify.mock.calls[0]![0] as { source: string; err: Error };
    expect(alert.source).toBe('api:applications');
    expect(alert.err.message).toContain('wlrfm');
    expect(alert.err.message).toContain('daily cap of 150');
    // The alert never carries applicant data.
    expect(alert.err.message).not.toMatch(/@|example\.test/);
  });

  it('a repeat of an accepted submission is still answered at the cap', async () => {
    const db = seed({ applications: applicationsAt('wlrfm', new Date('2026-12-15T01:00:00Z'), 149) });
    const app = await boot(db);
    const first = await submit(app);
    expect(first.statusCode).toBe(201);
    const again = await submit(app);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
  });

  it('is per market and per UTC day', async () => {
    const db = seed({
      applications: {
        ...applicationsAt('wlrfm', new Date('2026-12-15T01:00:00Z'), 150),
        ...applicationsAt('other', new Date('2026-12-14T23:00:00Z'), 150), // yesterday, the other market
      },
    });
    const app = await boot(db);
    expect((await submit(app)).statusCode).toBe(503);
    expect((await submit(app, { market_id: 'other' })).statusCode).toBe(201);
    vi.setSystemTime(new Date('2026-12-16T00:00:01Z'));
    expect((await submit(app)).statusCode).toBe(201);
  });
});

describe('purgeUnattachedUploads', () => {
  it('deletes an unattached upload older than 48 hours, keeps a fresh one and keeps an attached one of any age', async () => {
    const db = seed();
    const app = await boot(db);

    // An attached upload: uploaded, then claimed by a submitted application.
    const attachedId = (await upload(app)).json().upload_id as string;
    const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };
    const sub = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: attachedId } } });
    expect(sub.statusCode).toBe(201);

    // An abandoned upload from the same hour.
    const oldId = (await upload(app, 'wlrfm', '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a')).json().upload_id as string;

    // 47 hours later someone else uploads and has not submitted yet.
    vi.setSystemTime(new Date(T_OPEN.getTime() + 47 * HOUR));
    const freshId = (await upload(app, 'wlrfm', '11111111-2222-4333-8444-555555555555')).json().upload_id as string;
    expect(app.fake.dump().size).toBe(3);

    // The nightly run, 49 hours after the first two uploads.
    const now = new Date(T_OPEN.getTime() + 49 * HOUR);
    const result = await purgeUnattachedUploads(db as never, app.fake, now);
    expect(result).toEqual({ scanned: 2, deleted: 1, kept: 1, reattached: 0, failed: 0 });

    const docs = db.dump('application_uploads');
    expect(Object.keys(docs).sort()).toEqual([attachedId, freshId].sort());
    const paths = [...app.fake.dump().keys()];
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes(oldId))).toBe(false);
    expect(paths.some((p) => p.includes(attachedId))).toBe(true);
    expect(paths.some((p) => p.includes(freshId))).toBe(true);
    expect(docs[attachedId]).toMatchObject({ application_id: sub.json().id });

    // A year on, the attached upload is still there: it is part of the application's record.
    const later = await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 365 * 24 * HOUR));
    expect(later).toEqual({ scanned: 1, deleted: 1, kept: 0, reattached: 0, failed: 0 }); // the fresh one aged out
    expect(Object.keys(db.dump('application_uploads'))).toEqual([attachedId]);
    expect(app.fake.dump().size).toBe(1);
  });

  it('is exact at the 48-hour boundary', async () => {
    const db = seed();
    const app = await boot(db);
    await upload(app);
    expect(await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 48 * HOUR - 1))).toMatchObject({ deleted: 0, kept: 1 });
    expect(await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 48 * HOUR))).toMatchObject({ deleted: 1, kept: 0 });
  });

  it('does not throw when one delete fails: it counts it, keeps the document for the next run and carries on', async () => {
    const db = seed();
    const app = await boot(db);
    const a = (await upload(app, 'wlrfm', '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a')).json().upload_id as string;
    const b = (await upload(app, 'wlrfm', '11111111-2222-4333-8444-555555555555')).json().upload_id as string;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const flaky = {
      ...app.fake,
      delete: async (path: string) => {
        if (path.includes(a)) throw new Error('storage unavailable');
        await app.fake.delete(path);
      },
    };
    const now = new Date(T_OPEN.getTime() + 72 * HOUR);
    const result = await purgeUnattachedUploads(db as never, flaky, now);
    expect(result).toEqual({ scanned: 2, deleted: 1, kept: 0, reattached: 0, failed: 1 });
    expect(Object.keys(db.dump('application_uploads'))).toEqual([a]); // still there for the retry
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(a);
    expect(String(error.mock.calls[0]![0])).not.toContain('permit.pdf'); // never the file name

    // The next run, with storage back, finishes the job.
    expect(await purgeUnattachedUploads(db as never, app.fake, now)).toEqual({ scanned: 1, deleted: 1, kept: 0, reattached: 0, failed: 0 });
    expect(db.count('application_uploads')).toBe(0);
    expect(app.fake.dump().size).toBe(0);
    void b;
  });

  it('with nothing to do it reports zeros', async () => {
    const db = seed();
    expect(await purgeUnattachedUploads(db as never, fakeStorage(), T_OPEN)).toEqual({ scanned: 0, deleted: 0, kept: 0, reattached: 0, failed: 0 });
  });

  // A submission is two writes: the application, then the mark on each of its uploads. A request
  // that dies in between leaves an application whose files still read "unattached".
  describe('an upload an application names is never purged, whatever its flag says', () => {
    const dairy = { type: 'dairy', items: ['cheese'], practices: [], description: '', details: {} };

    /** Submits an application with one permit, then puts the upload back the way an interrupted request leaves it. */
    async function interrupted() {
      const db = seed();
      const app = await boot(db);
      const uploadId = (await upload(app)).json().upload_id as string;
      const sub = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: uploadId } } });
      expect(sub.statusCode).toBe(201);
      await db.collection('application_uploads').doc(uploadId).update({ application_id: null, attached_at: null });
      return { db, app, uploadId, applicationId: sub.json().id as string };
    }

    it('the purge marks it attached and keeps the file', async () => {
      const { db, app, uploadId, applicationId } = await interrupted();
      const abandoned = (await upload(app, 'wlrfm', '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a')).json().upload_id as string;
      const now = new Date(T_OPEN.getTime() + 72 * HOUR);

      const result = await purgeUnattachedUploads(db as never, app.fake, now);
      expect(result).toEqual({ scanned: 2, deleted: 1, kept: 0, reattached: 1, failed: 0 });
      expect(Object.keys(db.dump('application_uploads'))).toEqual([uploadId]);
      expect(db.dump('application_uploads')[uploadId]).toMatchObject({ application_id: applicationId, attached_at: now });
      expect([...app.fake.dump().keys()].some((p) => p.includes(uploadId))).toBe(true);
      expect([...app.fake.dump().keys()].some((p) => p.includes(abandoned))).toBe(false);

      // It is an attached upload from now on: later runs do not even look at it.
      expect(await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 400 * 24 * HOUR))).toEqual({ scanned: 0, deleted: 0, kept: 0, reattached: 0, failed: 0 });
    });

    it('also when the application has since been declined: its record keeps its files', async () => {
      const { db, app, uploadId, applicationId } = await interrupted();
      await db.collection('applications').doc(applicationId).update({ status: 'declined' });
      const result = await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 72 * HOUR));
      expect(result).toMatchObject({ deleted: 0, reattached: 1 });
      expect(app.fake.dump().size).toBe(1);
      expect(db.dump('application_uploads')[uploadId]).toMatchObject({ application_id: applicationId });
    });

    it('an upload of the same draft that the application does NOT name is still purged', async () => {
      const { db, app, uploadId } = await interrupted();
      const extra = (await upload(app)).json().upload_id as string; // same draft, a second file the applicant removed before submitting
      const result = await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 72 * HOUR));
      expect(result).toEqual({ scanned: 2, deleted: 1, kept: 0, reattached: 1, failed: 0 });
      expect(Object.keys(db.dump('application_uploads'))).toEqual([uploadId]);
      expect([...app.fake.dump().keys()].some((p) => p.includes(extra))).toBe(false);
    });

    it('repeating the submission marks the uploads at once, so staff can open them before any purge runs', async () => {
      const { db, app, uploadId, applicationId } = await interrupted();
      const again = await submit(app, { products: [dairy], permits: { dairy: { status: 'uploaded', upload_id: uploadId } } });
      expect(again.statusCode).toBe(201);
      expect(again.json().id).toBe(applicationId);
      expect(db.dump('application_uploads')[uploadId]).toMatchObject({ application_id: applicationId });
      expect(db.count('applications')).toBe(1);
      expect(await purgeUnattachedUploads(db as never, app.fake, new Date(T_OPEN.getTime() + 72 * HOUR))).toEqual({ scanned: 0, deleted: 0, kept: 0, reattached: 0, failed: 0 });
    });
  });
});
