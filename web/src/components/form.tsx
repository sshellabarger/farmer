'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Generic form kit shared by the settings, market, producer, application and
 * staff screens. SectionCard / Field / TextArea / SelectField / SaveBar were
 * lifted verbatim from settings/page.tsx; the rest are Phase 2 additions.
 */

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4">{title}</h3>
      {children}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 disabled:bg-earth-50 disabled:text-earth-400"
      />
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 resize-none"
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 bg-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export function SaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <div className="flex justify-end pt-2 pb-8">
      <button
        onClick={onSave}
        disabled={saving}
        className="px-6 py-2.5 rounded-xl font-semibold text-sm text-white border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

/* ── Phase 2 additions ── */

export function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className={`flex items-start gap-2 text-sm text-earth-800 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[#21512C]"
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-earth-500">{hint}</span>}
      </span>
    </label>
  );
}

export function DateField(props: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  return <Field {...props} type="date" />;
}

export function TimeField(props: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  return <Field {...props} type="time" />;
}

/** Editable list of strings with add / remove. */
export function ListEditor({
  label,
  items,
  onChange,
  placeholder,
  disabled,
  hint,
  type = 'text',
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
  type?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft('');
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      {hint && <p className="text-xs text-earth-500 mb-2 mt-0">{hint}</p>}
      {items.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-wrap gap-2 mb-2">
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-earth-50 border border-earth-100 text-sm text-earth-800">
              <span>{item}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                  className="bg-transparent border-none cursor-pointer text-earth-400 hover:text-red-500 text-sm leading-none px-0.5"
                  aria-label={`Remove ${item}`}
                  title="Remove"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <input
            type={type}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            className="flex-1 px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
          />
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim()}
            className="px-3 py-2 rounded-xl text-sm font-semibold border border-earth-200 bg-white text-earth-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Two-click confirmation (the broadcast pattern): the first click arms the
 * button, the second within a few seconds performs the action.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  onConfirm,
  disabled,
  busy,
  danger = true,
  className = '',
}: {
  label: ReactNode;
  confirmLabel?: ReactNode;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const base = `px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`;
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        disabled={disabled || busy}
        className={base}
        style={danger ? { borderColor: '#fecaca', color: '#dc2626', background: '#fff' } : { borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={async () => {
          setArmed(false);
          await onConfirm();
        }}
        disabled={disabled || busy}
        className={base}
        style={{ borderColor: danger ? '#dc2626' : '#21512C', color: '#fff', background: danger ? '#dc2626' : '#21512C' }}
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border border-earth-200 bg-white text-earth-600"
      >
        Cancel
      </button>
    </span>
  );
}

/** Inline notice for errors and successes. */
export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    info: { bg: '#EBF1F8', color: '#1E3A5F', border: '#c7d7ea' },
    error: { bg: '#FEF2F2', color: '#B91C1C', border: '#fecaca' },
    success: { bg: '#D1FAE5', color: '#065F46', border: '#a7f3d0' },
    warning: { bg: '#FEF3C7', color: '#92400E', border: '#fde68a' },
  };
  const s = styles[kind];
  return (
    <div className="px-4 py-2.5 rounded-xl text-sm border" style={{ background: s.bg, color: s.color, borderColor: s.border }} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

/** Primary action button. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${small ? 'px-3 py-1.5 text-xs' : 'px-5 py-2.5 text-sm'} rounded-xl font-semibold text-white border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all`}
      style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
    >
      {children}
    </button>
  );
}

/** Secondary (outlined) action button. */
export function SecondaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${small ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} rounded-xl font-semibold border border-earth-200 bg-white text-earth-700 cursor-pointer hover:border-farm-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
    >
      {children}
    </button>
  );
}
