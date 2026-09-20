// Food Rescue Hero (Potluck) donation hand-off.
//
// Feature request: let a farmer start a surplus-food donation that today
// requires the Potluck/Food Rescue Hero admin intake form at
// admin.foodrescuehero.org/donations/intake/potluck.
//
// We open that intake page in a new tab and best-effort prefill it via query
// params built from the produce item. The intake form's exact field names are
// not documented, so it may ignore unknown params and show a blank form — the
// hand-off still works either way. Update PARAM_MAP if/when the real field
// names are confirmed.

const INTAKE_URL = 'https://admin.foodrescuehero.org/donations/intake/potluck';

export interface DonatableItem {
  product_name?: string;
  quantity?: number | string;
  remaining?: number | string;
  unit?: string;
}

// Best-effort query params. Kept centralized so the field names are easy to fix.
export function foodRescueIntakeUrl(item?: DonatableItem): string {
  if (!item) return INTAKE_URL;

  const qty = item.remaining ?? item.quantity;
  const params = new URLSearchParams();
  if (item.product_name) params.set('item', item.product_name);
  if (qty !== undefined && qty !== '') params.set('quantity', String(qty));
  if (item.unit) params.set('unit', item.unit);
  params.set('source', 'FarmLink');

  const qs = params.toString();
  return qs ? `${INTAKE_URL}?${qs}` : INTAKE_URL;
}

// Open the intake page in a new tab with prefilled params.
export function openFoodRescueDonation(item?: DonatableItem): void {
  if (typeof window === 'undefined') return;
  window.open(foodRescueIntakeUrl(item), '_blank', 'noopener,noreferrer');
}
