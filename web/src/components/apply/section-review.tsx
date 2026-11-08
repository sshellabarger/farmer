'use client';

import type { ReactNode } from 'react';
import { availableTypes, type ApplyValues } from '@/lib/apply-draft';
import { computeSeasonTotal, describeTotal, formatMoney } from '@/lib/fees';
import type { ApplicationConfig, PermitStatus } from '@/lib/phase4-types';
import { NoteBox, SectionHeading } from './kit';

const PERMIT_TEXT: Record<PermitStatus, string> = {
  uploaded: 'Permit uploaded',
  will_provide: 'Will provide before the first market',
  not_required: 'Not required',
  food_freedom: 'Food Freedom labeled products only',
};

const INSURANCE_TEXT = {
  have: 'Has liability insurance',
  none: 'Does not have insurance yet',
  need_guidance: 'Needs guidance getting insurance',
} as const;

function Group({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-earth-100 bg-white p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="m-0 text-[15px] font-bold text-earth-800">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="bg-transparent border-none cursor-pointer text-green-700 underline text-sm p-0"
          style={{ minHeight: 32 }}
        >
          Edit
        </button>
      </div>
      <dl className="m-0 space-y-1.5">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-x-3 text-sm">
      <dt className="text-earth-500 font-semibold">{label}</dt>
      <dd className="m-0 text-earth-800 break-words">{children}</dd>
    </div>
  );
}

/** Section 5: a read-only summary of everything entered, with an Edit link per section. */
export function SectionReview({
  values,
  config,
  onEdit,
}: {
  values: ApplyValues;
  config: ApplicationConfig;
  onEdit: (section: number) => void;
}) {
  const b = values.business;
  const bo = values.booth;
  const types = availableTypes(config, values.categories);
  const label = (list: { key: string; label: string }[], key: string) => list.find((x) => x.key === key)?.label ?? key;
  const stallLabel = (id: string) => config.stalls.find((s) => s.id === id)?.label ?? id;
  const total = bo.rate
    ? computeSeasonTotal(config.fees, { rate: bo.rate, spaces: bo.spaces, electric: bo.electric, pay_in_full: bo.rate === 'seasonal' && bo.pay_in_full }, config.season.market_count)
    : null;

  return (
    <div className="space-y-4">
      <SectionHeading title="Review and submit" intro="Check everything below. Use Edit to change anything, then submit." />

      <Group title="You and your business" onEdit={() => onEdit(0)}>
        <Row label="Vendor">{b.is_returning ? `Returning${b.last_stall ? `, last season in ${b.last_stall}` : ''}` : 'New'}</Row>
        <Row label="Name">{b.name}</Row>
        <Row label="Business">{b.business_name}</Row>
        <Row label="Email">{b.email}</Row>
        <Row label="Mobile">{b.mobile} (agreed to market texts)</Row>
        <Row label="Address">{[b.street, b.city, b.state, b.zip].filter(Boolean).join(', ')}</Row>
        {b.website && <Row label="Website">{b.website}</Row>}
        {b.social && <Row label="Social">{b.social}</Row>}
        {b.description && <Row label="About">{b.description}</Row>}
        {b.years_in_operation && <Row label="Years in operation">{b.years_in_operation}</Row>}
        {b.outlets && <Row label="Other outlets">{b.outlets}</Row>}
        <Row label="Growing practices">{label(config.agricultural_practices, b.agricultural_practices)}</Row>
        {b.additional_info && <Row label="Other notes">{b.additional_info}</Row>}
      </Group>

      <Group title="What you sell" onEdit={() => onEdit(1)}>
        <Row label="Categories">{values.categories.map((k) => label(config.categories, k)).join(', ')}</Row>
        {values.products.map((p) => {
          const t = types.find((x) => x.key === p.type);
          const permit = values.permits[p.type];
          return (
            <Row key={p.type} label={t?.label ?? p.type}>
              <span className="block">{p.items.join(', ')}</span>
              {permit && <span className="block text-earth-500">{PERMIT_TEXT[permit.status]}</span>}
            </Row>
          );
        })}
      </Group>

      <Group title="Your booth" onEdit={() => onEdit(2)}>
        <Row label="Rate">
          {bo.rate === 'seasonal' ? 'Seasonal' : bo.rate === 'daily' ? `Daily, ${label(config.frequencies, bo.frequency)}` : ''}
        </Row>
        {bo.rate === 'daily' && bo.months.length > 0 && <Row label="Months">{bo.months.map((m) => label(config.months, m)).join(', ')}</Row>}
        <Row label="Spaces">{bo.spaces}</Row>
        <Row label="Electricity">{bo.electric ? 'Yes' : 'No'}</Row>
        {bo.rate === 'seasonal' && <Row label="Pay in full">{bo.pay_in_full ? 'Yes' : 'No, installments'}</Row>}
        {bo.food_truck && <Row label="Format">Food truck or trailer</Row>}
        <Row label="Preferred stalls">{bo.stall_preference.length > 0 ? bo.stall_preference.map(stallLabel).join(', ') : 'No preference'}</Row>
        {total && <Row label="Total">{describeTotal(total)}</Row>}
        <Row label="Accepts">{values.payment_methods.map((m) => label(config.payment_methods, m)).join(', ')}</Row>
        <Row label="Own booth only">Confirmed</Row>
      </Group>

      <Group title="Insurance and agreements" onEdit={() => onEdit(3)}>
        <Row label="Insurance">{values.insurance.status ? INSURANCE_TEXT[values.insurance.status] : ''}</Row>
        {values.insurance.status === 'have' && values.insurance.certificate_name && <Row label="Certificate">{values.insurance.certificate_name}</Row>}
        {values.insurance.status === 'have' && values.insurance.carrier && <Row label="Carrier">{values.insurance.carrier}</Row>}
        {values.insurance.status === 'have' && values.insurance.expires_on && <Row label="Expires">{values.insurance.expires_on}</Row>}
        <Row label="Rules">
          Agreed{config.legal.rules_version ? `, version ${config.legal.rules_version}` : ''}
        </Row>
        <Row label="Acknowledged">Weekly market report, farm or facility visits, marketing use, products listed only</Row>
        <Row label="Signature">{values.signature_name}</Row>
      </Group>

      <NoteBox>
        After you submit you will be asked to pay the non-refundable {formatMoney(config.fees.application_fee, config.fees.currency)} application fee.
        SJCA reviews every application and will text you at {b.mobile}.
      </NoteBox>
    </div>
  );
}
