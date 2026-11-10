import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import type { StoragePort } from './storage-port.js';
import type { UploadKind } from '../types/schema.js';
import { toDate } from '../utils/dates.js';

/**
 * Public application uploads (Phase 4 contract §2.4, §3.1): a permit, an
 * insurance certificate or a logo, uploaded before the application exists and
 * attached to it on submit. The bytes live in Storage (through the
 * StoragePort), the metadata in `application_uploads`.
 *
 * Application documents hold personal data: nothing here logs a file name,
 * and no URL is ever stored — signed read URLs are minted per request.
 *
 * Flood control (Phase 4 fix X2). The route only accepts a file for a market
 * whose application window is open; on top of the per-IP rate limit and the
 * per-draft cap there is a global cap per UTC day that does not depend on the
 * caller's address; and `purgeUnattachedUploads` (nightly) deletes the files
 * nobody attached to an application within `unattached_ttl_hours`.
 */

export const UPLOAD_LIMITS = {
  max_bytes: 10 * 1024 * 1024,
  mimes: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const,
  max_per_draft: 10,
  /** At most this many upload documents per UTC day, whoever sends them. The next one is a 503 until 00:00 UTC. */
  daily_global: 300,
  /** An upload no application has claimed is deleted by the nightly purge once it is this old. Attached uploads are kept. */
  unattached_ttl_hours: 48,
} as const;

const HOUR_MS = 60 * 60 * 1000;

/** The UTC calendar day of an instant, 'YYYY-MM-DD' — the bucket of the global daily cap. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

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
    readonly status: 400 | 413 | 415 | 429 | 503,
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
 * per-draft cap (429), the global daily cap (503); then the bytes go to
 * storage and only then does the metadata document appear, so a document
 * always points at stored bytes.
 *
 * The daily cap counts the `application_uploads` documents whose `day` is
 * today (UTC) with one equality query. It is a flood backstop, not a ledger:
 * requests that overlap can each pass the count, so the day can end a few
 * documents over the cap (bounded by the concurrency), never by much.
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

  const day = utcDay(now);
  const today = await db.collection('application_uploads').where('day', '==', day).get();
  if (today.docs.length >= UPLOAD_LIMITS.daily_global) {
    throw new UploadError(503, 'We cannot accept more uploads today. Please try again tomorrow, or contact the market manager.');
  }

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
    day,
    uploaded_at: now,
    attached_at: null,
    // When the nightly purge may delete it if no application has claimed it by then.
    expires_at: new Date(now.getTime() + UPLOAD_LIMITS.unattached_ttl_hours * HOUR_MS),
  });

  return { upload_id: id, kind, bytes: buffer.length, mime, original_name };
}

/* ── Attaching uploads to the application that names them ── */

/**
 * Marks the uploads an application names (`upload_ids`) as attached to it.
 * Idempotent and safe to repeat: an upload is touched only when it exists,
 * belongs to the application's draft and is not attached to anything yet.
 * Returns how many were attached on this call.
 *
 * The submission calls this right after it creates the application, and again
 * whenever the same submission is repeated: a request that died between the
 * two writes left the application without its files marked, and without this
 * the nightly purge would later take them for abandoned.
 */
export async function attachUploads(db: Firestore, args: { application_id: string; draft_id: string; upload_ids: string[]; now: Date }): Promise<number> {
  let attached = 0;
  for (const uploadId of args.upload_ids) {
    const ref = db.collection('application_uploads').doc(uploadId);
    const data = (await ref.get()).data() as Record<string, unknown> | undefined;
    if (!data || data.draft_id !== args.draft_id || data.application_id) continue;
    await ref.update({ application_id: args.application_id, attached_at: args.now });
    attached += 1;
  }
  return attached;
}

/* ── Nightly purge of uploads nobody attached ── */

export interface PurgeResult {
  /** Unattached upload documents looked at. */
  scanned: number;
  /** Storage object and metadata document both removed. */
  deleted: number;
  /** Unattached but younger than the TTL: left alone. */
  kept: number;
  /** Not marked attached, but an application names it: marked now and kept (see `purgeUnattachedUploads`). */
  reattached: number;
  /** A delete threw; the upload stays and the next run retries it. */
  failed: number;
}

/**
 * Deletes the storage object and the metadata document of every upload that
 * no application has claimed (`application_id == null`) and that is older
 * than `UPLOAD_LIMITS.unattached_ttl_hours`. An attached upload is never
 * touched here, whatever its age: it is part of an application's record.
 *
 * Before anything is deleted the applications of the upload's draft are
 * asked: an application that lists the upload in `upload_ids` owns it,
 * whatever the flag on the upload says (a submission interrupted between
 * creating the application and marking its files leaves exactly that state).
 * Such an upload is marked attached and kept, never deleted: a permit or an
 * insurance certificate that belongs to an application cannot be recovered.
 *
 * One equality query for the uploads and one per draft for its applications;
 * the age filter is in memory. The object goes first and the document second,
 * so a failure in between leaves a document that the next run finds again
 * (deleting a missing object is not an error). A single failed upload is
 * counted and logged without the file name, and the run carries on: this
 * never throws for one bad upload.
 */
export async function purgeUnattachedUploads(db: Firestore, storage: StoragePort, now: Date): Promise<PurgeResult> {
  const cutoff = now.getTime() - UPLOAD_LIMITS.unattached_ttl_hours * HOUR_MS;
  const snap = await db.collection('application_uploads').where('application_id', '==', null).get();
  const result: PurgeResult = { scanned: 0, deleted: 0, kept: 0, reattached: 0, failed: 0 };

  /** upload id -> the application of that draft that names it. One query per draft. */
  const ownersByDraft = new Map<string, Map<string, string>>();
  const ownerOf = async (uploadId: string, draftId: unknown): Promise<string | null> => {
    if (typeof draftId !== 'string' || !draftId) return null;
    let owners = ownersByDraft.get(draftId);
    if (!owners) {
      owners = new Map<string, string>();
      const apps = await db.collection('applications').where('draft_id', '==', draftId).get();
      for (const a of apps.docs) {
        const ids = (a.data() as Record<string, unknown>).upload_ids;
        for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && !owners.has(id)) owners.set(id, a.id);
      }
      ownersByDraft.set(draftId, owners);
    }
    return owners.get(uploadId) ?? null;
  };

  for (const doc of snap.docs) {
    result.scanned += 1;
    const data = doc.data() as Record<string, unknown>;
    // Belt and braces: the query already asked for unattached uploads only.
    if (data.application_id) continue;
    const uploadedAt = toDate(data.uploaded_at);
    if (!uploadedAt || uploadedAt.getTime() > cutoff) {
      result.kept += 1;
      continue;
    }
    try {
      const owner = await ownerOf(doc.id, data.draft_id);
      if (owner) {
        await doc.ref.update({ application_id: owner, attached_at: now });
        result.reattached += 1;
        continue;
      }
      if (typeof data.storage_path === 'string' && data.storage_path) await storage.delete(data.storage_path);
      await doc.ref.delete();
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`purgeUnattachedUploads: could not purge upload ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
