'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';
import type { ApplyValues } from '@/lib/apply-draft';
import type { ApplicationConfig } from '@/lib/phase4-types';

/**
 * Small presentation kit shared by the public Phase 4 pages (/apply, /rules,
 * /agreement). Public pages never use the staff Header: no auth, no nav.
 */

/** What every /apply section component receives. */
export interface SectionProps {
  values: ApplyValues;
  update: (fn: (v: ApplyValues) => ApplyValues) => void;
  config: ApplicationConfig;
}

export function PublicShell({ children, width = 640 }: { children: ReactNode; width?: number }) {
  return (
    <div className="min-h-screen flex flex-col bg-bg font-sans">
      <div className="border-b border-border-light" style={{ background: 'rgba(250,248,244,0.9)' }}>
        <div className="mx-auto px-4 h-[56px] flex items-center gap-2.5" style={{ maxWidth: width }}>
          <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="SJCA Markets home">
            <div
              className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
            >
              <Icon name="leaf" size={16} className="text-white" />
            </div>
            <span className="font-display font-semibold text-[17px] text-text tracking-tight">SJCA Markets</span>
          </Link>
        </div>
      </div>
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto space-y-4" style={{ maxWidth: width }}>
          {children}
          <a
            href={smsHref('Hi SJCA Markets!')}
            className="mt-6 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl no-underline bg-green-50/70 border border-green-100 text-green-700 text-[13.5px] font-semibold"
          >
            <Icon name="msg" size={15} />
            Questions? Text {FARMLINK_NUMBER_DISPLAY}
          </a>
        </div>
      </main>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 ${className}`}>{children}</div>;
}

export function LoadingCard({ label = 'Loading...' }: { label?: string }) {
  return (
    <Card>
      <p className="text-sm text-earth-500 m-0" role="status">
        {label}
      </p>
    </Card>
  );
}

const INPUT_CLASS =
  'w-full px-3 py-2.5 border border-earth-200 rounded-xl text-[16px] bg-white focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-green-100';

export function Label({ htmlFor, children, required }: { htmlFor?: string; children: ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-earth-700 mb-1">
      {children}
      {required && <span className="text-red-500" aria-hidden="true"> *</span>}
    </label>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  inputMode,
  maxLength,
  placeholder,
  hint,
  required,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'url';
  maxLength?: number;
  placeholder?: string;
  hint?: ReactNode;
  required?: boolean;
  min?: number | string;
  max?: number | string;
}) {
  return (
    <div>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        min={min}
        max={max}
        className={INPUT_CLASS}
      />
      {hint && <p className="text-xs text-earth-500 mt-1 mb-0">{hint}</p>}
    </div>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  rows = 3,
  maxLength,
  placeholder,
  hint,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <textarea
        id={id}
        name={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className={`${INPUT_CLASS} resize-y`}
      />
      {hint && <p className="text-xs text-earth-500 mt-1 mb-0">{hint}</p>}
    </div>
  );
}

export function SelectInput({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <select id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A group of radio buttons rendered as large tappable rows. */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  required,
}: {
  legend: ReactNode;
  name: string;
  value: T | '';
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; hint?: ReactNode }[];
  required?: boolean;
}) {
  return (
    <fieldset className="border-0 p-0 m-0 min-w-0">
      <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">
        {legend}
        {required && <span className="text-red-500" aria-hidden="true"> *</span>}
      </legend>
      <div className="flex flex-col gap-2">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={`flex items-start gap-3 px-3 py-3 rounded-xl border cursor-pointer text-sm ${
                checked ? 'border-farm-500 bg-green-50/60' : 'border-earth-200 bg-white'
              }`}
              style={{ minHeight: 44 }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="mt-0.5 accent-[#21512C]"
              />
              <span className="text-earth-800">
                {o.label}
                {o.hint && <span className="block text-xs text-earth-500 mt-0.5">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A tappable checkbox row (44 px minimum height) for lists of options and acknowledgements. */
export function CheckRow({
  checked,
  onChange,
  children,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border text-sm ${
        checked ? 'border-farm-500 bg-green-50/60' : 'border-earth-200 bg-white'
      } ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
      style={{ minHeight: 44 }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[#21512C]"
      />
      <span className="text-earth-800">
        {children}
        {hint && <span className="block text-xs text-earth-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export function SectionHeading({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="font-display text-[22px] font-semibold text-green-800 m-0">{title}</h2>
      {intro && <p className="text-sm text-text-soft leading-relaxed mt-1.5 mb-0">{intro}</p>}
    </div>
  );
}

/** Bordered informational note (permit rules, fee notes). */
export function NoteBox({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <div
      className="rounded-xl border px-3 py-2.5 text-[13.5px] leading-relaxed"
      style={
        tone === 'warn'
          ? { background: '#FEF3C7', borderColor: '#fde68a', color: '#92400E' }
          : { background: '#F6F3EC', borderColor: '#DCD8CC', color: '#55524A' }
      }
    >
      {children}
    </div>
  );
}

/** The validation summary shown above a section's Continue button. */
export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div
      className="rounded-xl border px-4 py-3 text-sm"
      style={{ background: '#FEF2F2', borderColor: '#fecaca', color: '#B91C1C' }}
      role="alert"
      id="apply-errors"
    >
      <p className="m-0 font-semibold">{errors.length === 1 ? 'One thing to fix before you continue:' : 'A few things to fix before you continue:'}</p>
      <ul className="m-0 mt-1.5 pl-5 space-y-0.5">
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-green-700 underline">
      {children}
    </a>
  );
}
