'use client';

import type { BoothRate, DailyFrequency } from '@/lib/phase4-types';
import { computeSeasonTotal, describeTotal, formatMoney } from '@/lib/fees';
import type { BoothValues } from '@/lib/apply-draft';
import { StallPicker } from '@/components/stall-picker';
import { CheckRow, Label, NoteBox, RadioGroup, SectionHeading, SelectInput, type SectionProps } from './kit';

/** Section 3: your booth. Map and stall picker, rate, spaces, electricity, live total, payment methods, own-booth statement. */
export function SectionBooth({ values, update, config }: SectionProps) {
  const bo = values.booth;
  const fees = config.fees;
  const count = config.season.market_count;
  const set = <K extends keyof BoothValues>(key: K, val: BoothValues[K]) =>
    update((v) => ({ ...v, booth: { ...v.booth, [key]: val } }));

  const total = bo.rate
    ? computeSeasonTotal(fees, { rate: bo.rate, spaces: bo.spaces, electric: bo.electric, pay_in_full: bo.rate === 'seasonal' && bo.pay_in_full }, count)
    : null;

  const toggleMonth = (key: string, on: boolean) =>
    set('months', on ? [...bo.months, key] : bo.months.filter((m) => m !== key));
  const toggleMethod = (key: string, on: boolean) =>
    update((v) => ({ ...v, payment_methods: on ? [...v.payment_methods, key] : v.payment_methods.filter((m) => m !== key) }));

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Your booth"
        intro={
          count > 0
            ? `The ${config.season.label} season has ${count} markets. Tell us how you would like to sell.`
            : `Tell us how you would like to sell in the ${config.season.label} season.`
        }
      />

      {config.market.booth_map_url && (
        <div>
          <Label>Market map</Label>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={config.market.booth_map_url}
            alt={`Map of the ${config.market.name} vendor stalls`}
            className="w-full rounded-xl border border-earth-100 bg-white"
          />
        </div>
      )}

      {config.stalls.length > 0 && (
        <div>
          <Label>Preferred stalls (optional)</Label>
          <p className="text-xs text-earth-500 mt-0 mb-2">
            Pick up to {config.limits.stall_preference_max} in order of preference. Booths are assigned by the market manager, and a preference
            is not a guarantee.
          </p>
          <StallPicker
            stalls={config.stalls}
            selected={bo.stall_preference}
            max={config.limits.stall_preference_max}
            onChange={(ids) => set('stall_preference', ids)}
          />
        </div>
      )}

      <RadioGroup<BoothRate>
        legend="Booth rate"
        name="rate"
        required
        value={bo.rate}
        onChange={(r) => update((v) => ({ ...v, booth: { ...v.booth, rate: r, pay_in_full: r === 'seasonal' ? v.booth.pay_in_full : false } }))}
        options={[
          {
            value: 'seasonal',
            label: 'Seasonal',
            hint: count > 0 ? `All ${count} markets, guaranteed weekly space` : 'Every market of the season, guaranteed weekly space',
          },
          { value: 'daily', label: 'Daily', hint: `${formatMoney(fees.daily, fees.currency)} per market` },
        ]}
      />

      {bo.rate === 'daily' && (
        <div className="space-y-3">
          <SelectInput
            id="frequency"
            label="How often do you expect to sell?"
            required
            value={bo.frequency}
            onChange={(f) => set('frequency', f as DailyFrequency | '')}
            placeholder="Choose one"
            options={config.frequencies.map((f) => ({ value: f.key, label: f.label }))}
          />
          <fieldset className="border-0 p-0 m-0 min-w-0">
            <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">Which months do you expect to attend?</legend>
            <div className="grid grid-cols-2 gap-2">
              {config.months.map((m) => (
                <CheckRow key={m.key} checked={bo.months.includes(m.key)} onChange={(on) => toggleMonth(m.key, on)}>
                  {m.label}
                </CheckRow>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <RadioGroup<'1' | '2'>
        legend="Number of spaces"
        name="spaces"
        value={String(bo.spaces) as '1' | '2'}
        onChange={(s) => set('spaces', s === '2' ? 2 : 1)}
        options={[
          { value: '1', label: 'One space' },
          { value: '2', label: 'Two spaces', hint: 'Two side-by-side spaces. Fees are per space.' },
        ]}
      />

      <CheckRow
        checked={bo.electric}
        onChange={(on) => set('electric', on)}
        hint={`${formatMoney(fees.electric_seasonal, fees.currency)} for the season, or ${formatMoney(fees.electric_daily, fees.currency)} per market at the daily rate.`}
      >
        I need electricity
      </CheckRow>

      <CheckRow checked={bo.food_truck} onChange={(on) => set('food_truck', on)}>
        I sell from a food truck or trailer
      </CheckRow>

      {bo.rate === 'seasonal' && (
        <CheckRow
          checked={bo.pay_in_full}
          onChange={(on) => set('pay_in_full', on)}
          hint={`Otherwise the season fee is paid in ${fees.seasonal_installments} installments.`}
        >
          I intend to pay the season fee in full on acceptance ({formatMoney(fees.seasonal_paid_in_full, fees.currency)} instead of{' '}
          {formatMoney(fees.seasonal_total, fees.currency)})
        </CheckRow>
      )}

      {total ? (
        <div className="rounded-2xl border border-green-100 bg-green-50/60 px-4 py-3" aria-live="polite">
          <p className="m-0 text-[12px] font-bold uppercase tracking-wider text-green-700">
            {total.basis === 'season' ? 'Season total' : 'Daily booth fee'}
          </p>
          <p className="m-0 mt-0.5 font-display text-[24px] font-semibold text-green-800">{describeTotal(total)}</p>
          <p className="m-0 mt-1 text-xs text-earth-600">
            Booth {formatMoney(total.booth_fee, total.currency)}
            {total.electric_fee > 0 && ` plus electricity ${formatMoney(total.electric_fee, total.currency)}`}. A non-refundable{' '}
            {formatMoney(fees.application_fee, fees.currency)} application fee is paid right after you submit. Booth fees are collected after your
            application is accepted, not now.
          </p>
        </div>
      ) : (
        <NoteBox>Choose a booth rate to see your total.</NoteBox>
      )}

      <fieldset className="border-0 p-0 m-0 min-w-0">
        <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">
          Payment methods you accept from customers<span className="text-red-500" aria-hidden="true"> *</span>
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {config.payment_methods.map((m) => (
            <CheckRow key={m.key} checked={values.payment_methods.includes(m.key)} onChange={(on) => toggleMethod(m.key, on)}>
              {m.label}
            </CheckRow>
          ))}
        </div>
      </fieldset>

      <CheckRow
        checked={values.acknowledgements.own_booth_only}
        onChange={(on) => update((v) => ({ ...v, acknowledgements: { ...v.acknowledgements, own_booth_only: on } }))}
      >
        <span className="font-semibold">Each vendor sells only what they grow, raise or produce, from their own booth.</span> Shared or
        cooperative retail booths are not permitted.
      </CheckRow>
    </div>
  );
}
