import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DRAFT_ID, PDF_BYTES, T_OPEN, boot, multipart, seed } from './helpers/a1-fixtures.js';
import { firebaseStoragePort } from '../src/services/storage-port.js';
import { detectFamily, safeOriginalName } from '../src/services/application-uploads.js';

// Application uploads reach storage only through the injected port; the real bucket must never be touched.
const getStorage = vi.hoisted(() => vi.fn(() => {
  throw new Error('firebase-admin/storage must not be used in these tests');
}));
vi.mock('firebase-admin/storage', () => ({ getStorage }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif'.repeat(30))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png'.repeat(30))]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(40)]);

const send = (app: FastifyInstance, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) => {
  const mp = multipart(fields, file);
  return app.inject({ method: 'POST', url: '/api/applications/uploads', headers: mp.headers, payload: mp.payload });
};

describe('POST /api/applications/uploads', () => {
  it.each([
    ['permit.pdf', 'application/pdf', PDF_BYTES, 'pdf'],
    ['photo.jpg', 'image/jpeg', JPG, 'jpg'],
    ['scan.png', 'image/png', PNG, 'png'],
    ['IMG_1.HEIC', 'image/heic', HEIC, 'heic'],
    ['IMG_2.heif', 'image/heif', HEIC, 'heif'],
  ])('accepts %s and stores it at the contract path', async (name, type, data, ext) => {
    const db = seed();
    const app = await boot(db);
    const res = await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name, type, data });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ upload_id: expect.any(String), kind: 'permit', bytes: data.length, mime: type, original_name: name });

    const doc = db.dump('application_uploads')[body.upload_id]!;
    expect(doc).toMatchObject({
      draft_id: DRAFT_ID,
      application_id: null,
      kind: 'permit',
      mime: type,
      bytes: data.length,
      original_name: name,
      ip: '127.0.0.1',
      attached_at: null,
      storage_path: `application-uploads/2026/${DRAFT_ID}/${body.upload_id}.${ext}`,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    });
    expect((doc.expires_at as Date).getTime() - (doc.uploaded_at as Date).getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    const stored = app.fake.dump().get(doc.storage_path as string)!;
    expect(stored.contentType).toBe(type);
    expect(stored.buffer.equals(data)).toBe(true);
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('accepts all three kinds', async () => {
    const app = await boot(seed());
    for (const kind of ['permit', 'insurance', 'logo']) {
      expect((await send(app, { draft_id: DRAFT_ID, kind }, { name: 'a.pdf', type: 'application/pdf', data: PDF_BYTES })).statusCode).toBe(201);
    }
  });

  it('413s a file over 10 MB and stores nothing', async () => {
    const db = seed();
    const app = await boot(db);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 0x61)]);
    const res = await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'big.pdf', type: 'application/pdf', data: big });
    expect(res.statusCode).toBe(413);
    expect(db.count('application_uploads')).toBe(0);
    expect(app.fake.dump().size).toBe(0);
  });

  it('415s an executable renamed .pdf (magic bytes) and a declared type that does not match the bytes', async () => {
    const db = seed();
    const app = await boot(db);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 0x90)]);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'permit.pdf', type: 'application/pdf', data: exe })).statusCode).toBe(415);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'permit.jpg', type: 'image/jpeg', data: PNG })).statusCode).toBe(415);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'notes.txt', type: 'text/plain', data: Buffer.from('%PDF-hello') })).statusCode).toBe(415);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'a.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>') })).statusCode).toBe(415);
    expect(db.count('application_uploads')).toBe(0);
    expect(app.fake.dump().size).toBe(0);
  });

  it('429s the eleventh upload for one draft but not for another', async () => {
    const app = await boot(seed());
    for (let i = 0; i < 10; i += 1) {
      expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: `p${i}.pdf`, type: 'application/pdf', data: PDF_BYTES })).statusCode).toBe(201);
    }
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'p11.pdf', type: 'application/pdf', data: PDF_BYTES })).statusCode).toBe(429);
    expect((await send(app, { draft_id: '7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a', kind: 'permit' }, { name: 'p.pdf', type: 'application/pdf', data: PDF_BYTES })).statusCode).toBe(201);
  });

  it('400s a missing or malformed field, an empty file, two files and a non-multipart request', async () => {
    const app = await boot(seed());
    const file = { name: 'a.pdf', type: 'application/pdf', data: PDF_BYTES };
    expect((await send(app, { kind: 'permit' }, file)).statusCode).toBe(400);
    expect((await send(app, { draft_id: 'not-a-uuid', kind: 'permit' }, file)).statusCode).toBe(400);
    expect((await send(app, { draft_id: DRAFT_ID }, file)).statusCode).toBe(400);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'selfie' }, file)).statusCode).toBe(400);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' })).statusCode).toBe(400);
    expect((await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: 'a.pdf', type: 'application/pdf', data: Buffer.alloc(0) })).statusCode).toBe(400);
    const json = await app.inject({ method: 'POST', url: '/api/applications/uploads', payload: { draft_id: DRAFT_ID, kind: 'permit' } });
    expect(json.statusCode).toBe(400);
  });

  it('keeps only the base name of the original file name', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await send(app, { draft_id: DRAFT_ID, kind: 'permit' }, { name: '..\\..\\etc/evil\u0007.pdf', type: 'application/pdf', data: PDF_BYTES });
    expect(res.statusCode).toBe(201);
    expect(res.json().original_name).toBe('evil.pdf');
    expect(JSON.stringify(db.dump('application_uploads'))).not.toContain('..');
  });
});

describe('helpers', () => {
  it('detectFamily reads the first bytes', () => {
    expect(detectFamily(PDF_BYTES)).toBe('pdf');
    expect(detectFamily(JPG)).toBe('jpeg');
    expect(detectFamily(PNG)).toBe('png');
    expect(detectFamily(HEIC)).toBe('heif');
    expect(detectFamily(Buffer.from('hello world, not a file'))).toBeNull();
    expect(detectFamily(Buffer.alloc(0))).toBeNull();
  });

  it('safeOriginalName strips paths, control characters and over-long names', () => {
    expect(safeOriginalName('C:\\Users\\me\\permit.pdf')).toBe('permit.pdf');
    expect(safeOriginalName('a'.repeat(300) + '.pdf')).toHaveLength(200);
    expect(safeOriginalName('')).toBe('upload');
  });
});

describe('firebaseStoragePort (the production implementation, against a mocked bucket)', () => {
  it('saves non-resumable, signs a time-limited read URL and deletes tolerantly', async () => {
    const save = vi.fn(async () => {});
    const getSignedUrl = vi.fn(async () => ['https://signed.test/x']);
    const del = vi.fn(async () => {});
    const file = vi.fn(() => ({ save, getSignedUrl, delete: del }));
    const bucket = vi.fn(() => ({ file }));
    getStorage.mockReturnValue({ bucket } as never);

    const port = firebaseStoragePort({ STORAGE_BUCKET: 'bucket-1' });
    await port.put({ path: 'application-uploads/2027/d/u.pdf', buffer: PDF_BYTES, contentType: 'application/pdf' });
    expect(bucket).toHaveBeenCalledWith('bucket-1');
    expect(file).toHaveBeenCalledWith('application-uploads/2027/d/u.pdf');
    expect(save).toHaveBeenCalledWith(PDF_BYTES, { contentType: 'application/pdf', resumable: false });

    const url = await port.signedReadUrl({ path: 'p', expiresInMs: 15 * 60_000, filename: 'my "permit".pdf' });
    expect(url).toBe('https://signed.test/x');
    const arg = (getSignedUrl.mock.calls[0] as unknown as [{ action: string; expires: number; responseDisposition: string }])[0];
    expect(arg.action).toBe('read');
    expect(arg.expires).toBe(T_OPEN.getTime() + 15 * 60_000);
    expect(arg.responseDisposition).toBe('attachment; filename="my _permit_.pdf"');

    await port.delete('p');
    expect(del).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('refuses to run without a configured bucket', async () => {
    getStorage.mockImplementation(() => {
      throw new Error('should not be reached');
    });
    await expect(firebaseStoragePort({ STORAGE_BUCKET: '' }).put({ path: 'x', buffer: PDF_BYTES, contentType: 'application/pdf' })).rejects.toThrow(/STORAGE_BUCKET/);
  });

  it('constructing the port and the app does no I/O', async () => {
    getStorage.mockImplementation(() => {
      throw new Error('should not be reached');
    });
    firebaseStoragePort({ STORAGE_BUCKET: 'b' });
    const { buildApp } = await import('../src/app.js');
    const app = await buildApp({ db: seed() as never, env: { JWT_SECRET: 'x', NODE_ENV: 'test', APP_URL: 'http://t', ANTHROPIC_API_KEY: 'x', VOIPMS_WEBHOOK_SECRET: '', STORAGE_BUCKET: 'b' } as never, notifyOnError: false, logLevel: 'silent' });
    await app.ready();
    expect(getStorage).not.toHaveBeenCalled();
  });
});
