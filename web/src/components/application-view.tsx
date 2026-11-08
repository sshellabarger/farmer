'use client';

import { useState, type ReactNode } from 'react';
import type { ApplicationDoc, MarketFees, UploadMeta } from '@/lib/phase4-types';
import type { Market } from '@/lib/types';
import { StatusChip } from './status-chip';
import { formatStamp } from './admin-shell';

/**
 * Read-only rendering of one stored application (Phase 4 contract section 4.2).
 * Contains personal data and admin-only fields (sms consent ip, review notes
 * are rendered by the page, never here); only mounted behind the admin guard.
 * Uploads are never linked directly: each "Open" button asks the page for a
 * short-lived signed URL.
 */

export function formatMoney(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Preview of the season total for the approval dialog; mirrors contract 2.2. The server's frozen value is on the application. */
export function previewSeasonTotal(
  fees: MarketFees,
  booth: { rate: 'seasonal' | 'daily'; spaces: 1 | 2; electric: boolean; pay_in_full: boolean },
  marketCount: number,
): { total: number; basis: 'season' | 'per_market'; installments: number; marketCount: number } {
  if (booth.rate === 'seasonal') {
    const boothFee = (booth.pay_in_full ? fees.seasonal_paid_in_full : fees.seasonal_total) * booth.spaces;
    const electric = booth.electric ? fees.electric_seasonal : 0;
    return { total: boothFee + electric, basis: 'season', installments: booth.pay_in_full ? 1 : fees.seasonal_installments, marketCount };
  }
  const boothFee = fees.daily * booth.spaces;
  const electric = booth.electric ? fees.electric_daily : 0;
  return { total: boothFee + electric, basis: 'per_market', installments: 0, marketCount };
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mt-0 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-sm text-earth-800 break-words">{children || <span className="text-earth-400">-</span>}</dd>
    </div>
  );
}

function Pairs({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 m-0">{children}</dl>;
}

function yesNo(v: boolean): string {
  return v ? 'Yes' : 'No';
}

export function ApplicationView({
  application: a,
  uploads,
  market,
  onOpenUpload,
}: {
  application: ApplicationDoc;
  uploads: UploadMeta[];
  market: Market | null;
  /** Fetches a signed URL and opens it. Resolves when the attempt is finished. */
  onOpenUpload: (uploadId: string) => Promise<void>;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const uploadById = new Map(uploads.map((u) => [u.id, u]));
  const typeLabel = (key: string) => market?.product_types?.find((t) => t.key === key)?.label || humanize(key);
  const categoryLabel = (key: string) => market?.categories?.find((c) => c.key === key)?.label || humanize(key);
  const currency = a.season_total.currency || 'USD';

  const open = async (uploadId: string) => {
    setOpening(uploadId);
    try {
      await onOpenUpload(uploadId);
    } finally {
      setOpening(null);
    }
  };

  const UploadButton = ({ uploadId }: { uploadId: string | null }) => {
    if (!uploadId) return null;
    const meta = uploadById.get(uploadId);
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => open(uploadId)}
          disabled={opening !== null}
          className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-earth-200 bg-white text-green-700 cursor-pointer disabled:opacity-50"
        >
          {opening === uploadId ? 'Opening...' : 'Open'}
        </button>
        <span className="text-[11px] text-text-muted">{meta ? `${meta.original_name} (${Math.max(1, Math.round(meta.bytes / 1024))} KB)` : 'file'}</span>
      </span>
    );
  };

  const addr = a.contact.address;
  const addressText = [addr.street, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' ');

  return (
    <div className="space-y-6">
      <Section title="Applicant">
        <Pairs>
          <Pair label="Business">{a.contact.business_name}</Pair>
          <Pair label="Contact">{a.contact.name}</Pair>
          <Pair label="Email">{a.contact.email}</Pair>
          <Pair label="Mobile"><span className="font-mono">{a.contact.mobile}</span></Pair>
          <Pair label="Address">{addressText}</Pair>
          <Pair label="Website">{a.contact.website}</Pair>
          <Pair label="Social">{a.contact.social}</Pair>
          <Pair label="Years in operation">{a.contact.years_in_operation === null ? '' : String(a.contact.years_in_operation)}</Pair>
          <Pair label="Where else you sell">{a.contact.outlets}</Pair>
          <Pair label="Agricultural practices">{humanize(a.contact.agricultural_practices)}</Pair>
          <Pair label="New or returning">
            {a.returning.is_returning ? `Returning${a.returning.last_stall ? ` (last stall ${a.returning.last_stall})` : ''}` : 'New vendor'}
          </Pair>
          <Pair label="Text consent">
            Opted in {formatStamp(a.sms_consent.at)} <span className="text-text-muted">(text version {a.sms_consent.text_version})</span>
          </Pair>
        </Pairs>
        {a.contact.description && (
          <div className="mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">About the business</div>
            <p className="text-sm text-earth-800 m-0 whitespace-pre-wrap">{a.contact.description}</p>
          </div>
        )}
        {a.contact.additional_info && (
          <div className="mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">Additional information</div>
            <p className="text-sm text-earth-800 m-0 whitespace-pre-wrap">{a.contact.additional_info}</p>
          </div>
        )}
      </Section>

      <Section title="What they sell">
        <div className="flex flex-wrap gap-1.5 mb-4">
          {a.categories.map((c) => (
            <span key={c} className="text-[12px] px-2 py-0.5 rounded-full bg-earth-50 border border-earth-100">{categoryLabel(c)}</span>
          ))}
        </div>
        <div className="space-y-4">
          {a.products.map((p) => {
            const permit = a.permits[p.type];
            return (
              <div key={p.type} className="rounded-xl border border-earth-100 bg-earth-15 p-3">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="font-semibold text-sm text-earth-800">{typeLabel(p.type)}</span>
                  <span className="text-[11px] text-text-muted">listed under {categoryLabel(p.category)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {p.items.map((item, i) => (
                    <span key={`${item}-${i}`} className="text-[12px] px-2 py-0.5 rounded-full bg-white border border-earth-100">{item}</span>
                  ))}
                </div>
                {p.practices.length > 0 && <div className="text-[12px] text-text-soft mb-1">Practices: {p.practices.map(humanize).join(', ')}</div>}
                {p.description && <p className="text-sm m-0 mb-1 whitespace-pre-wrap">{p.description}</p>}
                {Object.keys(p.details || {}).length > 0 && (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[13px] m-0 mb-1">
                    {Object.entries(p.details).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-text-muted">{humanize(k)}</dt>
                        <dd className="m-0">{typeof v === 'boolean' ? yesNo(v) : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {permit && (
                  <div className="flex items-center gap-2 flex-wrap text-[13px] mt-1">
                    <span className="text-text-muted">Permit:</span>
                    <span className="font-medium">{humanize(permit.status)}</span>
                    <UploadButton uploadId={permit.upload_id} />
                    {permit.note && <span className="text-text-soft">{permit.note}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4">
          <Pair label="Payment methods accepted">{a.payment_methods.map((m) => m.toUpperCase() === 'WIC' || m.toUpperCase() === 'SNAP' ? m.toUpperCase() : humanize(m)).join(', ')}</Pair>
        </div>
      </Section>

      <Section title="Booth request">
        <Pairs>
          <Pair label="Rate"><StatusChip status={a.booth.rate} /></Pair>
          <Pair label="Spaces">{String(a.booth.spaces)}</Pair>
          <Pair label="Electricity">{yesNo(a.booth.electric)}</Pair>
          <Pair label="Pay in full on acceptance">{a.booth.rate === 'seasonal' ? yesNo(a.booth.pay_in_full) : 'Not applicable'}</Pair>
          <Pair label="Food truck or trailer">{yesNo(a.booth.food_truck)}</Pair>
          <Pair label="Stall preference">{a.booth.stall_preference.join(', ')}</Pair>
          {a.booth.rate === 'daily' && <Pair label="How often">{a.booth.frequency ? humanize(a.booth.frequency) : ''}</Pair>}
          {a.booth.rate === 'daily' && <Pair label="Months">{a.booth.months.map(humanize).join(', ')}</Pair>}
        </Pairs>
        <div className="mt-4 rounded-xl border border-earth-100 bg-earth-15 p-3 text-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">Total at submission</div>
          <div className="font-semibold text-earth-800">
            {formatMoney(a.season_total.total, currency)}
            {a.season_total.basis === 'per_market' ? ' per market' : ` for ${a.season_total.market_count} markets`}
            {a.season_total.basis === 'season' && a.season_total.installments > 0
              ? ` - ${a.season_total.installments} installment${a.season_total.installments === 1 ? '' : 's'}`
              : ''}
          </div>
          <div className="text-[12px] text-text-soft mt-0.5">
            Booth {formatMoney(a.season_total.booth_fee, currency)} + electricity {formatMoney(a.season_total.electric_fee, currency)}
          </div>
        </div>
      </Section>

      <Section title="Insurance, rules and signature">
        <Pairs>
          <Pair label="Insurance">
            {a.insurance.status === 'have' ? 'Has liability insurance' : a.insurance.status === 'none' ? 'No insurance yet' : 'Needs guidance'}
          </Pair>
          <Pair label="Carrier">{a.insurance.carrier}</Pair>
          <Pair label="Expires">{a.insurance.expires_on || ''}</Pair>
          <Pair label="Certificate">
            <UploadButton uploadId={a.insurance.certificate_upload_id} />
          </Pair>
          <Pair label="Rules acknowledged">
            Version {a.acknowledgements.rules.version || '(unversioned)'}, {formatStamp(a.acknowledgements.rules.at)}
          </Pair>
          <Pair label="Weekly market report">{yesNo(a.acknowledgements.weekly_report)}</Pair>
          <Pair label="Farm or facility visits">{yesNo(a.acknowledgements.farm_visits)}</Pair>
          <Pair label="Marketing use of names and photos">{yesNo(a.acknowledgements.marketing)}</Pair>
          <Pair label="Only items listed">{yesNo(a.acknowledgements.products_listed_only)}</Pair>
          <Pair label="Own booth only (no shared or cooperative booths)">{yesNo(a.acknowledgements.own_booth_only)}</Pair>
          <Pair label="Signed by">
            {a.signature.name} <span className="text-text-muted">{formatStamp(a.signature.signed_at)}</span>
          </Pair>
        </Pairs>
      </Section>

      <Section title="Application fee">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <StatusChip status={a.fee.status} />
          <span className="font-semibold">{formatMoney(a.fee.amount, a.fee.currency || currency)}</span>
          {a.fee.paid_at && <span className="text-text-muted">marked {formatStamp(a.fee.paid_at)}</span>}
          {a.fee.reference && <span className="text-text-muted">ref {a.fee.reference}</span>}
        </div>
      </Section>
    </div>
  );
}
