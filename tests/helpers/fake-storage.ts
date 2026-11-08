import type { StoragePort } from '../../src/services/storage-port.js';

/**
 * In-memory StoragePort for tests (Phase 4 contract §5.1). `dump()` returns
 * every stored object so a test can assert on the path, bytes and content
 * type; signed URLs are deterministic and point nowhere.
 */
export function fakeStorage(): StoragePort & { dump(): Map<string, { buffer: Buffer; contentType: string }> } {
  const objects = new Map<string, { buffer: Buffer; contentType: string }>();
  return {
    async put({ path, buffer, contentType }) {
      objects.set(path, { buffer: Buffer.from(buffer), contentType });
    },
    signedReadUrl: async ({ path, expiresInMs }) => `https://fake-storage.test/${path}?exp=${expiresInMs}`,
    async delete(path) {
      objects.delete(path);
    },
    dump() {
      return objects;
    },
  };
}
