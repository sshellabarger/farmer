'use client';

import { useState } from 'react';
import { availableTypes, permitChoices, type ApplyValues } from '@/lib/apply-draft';
import type { PermitStatus, ProductEntry, ProductTypeConfig } from '@/lib/phase4-types';
import {
  CheckRow,
  ExternalLink,
  Label,
  NoteBox,
  RadioGroup,
  SectionHeading,
  TextAreaField,
  TextField,
  type SectionProps,
} from './kit';
import { UploadField } from './upload-field';

/** Section 2: what you sell. Categories, product types, and per type the items, practices, details and permit. */
export function SectionProducts({ values, update, config, draftId }: SectionProps & { draftId: string }) {
  const types = availableTypes(config, values.categories);
  const categories = [...config.categories].sort((a, b) => a.sort - b.sort);

  const toggleCategory = (key: string, on: boolean) =>
    update((v) => {
      const cats = on ? [...v.categories, key] : v.categories.filter((c) => c !== key);
      // Drop product types that no selected category offers any more.
      const keep = new Set(availableTypes(config, cats).map((t) => t.key));
      const products = v.products.filter((p) => keep.has(p.type));
      const permits = Object.fromEntries(Object.entries(v.permits).filter(([k]) => keep.has(k)));
      return { ...v, categories: cats, products, permits };
    });

  const toggleType = (key: string, on: boolean) =>
    update((v) => {
      if (on) {
        if (v.products.some((p) => p.type === key)) return v;
        const entry: ProductEntry = { type: key, items: [], practices: [], description: '', details: {} };
        return { ...v, products: [...v.products, entry] };
      }
      const permits = { ...v.permits };
      delete permits[key];
      return { ...v, products: v.products.filter((p) => p.type !== key), permits };
    });

  return (
    <div className="space-y-5">
      <SectionHeading title="What you sell" />

      <NoteBox>
        Vendors must grow, raise, or produce all the items they sell, and all items must be listed here. Items not listed are not approved for
        sale; mid-season additions need the market manager&apos;s approval.
      </NoteBox>

      <fieldset className="border-0 p-0 m-0 min-w-0">
        <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">
          Vendor categories<span className="text-red-500" aria-hidden="true"> *</span>
        </legend>
        <div className="flex flex-col gap-2">
          {categories.map((c) => (
            <CheckRow
              key={c.key}
              checked={values.categories.includes(c.key)}
              onChange={(on) => toggleCategory(c.key, on)}
              hint={c.description}
            >
              <span className="font-semibold">{c.label}</span>
              {c.events_only && <span className="ml-1.5 text-xs font-semibold text-accent-600">special events only</span>}
            </CheckRow>
          ))}
        </div>
      </fieldset>

      {values.categories.length > 0 && (
        <fieldset className="border-0 p-0 m-0 min-w-0">
          <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">
            What will you sell?<span className="text-red-500" aria-hidden="true"> *</span>
          </legend>
          <div className="flex flex-col gap-2">
            {types.map((t) => (
              <CheckRow
                key={t.key}
                checked={values.products.some((p) => p.type === t.key)}
                onChange={(on) => toggleType(t.key, on)}
                hint={t.examples || undefined}
              >
                <span className="font-semibold">{t.label}</span>
              </CheckRow>
            ))}
          </div>
        </fieldset>
      )}

      {values.products.map((entry) => {
        const t = types.find((x) => x.key === entry.type);
        if (!t) return null;
        return <ProductBlock key={t.key} type={t} entry={entry} values={values} update={update} config={config} draftId={draftId} />;
      })}
    </div>
  );
}

function ProductBlock({
  type: t,
  entry,
  values,
  update,
  config,
  draftId,
}: {
  type: ProductTypeConfig;
  entry: ProductEntry;
  values: ApplyValues;
  update: SectionProps['update'];
  config: SectionProps['config'];
  draftId: string;
}) {
  const patch = (fn: (e: ProductEntry) => ProductEntry) =>
    update((v) => ({ ...v, products: v.products.map((p) => (p.type === t.key ? fn(p) : p)) }));

  const setDetail = (key: string, val: string | number | boolean | undefined) =>
    patch((e) => {
      const details = { ...e.details };
      if (val === undefined || val === '' || val === false) delete details[key];
      else details[key] = val;
      return { ...e, details };
    });

  const permit = values.permits[t.key];
  const choices = permitChoices(t.permit_upload);
  const permitLabels: Record<PermitStatus, { label: string; hint?: string }> = {
    uploaded: { label: 'Upload my permit' },
    will_provide: { label: 'I will provide this permit before my first market' },
    not_required: { label: 'Not required' },
    food_freedom: { label: 'Food Freedom labeled only', hint: 'Everything I sell under this type is a properly labeled Food Freedom product.' },
  };
  const setPermit = (status: PermitStatus) =>
    update((v) => ({
      ...v,
      permits: {
        ...v.permits,
        [t.key]: { status, upload_id: status === 'uploaded' ? (v.permits[t.key]?.upload_id ?? null) : null, note: v.permits[t.key]?.note ?? '' },
      },
    }));

  const uploadedName = permit?.upload_id ? values.upload_names[permit.upload_id] ?? 'permit' : '';
  const showLinks = t.permit_upload !== 'none';

  return (
    <section className="rounded-2xl border border-earth-200 bg-earth-15 p-3 sm:p-4 space-y-4" aria-label={t.label}>
      <h3 className="font-display text-[17px] font-semibold text-green-800 m-0">{t.label}</h3>

      <ChipInput
        id={`items_${t.key}`}
        label="Items you sell (list every one)"
        items={entry.items}
        onChange={(items) => patch((e) => ({ ...e, items }))}
      />

      {t.practice_checklist.length > 0 && (
        <fieldset className="border-0 p-0 m-0 min-w-0">
          <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">Practices that apply to you</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {t.practice_checklist.map((p) => (
              <CheckRow
                key={p.key}
                checked={entry.practices.includes(p.key)}
                onChange={(on) =>
                  patch((e) => ({ ...e, practices: on ? [...e.practices, p.key] : e.practices.filter((k) => k !== p.key) }))
                }
              >
                {p.label}
              </CheckRow>
            ))}
          </div>
        </fieldset>
      )}

      <TextAreaField
        id={`desc_${t.key}`}
        label="Tell us more about these products"
        value={entry.description}
        onChange={(description) => patch((e) => ({ ...e, description }))}
        maxLength={2000}
      />

      {t.details.map((d) => {
        const val = entry.details[d.key];
        if (d.type === 'boolean') {
          return (
            <CheckRow key={d.key} checked={val === true} onChange={(on) => setDetail(d.key, on)} hint={d.hint || undefined}>
              {d.label}
            </CheckRow>
          );
        }
        return (
          <TextField
            key={d.key}
            id={`detail_${t.key}_${d.key}`}
            label={d.label}
            type={d.type === 'number' ? 'number' : 'text'}
            inputMode={d.type === 'number' ? 'numeric' : undefined}
            value={val === undefined ? '' : String(val)}
            onChange={(x) => setDetail(d.key, d.type === 'number' ? (x === '' ? undefined : Number(x)) : x)}
            maxLength={d.type === 'text' ? 500 : undefined}
            hint={d.hint || undefined}
            required={d.required}
          />
        );
      })}

      <div className="space-y-3">
        <NoteBox>
          <p className="m-0">{t.permit_rule}</p>
          {showLinks && (config.legal.adh_guidelines_url || config.legal.food_freedom_url) && (
            <p className="m-0 mt-1.5">
              {config.legal.adh_guidelines_url && <ExternalLink href={config.legal.adh_guidelines_url}>Arkansas Department of Health guidelines</ExternalLink>}
              {config.legal.adh_guidelines_url && config.legal.food_freedom_url && ' | '}
              {config.legal.food_freedom_url && <ExternalLink href={config.legal.food_freedom_url}>Food Freedom guide</ExternalLink>}
            </p>
          )}
        </NoteBox>

        {t.prohibited && (
          <p className="text-sm m-0 font-semibold" style={{ color: '#B91C1C' }}>
            Not allowed: {t.prohibited}
          </p>
        )}

        {choices.length > 0 && (
          <>
            <RadioGroup<PermitStatus>
              legend="Your permit"
              name={`permit_${t.key}`}
              required={t.permit_upload !== 'optional'}
              value={permit?.status ?? ''}
              onChange={setPermit}
              options={choices.map((c) => ({ value: c, label: permitLabels[c].label, hint: permitLabels[c].hint }))}
            />
            {permit?.status === 'uploaded' && (
              <UploadField
                id={`permit_file_${t.key}`}
                label="Permit file"
                kind="permit"
                marketId={config.market.id}
                draftId={draftId}
                limits={config.limits}
                value={permit.upload_id ? { upload_id: permit.upload_id, name: uploadedName } : null}
                onChange={(file) =>
                  update((v) => ({
                    ...v,
                    permits: { ...v.permits, [t.key]: { status: 'uploaded', upload_id: file ? file.upload_id : null, note: v.permits[t.key]?.note ?? '' } },
                    upload_names: file ? { ...v.upload_names, [file.upload_id]: file.name } : v.upload_names,
                  }))
                }
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Chips with an "Add item" box. Whatever is typed is added on Enter, on the button, and when the box loses focus. */
function ChipInput({ id, label, items, onChange }: { id: string; label: string; items: string[]; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const v = draft.trim().slice(0, 80);
    setDraft('');
    if (!v || items.some((i) => i.toLowerCase() === v.toLowerCase())) return;
    onChange([...items, v]);
  };

  return (
    <div>
      <Label htmlFor={id} required>
        {label}
      </Label>
      {items.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-wrap gap-2 mb-2">
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="flex items-center gap-1 pl-3 pr-1 rounded-full bg-white border border-earth-200 text-sm text-earth-800" style={{ minHeight: 36 }}>
              <span>{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="bg-transparent border-none cursor-pointer text-earth-500 text-base leading-none w-8 h-8"
                aria-label={`Remove ${item}`}
              >
                x
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          maxLength={80}
          placeholder="For example: heirloom tomatoes"
          className="flex-1 min-w-0 px-3 py-2.5 border border-earth-200 rounded-xl text-[16px] bg-white focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-green-100"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          disabled={!draft.trim()}
          className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-earth-200 bg-white text-earth-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add item
        </button>
      </div>
    </div>
  );
}
