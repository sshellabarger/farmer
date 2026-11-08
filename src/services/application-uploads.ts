import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import type { StoragePort } from './storage-port.js';
import type { UploadKind } from '../types/schema.js';

/**
 * Public application uploads (Phase 4 contract §2.4, §3.1): a permit, an
 * insurance certificate or a logo, uploaded before the application exists and
 * attached to it on submit. The bytes live in Storage (through the
 * StoragePort), the metadata in `application_uploads`.
 *
 * Application documents hold personal data: nothing here logs a file name,
 * and no URL is ever stored — signed read URLs are minted per request.
 */

export const UPLOAD_LIMITS = {
  max_bytes: 10 * 1024 * 1024,
  mimes: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const,
  max_per_draft: 10,
  /** Informational: a nightly purge of unattached uploads is Phase 5. */
  retention_days: 14,
} as const;

export const UPLOAD_KINDS: readonly UploadKind[] = ['permit', 'insurance', 'logo'];

export const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export type DetectedFamily = 'pdf' | 'jpeg' | 'png' | 'heif';

/** The file type the first bytes say it is (`%PDF`, `FF D8 FF`, `89 50 4E 47`, `ftyp` at offset 4), or null. */
export function detectFamily(buffer: Buffer): DetectedFamily | null {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'heif';
  return null;
}

const FAMILY_OF_MIME: Record<string, DetectedFamily> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/heic': 'heif',
  'image/heif': 'heif',
};

export function isAllowedMime(mime: string): boolean {
  return (UPLOAD_LIMITS.mimes as readonly string[]).includes(mime);
}

/** Basename only, control characters and path separators removed, 200 characters at most. */
export function safeOriginalName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'upload').slice(0, 200);
}

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadMeta {
  id: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  original_name: string;
  uploaded_at: Date;
  application_id: string | null;
}

export interface SaveUploadArgs {
  db: Firestore;
  storage: StoragePort;
  draft_id: string;
  kind: string;
  filename: string;
  mime: string;
  buffer: Buffer;
  ip: string;
  now: Date;
}

export interface SavedUpload {
  upload_id: string;
  kind: UploadKind;
  bytes: number;
  mime: string;
  original_name: string;
}

/**
 * Validates and stores one upload. Order: input shape (400), size (413),
 * declared mime (415), magic bytes against the declared mime (415), the
 * per-draft cap (429); then the bytes go to storage and only then does the
 * metadata document appear, so a document always points at stored bytes.
 */
export async function saveApplicationUpload(args: SaveUploadArgs): Promise<SavedUpload> {
  const { db, storage, draft_id, filename, mime, buffer, ip, now } = args;
  if (!DRAFT_ID_RE.test(draft_id)) throw new UploadError(400, 'draft_id must be a UUID');
  if (!UPLOAD_KINDS.includes(args.kind as UploadKind)) throw new UploadError(400, "kind must be 'permit', 'insurance' or 'logo'");
  const kind = args.kind as UploadKind;
  if (buffer.length === 0) throw new UploadError(400, 'The file is empty');
  if (buffer.length > UPLOAD_LIMITS.max_bytes) throw new UploadError(413, 'The file is larger than 10 MB');
  if (!isAllowedMime(mime)) throw new UploadError(415, 'Upload a PDF, JPEG, PNG or HEIC file');
  const family = detectFamily(buffer);
  if (family === null || family !== FAMILY_OF_MIME[mime]) throw new UploadError(415, 'The file contents do not match its type');

  const existing = await db.collection('application_uploads').where('draft_id', '==', draft_id).get();
  if (existing.docs.length >= UPLOAD_LIMITS.max_per_draft) throw new UploadError(429, 'Too many files for this application');

  const id = uuid();
  const original_name = safeOriginalName(filename);
  const storage_path = `application-uploads/${now.getUTCFullYear()}/${draft_id}/${id}.${EXTENSIONS[mime]}`;
  await storage.put({ path: storage_path, buffer, contentType: mime });

  await db.collection('application_uploads').doc(id).set({
    draft_id,
    application_id: null,
    kind,
    storage_path,
    mime,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    original_name,
    ip,
    uploaded_at: now,
    attached_at: null,
    expires_at: new Date(now.getTime() + UPLOAD_LIMITS.retention_days * 24 * 60 * 60 * 1000),
  });

  return { upload_id: id, kind, bytes: buffer.length, mime, original_name };
}
