/**
 * Produce freshness tracking.
 *
 * Estimates shelf life from the product category/name and classifies
 * inventory by age since harvest:
 *   fresh  — under 60% of shelf life
 *   aging  — 60-100% of shelf life (sell or discount soon)
 *   past   — beyond shelf life (donate or compost)
 */

export type FreshnessStatus = 'fresh' | 'aging' | 'past';

export interface Freshness {
  age_days: number;
  shelf_life_days: number;
  freshness: FreshnessStatus;
}

// Keyword → shelf life in days. First match wins; checked against the
// product category first, then the product name.
const SHELF_LIFE_RULES: Array<[RegExp, number]> = [
  [/berr|cherr/i, 3],
  [/leafy|lettuce|spinach|arugula|salad|greens|chard|herb|basil|cilantro|parsley|dill|mint/i, 5],
  [/mushroom|sweet corn|corn|okra|asparagus|pea\b|peas\b|green bean/i, 5],
  [/tomato|peach|plum|nectarine|apricot|stone fruit|melon|cantaloupe|watermelon|cucumber|zucchini|summer squash|eggplant|broccoli|cauliflower/i, 7],
  [/pepper|grape|apple|pear|citrus|orange|lemon|lime|cabbage|brussels|kale|collard/i, 14],
  [/root|carrot|beet|turnip|radish|potato|sweet potato|onion|garlic|shallot|winter squash|pumpkin|egg\b|eggs\b|honey|jam|preserve/i, 21],
];

const DEFAULT_SHELF_LIFE_DAYS = 7;

export function shelfLifeDays(category?: string, productName?: string): number {
  for (const [pattern, days] of SHELF_LIFE_RULES) {
    if (category && pattern.test(category)) return days;
  }
  for (const [pattern, days] of SHELF_LIFE_RULES) {
    if (productName && pattern.test(productName)) return days;
  }
  return DEFAULT_SHELF_LIFE_DAYS;
}

// Plausibility bounds for a harvest date. Produce freshness is measured in
// days, so a date far in the past — or in the future — is almost always a typo
// or a wrong-year inference (e.g. an SMS assistant that guessed the year).
// Loosen these if you stock long-storage or shelf-stable goods.
export const MAX_HARVEST_AGE_DAYS = 120;
export const MAX_HARVEST_FUTURE_DAYS = 30;

export type HarvestDateResult =
  | { ok: true; date: Date }
  | { ok: false; message: string };

/**
 * Parse and sanity-check a harvest date before it is stored. Rejects
 * unparseable dates, dates more than MAX_HARVEST_AGE_DAYS in the past, and
 * dates more than MAX_HARVEST_FUTURE_DAYS in the future. Callers should only
 * pass a value the user actually supplied (handle "no date"/"clear" first).
 */
export function validateHarvestDate(
  input: Date | string,
  now: Date = new Date(),
): HarvestDateResult {
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) {
    return { ok: false, message: `"${String(input)}" isn't a date I can read. Try YYYY-MM-DD.` };
  }
  const ageDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (ageDays > MAX_HARVEST_AGE_DAYS) {
    return { ok: false, message: `That harvest date is ${ageDays} days ago — that looks off. Double-check the year?` };
  }
  if (-ageDays > MAX_HARVEST_FUTURE_DAYS) {
    return { ok: false, message: `That harvest date is ${-ageDays} days in the future — that looks off. Double-check the year?` };
  }
  return { ok: true, date };
}

export function classifyFreshness(
  harvestDate: Date | { toDate(): Date } | string | null | undefined,
  category?: string,
  productName?: string,
  now: Date = new Date(),
): Freshness | null {
  if (!harvestDate) return null;
  const harvested =
    typeof harvestDate === 'string' ? new Date(harvestDate)
    : harvestDate instanceof Date ? harvestDate
    : harvestDate.toDate();
  if (isNaN(harvested.getTime())) return null;

  const ageDays = Math.max(0, Math.floor((now.getTime() - harvested.getTime()) / 86400000));
  const shelf = shelfLifeDays(category, productName);
  const ratio = ageDays / shelf;

  return {
    age_days: ageDays,
    shelf_life_days: shelf,
    freshness: ratio >= 1 ? 'past' : ratio >= 0.6 ? 'aging' : 'fresh',
  };
}
