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
