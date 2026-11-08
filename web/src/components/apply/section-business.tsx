'use client';

import type { AgriculturalPractice } from '@/lib/phase4-types';
import type { BusinessValues } from '@/lib/apply-draft';
import { CheckRow, RadioGroup, SectionHeading, TextAreaField, TextField, type SectionProps } from './kit';

/** Section 1: you and your business. */
export function SectionBusiness({ values, update, config }: SectionProps) {
  const b = values.business;
  const set = <K extends keyof BusinessValues>(key: K, val: BusinessValues[K]) =>
    update((v) => ({ ...v, business: { ...v.business, [key]: val } }));

  return (
    <div className="space-y-4">
      <SectionHeading
        title="You and your business"
        intro={`Tell us who you are. This is your ${config.season.label} application for ${config.market.name}.`}
      />

      <RadioGroup
        legend="New vendor or returning?"
        name="is_returning"
        required
        value={b.is_returning === null ? '' : b.is_returning ? 'returning' : 'new'}
        onChange={(v) => set('is_returning', v === 'returning')}
        options={[
          { value: 'new', label: 'New vendor' },
          { value: 'returning', label: 'Returning vendor' },
        ]}
      />
      {b.is_returning === true && (
        <TextField
          id="last_stall"
          label="Which stall were you in last season?"
          value={b.last_stall}
          onChange={(x) => set('last_stall', x)}
          maxLength={12}
          placeholder="For example V7"
          hint="Leave blank if you were not in a regular stall."
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField id="name" label="Your name" value={b.name} onChange={(x) => set('name', x)} autoComplete="name" maxLength={120} required />
        <TextField
          id="business_name"
          label="Business or farm name"
          value={b.business_name}
          onChange={(x) => set('business_name', x)}
          autoComplete="organization"
          maxLength={200}
          required
        />
        <TextField
          id="email"
          label="Email"
          type="email"
          value={b.email}
          onChange={(x) => set('email', x)}
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          required
        />
        <TextField
          id="mobile"
          label="Mobile number for market texts"
          type="tel"
          value={b.mobile}
          onChange={(x) => set('mobile', x)}
          autoComplete="tel"
          inputMode="tel"
          maxLength={20}
          placeholder="(501) 555-0100"
          required
        />
      </div>

      <CheckRow checked={b.sms_consent} onChange={(c) => set('sms_consent', c)}>
        {config.legal.sms_consent_text}
      </CheckRow>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField id="website" label="Website" type="url" value={b.website} onChange={(x) => set('website', x)} inputMode="url" maxLength={300} placeholder="https://" />
        <TextField id="social" label="Social media" value={b.social} onChange={(x) => set('social', x)} maxLength={300} placeholder="@yourfarm or a page link" />
      </div>

      <fieldset className="border-0 p-0 m-0 min-w-0">
        <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">Business address</legend>
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
          <div className="sm:col-span-6">
            <TextField id="street" label="Street" value={b.street} onChange={(x) => set('street', x)} autoComplete="address-line1" maxLength={200} required />
          </div>
          <div className="sm:col-span-3">
            <TextField id="city" label="City" value={b.city} onChange={(x) => set('city', x)} autoComplete="address-level2" maxLength={100} required />
          </div>
          <div className="sm:col-span-1">
            <TextField id="state" label="State" value={b.state} onChange={(x) => set('state', x)} autoComplete="address-level1" maxLength={40} required />
          </div>
          <div className="sm:col-span-2">
            <TextField id="zip" label="ZIP" value={b.zip} onChange={(x) => set('zip', x)} autoComplete="postal-code" inputMode="numeric" maxLength={12} required />
          </div>
        </div>
      </fieldset>

      <TextAreaField
        id="description"
        label="Describe your business"
        value={b.description}
        onChange={(x) => set('description', x)}
        rows={4}
        maxLength={3000}
        hint="A few sentences about your farm or business. We may use this to introduce you to shoppers."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField
          id="years_in_operation"
          label="Years in operation"
          type="number"
          inputMode="numeric"
          value={b.years_in_operation}
          onChange={(x) => set('years_in_operation', x)}
          min={0}
          max={150}
        />
        <TextField
          id="outlets"
          label="Where else do you sell?"
          value={b.outlets}
          onChange={(x) => set('outlets', x)}
          maxLength={1000}
          placeholder="Farm stand, other markets, wholesale"
        />
      </div>

      <RadioGroup<AgriculturalPractice>
        legend="Growing practices"
        name="agricultural_practices"
        required
        value={b.agricultural_practices}
        onChange={(x) => set('agricultural_practices', x)}
        options={config.agricultural_practices.map((o) => ({ value: o.key as AgriculturalPractice, label: o.label }))}
      />

      <TextAreaField
        id="additional_info"
        label="Anything else we should know?"
        value={b.additional_info}
        onChange={(x) => set('additional_info', x)}
        maxLength={3000}
      />
    </div>
  );
}
