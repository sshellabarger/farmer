import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { isAlreadyExists } from '../db/firestore.js';
import { toDateOrEpoch } from '../utils/dates.js';
import type { BoothKind } from '../types/schema.js';
import type { FarmersMarket } from './markets.js';

/**
 * Booths (Phase 4 contract §2.7): the physical spaces of a market, as data.
 * Nothing in code names a stall, a row or a layout — the WLRFM V1..V22 map is
 * something the admin seeds through the API.
 *
 * Doc id = `${market_id}_${slug(label)}`, written with `create()`, so a label is
 * unique per market at creation. A later rename keeps the id (assignments and
 * memberships reference it).
 */

export interface BoothDoc {
  id: string;
  market_id: string;
  label: string;
  row: string;
  /** Ascending = north to south. A two-space vendor needs two booths in one row with consecutive `order`. */
  order: number;
  kind: BoothKind;
  power: boolean;
  size: string;
  notes: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Lower-case, runs of non-alphanumerics become '-', trimmed. '' when the label has no letter or digit. */
export function boothSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function boothDocId(marketId: string, label: string): string {
  return `${marketId}_${boothSlug(label)}`;
}

const str = (max: number) => z.string().trim().max(max);

const labelSchema = str(12)
  .min(1, 'label is required')
  .refine((v) => boothSlug(v) !== '', 'label must contain a letter or a digit');

export const createBoothSchema = z.object({
  label: labelSchema,
  row: str(20).min(1, 'row is required'),
  order: z.number().int(),
  kind: z.enum(['stall', 'food_truck']).default('stall'),
  power: z.boolean().default(false),
  size: str(20).default('12x12'),
  notes: str(500).default(''),
});
export type CreateBoothInput = z.infer<typeof createBoothSchema>;

export const updateBoothSchema = z
  .object({
    label: labelSchema.optional(),
    row: str(20).min(1, 'row is required').optional(),
    order: z.number().int().optional(),
    kind: z.enum(['stall', 'food_truck']).optional(),
    power: z.boolean().optional(),
    size: str(20).optional(),
    notes: str(500).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateBoothInput = z.infer<typeof updateBoothSchema>;

export const seedBoothsSchema = z.object({
  rows: z
    .array(z.object({ row: str(20).min(1, 'row is required'), labels: z.array(labelSchema).min(1).max(100) }))
    .min(1)
    .max(12),
  food_truck: z.object({ label: labelSchema, row: str(20).min(1), order: z.number().int() }).nullable().optional(),
});
export type SeedBoothsInput = z.infer<typeof seedBoothsSchema>;

export const reorderBoothsSchema = z.object({
  rows: z.array(z.object({ row: str(20).min(1, 'row is required'), booth_ids: z.array(z.string().min(1)).min(1).max(200) })).min(1).max(12),
});
export type ReorderBoothsInput = z.infer<typeof reorderBoothsSchema>;

export function boothFromData(id: string, data: Record<string, unknown>): BoothDoc {
  return {
    id,
    market_id: String(data.market_id ?? ''),
    label: String(data.label ?? ''),
    row: String(data.row ?? ''),
    order: typeof data.order === 'number' ? data.order : 0,
    kind: data.kind === 'food_truck' ? 'food_truck' : 'stall',
    power: data.power === true,
    size: typeof data.size === 'string' ? data.size : '',
    notes: typeof data.notes === 'string' ? data.notes : '',
    active: data.active !== false,
    created_at: toDateOrEpoch(data.created_at),
    updated_at: toDateOrEpoch(data.updated_at),
  };
}

/** Booth order everywhere: row, then `order`, then label — deterministic. */
export function compareBooths(a: BoothDoc, b: BoothDoc): number {
  return a.row.localeCompare(b.row) || a.order - b.order || a.label.localeCompare(b.label);
}

/** A market's booths, sorted. One equality filter; `active` is filtered in memory. */
export async function listBooths(db: Firestore, marketId: string, opts: { includeInactive?: boolean } = {}): Promise<BoothDoc[]> {
  const snap = await db.collection('booths').where('market_id', '==', marketId).get();
  const booths = snap.docs.map((d) => boothFromData(d.id, d.data() as Record<string, unknown>));
  return (opts.includeInactive ? booths : booths.filter((b) => b.active)).sort(compareBooths);
}

export async function loadMarketDoc(db: Firestore, id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

export type CreateBoothResult = { created: true; booth: BoothDoc } | { created: false; booth: null };

/** Creates a booth; `created: false` when the label (slug) already exists in the market. */
export async function createBooth(
  db: Firestore,
  marketId: string,
  input: CreateBoothInput,
  now: Date,
): Promise<CreateBoothResult> {
  const id = boothDocId(marketId, input.label);
  const data = {
    market_id: marketId,
    label: input.label,
    row: input.row,
    order: input.order,
    kind: input.kind,
    power: input.power,
    size: input.size,
    notes: input.notes,
    active: true,
    created_at: now,
    updated_at: now,
  };
  try {
    await db.collection('booths').doc(id).create(data);
  } catch (err) {
    if (isAlreadyExists(err)) return { created: false, booth: null };
    throw err;
  }
  return { created: true, booth: boothFromData(id, data) };
}

/**
 * Seeds a market's booths from a layout the admin supplies: each row's labels in
 * order (`order` = index + 1) and an optional food-truck slot. Existing labels are
 * skipped, never overwritten.
 */
export async function seedBooths(
  db: Firestore,
  marketId: string,
  input: SeedBoothsInput,
  now: Date,
): Promise<{ created: number; existing: number; booth_ids: string[] }> {
  let created = 0;
  let existing = 0;
  const booth_ids: string[] = [];
  const attempt = async (spec: CreateBoothInput) => {
    const r = await createBooth(db, marketId, spec, now);
    if (r.created) {
      created++;
      booth_ids.push(r.booth.id);
    } else existing++;
  };
  for (const row of input.rows) {
    for (let i = 0; i < row.labels.length; i++) {
      await attempt({ label: row.labels[i]!, row: row.row, order: i + 1, kind: 'stall', power: false, size: '12x12', notes: '' });
    }
  }
  if (input.food_truck) {
    const t = input.food_truck;
    await attempt({ label: t.label, row: t.row, order: t.order, kind: 'food_truck', power: false, size: '12x12', notes: '' });
  }
  return { created, existing, booth_ids };
}
