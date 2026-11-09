// Fix X2: the nightly rollMarketDates handler also purges the application
// uploads nobody attached, and a purge failure never fails the roll.
// The scheduled handler is driven directly (onSchedule exposes it as `.run`)
// over the fake Firestore and the fake storage port; nothing here can reach
// a real project.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeDb } from './helpers/fake-db.js';
import { fakeStorage } from './helpers/fake-storage.js';
import { DEFAULT_QUIET_HOURS, DEFAULT_WORKFLOW } from '../src/services/markets.js';
import type { StoragePort } from '../src/services/storage-port.js';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  notify: [] as { source?: string; err: unknown }[],
}));

vi.mock('../src/db/firestore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/firestore.js')>()),
  getDb: () => holder.db,
}));
vi.mock('../src/config/env.js', () => ({
  getEnv: () => ({ NODE_ENV: 'test', SMS_PROVIDER: 'console', EMAIL_PROVIDER: 'console', ALLOW_REAL_SENDS: 'false', APP_URL: 'https://test.example', STORAGE_BUCKET: 'unused', JWT_SECRET: 'x', ANTHROPIC_API_KEY: 'x', ALERT_EMAIL: '', ALERT_PHONE: '' }),
}));
vi.mock('../src/services/storage-port.js', () => ({ firebaseStoragePort: () => holder.storage }));
vi.mock('../src/services/error-notify.js', () => ({
  notifyError: vi.fn(async (args: { source?: string; err: unknown }) => {
    holder.notify.push({ source: args.source, err: args.err });
  }),
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => {
    throw new Error('firebase-admin/storage must not be used in these tests');
  },
}));

const NOW = new Date('2026-12-17T09:15:00Z'); // 03:15 in Chicago, when the job fires
const HOUR = 60 * 60 * 1000;

function seed() {
  const upload = (hoursOld: number, applicationId: string | null, id: string) => ({
    draft_id: `draft-${id}`,
    application_id: applicationId,
    kind: 'permit',
    storage_path: `application-uploads/2026/draft-${id}/${id}.pdf`,
    mime: 'application/pdf',
    bytes: 10,
    day: '2026-12-15',
    uploaded_at: new Date(NOW.getTime() - hoursOld * HOUR),
    attached_at: applicationId ? new Date(NOW.getTime() - hoursOld * HOUR) : null,
  });
  return fakeDb({
    farmers_markets: {
      wlrfm: {
        name: 'West Little Rock Farmers Market',
        slug: 'wlrfm',
        location: { name: 'Somewhere', address: '' },
        timezone: 'America/Chicago',
        schedule: {
          versions: [{ id: 'v27', effective_from: '2026-12-01', season_start: '2027-04-03', season_end: '2027-11-27', days_of_week: ['saturday'], start_time: '08:00', end_time: '12:00', created_at: new Date('2026-11-08'), created_by: 'admin1' }],
          skipped_dates: [],
          special_dates: [],
        },
        workflow: DEFAULT_WORKFLOW,
        quiet_hours: DEFAULT_QUIET_HOURS,
        active: true,
        created_by: 'test',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      },
    },
    application_uploads: {
      old_unattached: upload(60, null, 'old_unattached'),
      fresh_unattached: upload(5, null, 'fresh_unattached'),
      old_attached: upload(600, 'app-1', 'old_attached'),
    },
  });
}

async function storageWith(db: ReturnType<typeof fakeDb>) {
  const storage = fakeStorage();
  for (const u of Object.values(db.dump('application_uploads'))) {
    await storage.put({ path: String(u.storage_path), buffer: Buffer.from('%PDF'), contentType: 'application/pdf' });
  }
  return storage;
}

let logs: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  holder.notify.length = 0;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const run = async () => {
  const { rollMarketDates } = await import('../src/functions.js');
  await (rollMarketDates as unknown as { run: (event: unknown) => Promise<void> }).run({});
};

describe('rollMarketDates (nightly)', () => {
  it('rolls the dates, then purges the uploads nobody attached within 48 hours', async () => {
    const db = seed();
    const storage = await storageWith(db);
    holder.db = db;
    holder.storage = storage;

    await run();

    expect(logs.some((l) => l.startsWith('rollMarketDates: 1 markets'))).toBe(true);
    expect(logs).toContain('purgeUnattachedUploads: scanned=2 deleted=1 kept=1 failed=0');
    expect(Object.keys(db.dump('application_uploads')).sort()).toEqual(['fresh_unattached', 'old_attached']);
    expect([...storage.dump().keys()].sort()).toEqual([
      'application-uploads/2026/draft-fresh_unattached/fresh_unattached.pdf',
      'application-uploads/2026/draft-old_attached/old_attached.pdf',
    ]);
    expect(holder.notify).toEqual([]);
  });

  it('still succeeds when the purge fails outright, and staff are told', async () => {
    const db = seed();
    const storage = await storageWith(db);
    // The purge's first step (reading the uploads) fails.
    const collection = db.collection.bind(db);
    db.collection = ((name: string) => {
      if (name === 'application_uploads') throw new Error('UNAVAILABLE: simulated Firestore outage');
      return collection(name);
    }) as never;
    holder.db = db;
    holder.storage = storage;

    await expect(run()).resolves.toBeUndefined();

    expect(logs.some((l) => l.startsWith('rollMarketDates: 1 markets'))).toBe(true);
    expect(logs.some((l) => l.startsWith('purgeUnattachedUploads:'))).toBe(false);
    expect(holder.notify).toHaveLength(1);
    expect(holder.notify[0]!.source).toBe('scheduler:purgeUnattachedUploads');
    expect(storage.dump().size).toBe(3); // nothing was deleted
  });

  it('a storage outage during the purge is counted, not thrown', async () => {
    const db = seed();
    const broken: StoragePort = {
      put: async () => {},
      signedReadUrl: async () => '',
      delete: async () => {
        throw new Error('storage unavailable');
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    holder.db = db;
    holder.storage = broken;

    await expect(run()).resolves.toBeUndefined();
    expect(logs).toContain('purgeUnattachedUploads: scanned=2 deleted=0 kept=1 failed=1');
    expect(Object.keys(db.dump('application_uploads')).sort()).toEqual(['fresh_unattached', 'old_attached', 'old_unattached']);
    expect(holder.notify).toEqual([]);
  });
});
