import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';

/**
 * Upload an image buffer to Firebase Storage and return a stable, tokenized
 * download URL (works with uniform bucket-level access — no public ACL needed).
 */
export async function uploadImageBuffer(
  env: Env,
  buffer: Buffer,
  mime: string,
): Promise<{ url: string; filename: string }> {
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const filename = `uploads/${randomUUID()}.${ext}`;

  const bucket = getStorage().bucket(env.STORAGE_BUCKET);
  const file = bucket.file(filename);

  const downloadToken = randomUUID();
  await file.save(buffer, {
    contentType: mime,
    // Force a simple (non-resumable) upload. Resumable uploads 404 ("bucket does
    // not exist") against .firebasestorage.app buckets; images are small enough
    // that a single-request upload is the right choice anyway.
    resumable: false,
    metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
  });

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filename)}?alt=media&token=${downloadToken}`;
  return { url, filename };
}
