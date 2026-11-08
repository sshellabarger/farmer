import type { BoothRequest, MarketFees, SeasonTotal } from './phase4-types';

/**
 * The live total shown on the booth section. Mirrors the server's
 * `computeSeasonTotal` (contract section 2.2) exactly; the server value wins and
 * comes back on the submit result.
 *
 * Seasonal: booth fee = (paid-in-full price or season price) x spaces, paid
 * once for the whole season (in installments unless paid in full).
 * Daily: booth fee = daily rate x spaces, per market.
 * Electricity is charged once per vendor (one hookup), not per space.
 */
export function computeSeasonTotal(
  fees: MarketFees,
  booth: Pick<BoothRequest, 'rate' | 'spaces' | 'electric' | 'pay_in_full'>,
  marketCount: number,
): SeasonTotal {
  const seasonal = booth.rate === 'seasonal';
  const perSpace = seasonal ? (booth.pay_in_full ? fees.seasonal_paid_in_full : fees.seasonal_total) : fees.daily;
  const boothFee = perSpace * booth.spaces;
  const electricFee = booth.electric ? (seasonal ? fees.electric_seasonal : fees.electric_daily) : 0;
  return {
    rate: booth.rate,
    spaces: booth.spaces,
    electric: booth.electric,
    pay_in_full: booth.pay_in_full,
    market_count: marketCount,
    booth_fee: boothFee,
    electric_fee: electricFee,
    total: boothFee + electricFee,
    basis: seasonal ? 'season' : 'per_market',
    installments: seasonal ? (booth.pay_in_full ? 1 : fees.seasonal_installments) : 0,
    application_fee: fees.application_fee,
    currency: fees.currency,
  };
}

/** "$1,250" (no cents when the amount is whole) in the market's currency. */
export function formatMoney(amount: number, currency = 'USD'): string {
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${whole ? amount : amount.toFixed(2)}`;
  }
}

/** One-line description of a total: "$1,250 for the season, 2 installments" / "$30 per market". */
export function describeTotal(t: SeasonTotal): string {
  const money = formatMoney(t.total, t.currency);
  if (t.basis === 'per_market') return `${money} per market`;
  const pay = t.installments <= 1 ? 'paid in full' : `${t.installments} installments`;
  return `${money} for the season, ${pay}`;
}
