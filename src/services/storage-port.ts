import type { Env } from '../config/env.js';

/**
 * Object storage for application uploads (Phase 4 contract §2.4, §3.1).
 *
 * A narrow port so routes and services never touch `firebase-admin/storage`
 * directly: production wires `firebaseStoragePort(env)` (the default in
 * `buildApp`), tests pass `fakeStorage()` from `tests/helpers/fake-storage.ts`.
 * The real implementation imports `firebase-admin/storage` lazily, on first
 * use, so constructing the app (or a test that never uploads) does no I/O and
 * needs no credentials.
 */

export interface StoragePutArgs {
  /** Object path inside the bucket, e.g. `application-uploads/2027/<draft_id>/<id>.pdf`. */
  path: string;
  buffer: Buffer;
  contentType: string;
}

export interface StorageSignedReadArgs {
  path: string;
  expiresInMs: number;
  /** Suggested download filename (Content-Disposition). */
  filename?: string;
}

export interface StoragePort {
  put(args: StoragePutArgs): Promise<void>;
  /** A time-limited read URL. Never stored, never logged. */
  signedReadUrl(args: StorageSignedReadArgs): Promise<string>;
  delete(path: string): Promise<void>;
}

/** Strip anything that could break out of a Content-Disposition header value. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'upload';
}

export function firebaseStoragePort(env: Pick<Env, 'STORAGE_BUCKET'>): StoragePort {
  async function bucket() {
    if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured; application uploads are unavailable');
    const { getStorage } = await import('firebase-admin/storage');
    return getStorage().bucket(env.STORAGE_BUCKET);
  }

  return {
    async put({ path, buffer, contentType }) {
      const file = (await bucket()).file(path);
      // Non-resumable: resumable uploads 404 against .firebasestorage.app buckets (see services/storage.ts).
      await file.save(buffer, { contentType, resumable: false });
    },
    async signedReadUrl({ path, expiresInMs, filename }) {
      const file = (await bucket()).file(path);
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + expiresInMs,
        ...(filename ? { responseDisposition: `attachment; filename="${safeFilename(filename)}"` } : {}),
      });
      return url;
    },
    async delete(path) {
      await (await bucket()).file(path).delete({ ignoreNotFound: true });
    },
  };
}
