import { z } from 'zod';
import type { Firestore } from 'firebase-admin/firestore';
import { toDateOrEpoch } from '../utils/dates.js';
import type { ExtraQuestion } from './market-dates.js';
import type { CheckinSource } from '../types/schema.js';

/**
 * The public check-in form's zod shape and the parsing/upsert logic behind
 * it (Phase 3 contract §4.1). The parsing rules are identical to the survey
 * importer's (`scripts/import-survey.mjs`, Phase 2 contract §7) — kept in
 * sync by inspection, not by import (the importer is excluded from the
 * functions bundle).
 */

export const checkinSubmitSchema = z.object({
  attending_next: z.boolean(),
  bringing_next: z.string().trim().max(1000).default(''),
  sold_out: z.string().trim().max(1000).default(''),
  unsold: z.string().trim().max(1000).default(''),
  estimated_sales: z.string().trim().max(50).default(''),
  transactions_estimate: z.string().trim().max(50).default(''),
  feedback: z.string().trim().max(2000).default(''),
  extra_answers: z.record(z.union([z.string().trim().max(1000), z.boolean()])).default({}),
});
export type CheckinSubmitInput = z.infer<typeof checkinSubmitSchema>;

export interface CheckinFormValues {
  attending_next: boolean | null;
  bringing_next: string;
  sold_out: string;
  unsold: string;
  estimated_sales: string;
  transactions_estimate: string;
  feedback: string;
  extra_answers: Record<string, string | boolean>;
}

export interface CheckinDoc {
  producer_id: string;
  market_id: string;
  market_date_id: string;
  submitted_at: Date;
  source: CheckinSource;
  token_id: string;
  estimated_sales: { value: number | null; raw: string; kind: 'exact' | 'range' | 'none' };
  transactions_estimate: { value: number | null; raw: string };
  sold_out_items: string[];
  sold_out_raw: string;
  unsold_items: string[];
  unsold_raw: string;
  attending_next: boolean | null;
  attending_next_raw: string;
  bringing_next: string[];
  bringing_next_raw: string;
  feedback: string;
  extra_answers: Record<string, string | boolean>;
  flags: string[];
  raw_import: null;
  submissions: number;
  partial: boolean;
  created_at: Date;
  updated_at: Date;
}

const EMPTY_ITEM_RE = /^(no|none|nope|nothing|n\/?a|-|no\.)$/i;

/** `$1,000.00` → exact; `500-1000` / `500 to 1000` → range midpoint; else none. */
export function parseMoney(raw: string): { value: number | null; kind: 'exact' | 'range' | 'none' } {
  const s = (raw ?? '').trim();
  if (!s) return { value: null, kind: 'none' };
  const stripped = s.replace(/[$,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(stripped)) {
    return { value: Number(stripped), kind: 'exact' };
  }
  const range = /^(\d+(?:\.\d+)?)(?:-|–|to)+(\d+(?:\.\d+)?)$/i.exec(stripped);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return { value: (lo + hi) / 2, kind: 'range' };
  }
  return { value: null, kind: 'none' };
}

/** First integer in the text; more than one → `ambiguous: true`. */
export function parseCount(raw: string): { value: number | null; ambiguous: boolean } {
  const matches = (raw ?? '').match(/\d+/g);
  if (!matches || matches.length === 0) return { value: null, ambiguous: false };
  return { value: Number(matches[0]), ambiguous: matches.length > 1 };
}

/** Splits a free-text list on `,`/`;`/newline/`and`; drops empties and "none"-like cells. */
export function splitItems(raw: string): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  if (EMPTY_ITEM_RE.test(s)) return [];
  return s
    .split(/[,;\n]|\band\b/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !EMPTY_ITEM_RE.test(x));
}

/**
 * Validates `extra_answers` against a date's `extra_questions`: unknown
 * keys, a `choice` value outside its options, a non-boolean `yes_no` or a
 * non-string `text` answer are all rejected. Missing answers are allowed.
 * Returns an error message, or null when valid.
 */
export function validateExtraAnswers(questions: ExtraQuestion[], answers: Record<string, string | boolean>): string | null {
  const byKey = new Map(questions.map((q) => [q.key, q]));
  for (const [key, value] of Object.entries(answers)) {
    const q = byKey.get(key);
    if (!q) return `extra_answers.${key}: unknown question`;
    if (q.type === 'choice') {
      if (typeof value !== 'string' || !(q.options ?? []).includes(value)) {
        return `extra_answers.${key}: must be one of ${JSON.stringify(q.options ?? [])}`;
      }
    } else if (q.type === 'yes_no') {
      if (typeof value !== 'boolean') return `extra_answers.${key}: must be true or false`;
    } else {
      if (typeof value !== 'string') return `extra_answers.${key}: must be text`;
    }
  }
  return null;
}

export interface UpsertFormCheckinArgs {
  market_date_id: string;
  market_id: string;
  producer_id: string;
  token_id: string;
  input: CheckinSubmitInput;
  now: Date;
}

/**
 * Writes the full §2.3 `checkins` shape for a form submission (doc id
 * `${market_date_id}_${producer_id}`, same as the importer). Resubmission
 * overwrites in place: `submissions` increments, `created_at` is preserved,
 * `partial` becomes false (a form submission always completes the record,
 * even over an SMS-created partial one).
 */
export async function upsertFormCheckin(db: Firestore, args: UpsertFormCheckinArgs): Promise<CheckinDoc> {
  const { market_date_id, market_id, producer_id, token_id, input, now } = args;
  const id = `${market_date_id}_${producer_id}`;
  const ref = db.collection('checkins').doc(id);
  const existingSnap = await ref.get();
  const existing = existingSnap.exists ? (existingSnap.data() as Record<string, unknown>) : null;

  const sales = parseMoney(input.estimated_sales);
  const tx = parseCount(input.transactions_estimate);
  const flags: string[] = [];
  if (sales.value !== null && sales.value > 20000) flags.push('sales_outlier');
  if (tx.ambiguous) flags.push('transactions_ambiguous');

  const doc: CheckinDoc = {
    producer_id,
    market_id,
    market_date_id,
    submitted_at: now,
    source: 'form',
    token_id,
    estimated_sales: { value: sales.value, raw: input.estimated_sales, kind: sales.kind },
    transactions_estimate: { value: tx.value, raw: input.transactions_estimate },
    sold_out_items: splitItems(input.sold_out),
    sold_out_raw: input.sold_out,
    unsold_items: splitItems(input.unsold),
    unsold_raw: input.unsold,
    attending_next: input.attending_next,
    attending_next_raw: input.attending_next ? 'yes' : 'no',
    bringing_next: splitItems(input.bringing_next),
    bringing_next_raw: input.bringing_next,
    feedback: input.feedback,
    extra_answers: input.extra_answers,
    flags,
    raw_import: null,
    submissions: (typeof existing?.submissions === 'number' ? (existing.submissions as number) : 0) + 1,
    partial: false,
    created_at: existing ? toDateOrEpoch(existing.created_at) : now,
    updated_at: now,
  };
  await ref.set(doc as unknown as Record<string, unknown>);
  return doc;
}

/** Maps a stored `checkins` doc back to the form's editable values (the `_raw` fields). */
export function toFormValues(checkin: Record<string, unknown>): CheckinFormValues {
  const sales = (checkin.estimated_sales ?? {}) as { raw?: string };
  const tx = (checkin.transactions_estimate ?? {}) as { raw?: string };
  return {
    attending_next: (checkin.attending_next as boolean | null | undefined) ?? null,
    bringing_next: (checkin.bringing_next_raw as string | undefined) ?? '',
    sold_out: (checkin.sold_out_raw as string | undefined) ?? '',
    unsold: (checkin.unsold_raw as string | undefined) ?? '',
    estimated_sales: sales.raw ?? '',
    transactions_estimate: tx.raw ?? '',
    feedback: (checkin.feedback as string | undefined) ?? '',
    extra_answers: (checkin.extra_answers as Record<string, string | boolean> | undefined) ?? {},
  };
}
