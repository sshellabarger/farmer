/**
 * Tax-exempt wholesale buyers (LFPP design, Nov 2026).
 *
 * Wholesale buyers are not charged sales tax. Each buyer gives SJCA an Arkansas
 * Exemption Certificate (ST-391), the multistate SST certificate (F0003), or an
 * out-of-state retail/resale permit. Staff check it and mark the buyer verified
 * before the first order.
 *
 * A blanket certificate covers repeat orders but lapses after 12 months with no
 * purchase (Arkansas rule GR-53), so FarmLink pauses ordering once that much
 * time has passed since the last order, and flags renewal a month earlier.
 *
 * Square has no tax-exempt setting for customers, so the exemption lives here,
 * on the buyer (`markets/{id}.tax_exempt`). The permit number stays in
 * FarmLink and is never sent to Square.
 */

export type TaxStatus = 'exempt_resale' | 'exempt_other' | 'taxable';
export type CertificateType = 'ST-391' | 'SST-F0003' | 'out_of_state_permit';

export interface TaxExemptProfile {
  status: TaxStatus;
  certificate_type?: CertificateType | null;
  /** Storage path of the uploaded certificate. */
  certificate_file?: string | null;
  /** YYYY-MM-DD the buyer signed the certificate. */
  signed_date?: string | null;
  /** Staff only. Never copied to Square. */
  permit_number?: string | null;
  legal_name?: string | null;
  legal_address?: string | null;
  verified_by?: string | null;
  verified_at?: string | Date | null;
  last_order_at?: string | Date | null;
}

export type TaxCheck =
  | { ok: true; renew_soon: boolean; certificate_type: CertificateType }
  | { ok: false; reason: 'missing' | 'not_verified' | 'taxable' | 'lapsed'; message: string };

export const LAPSE_MONTHS = 12;
export const RENEW_NOTICE_MONTHS = 11;

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/** Can this buyer place a wholesale order right now? */
export function checkTaxExempt(profile: TaxExemptProfile | null | undefined, now: Date = new Date()): TaxCheck {
  if (!profile || !profile.status) {
    return { ok: false, reason: 'missing', message: 'We need a sales tax exemption certificate on file before your first wholesale order. SJCA staff can help you send one.' };
  }
  if (profile.status === 'taxable') {
    return { ok: false, reason: 'taxable', message: 'Wholesale orders are for tax-exempt buyers. Please send SJCA a sales tax exemption certificate to start ordering.' };
  }
  if (!profile.certificate_type || !profile.verified_at) {
    return { ok: false, reason: 'not_verified', message: 'Your exemption certificate has not been verified yet. SJCA staff will let you know once it is.' };
  }
  // The blanket certificate lapses 12 months after the last purchase (or after signing, before any order).
  const since = toDate(profile.last_order_at) ?? toDate(profile.signed_date) ?? toDate(profile.verified_at)!;
  if (now >= addMonths(since, LAPSE_MONTHS)) {
    return { ok: false, reason: 'lapsed', message: 'Your exemption certificate has lapsed (12 months with no order). Please sign a new one to keep ordering.' };
  }
  return { ok: true, renew_soon: now >= addMonths(since, RENEW_NOTICE_MONTHS), certificate_type: profile.certificate_type };
}
