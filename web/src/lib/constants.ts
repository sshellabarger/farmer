// The FarmLink SMS number — the product's primary interface.
// Display + deep-link helpers so every surface promotes the same number.
export const FARMLINK_NUMBER_DISPLAY = '(501) 753-6622';
export const FARMLINK_NUMBER_E164 = '+15017536622';

// `sms:` deep link. The `?&body=` form is the most widely compatible
// across iOS and Android when a prefilled body is wanted.
export function smsHref(body?: string): string {
  if (!body) return `sms:${FARMLINK_NUMBER_E164}`;
  return `sms:${FARMLINK_NUMBER_E164}?&body=${encodeURIComponent(body)}`;
}

export const DEPOT_ADDRESS = '10301 N Rodney Parham Rd, STE C1, Little Rock, AR 72227';
