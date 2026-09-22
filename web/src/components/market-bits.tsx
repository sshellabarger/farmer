'use client';

import { DAYS_OF_WEEK, type DayOfWeek, type GenerateResult } from '@/lib/types';

/** Short IANA list for the timezone select; America/Chicago is the default. */
export const TIMEZONE_OPTIONS = [
  { value: 'America/Chicago', label: 'Central — America/Chicago' },
  { value: 'America/New_York', label: 'Eastern — America/New_York' },
  { value: 'America/Denver', label: 'Mountain — America/Denver' },
  { value: 'America/Phoenix', label: 'Arizona — America/Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific — America/Los_Angeles' },
  { value: 'America/Anchorage', label: 'Alaska — America/Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Pacific/Honolulu' },
];

/** Weekday toggle row used by the market forms. */
export function WeekdayPicker({ value, onToggle }: { value: DayOfWeek[]; onToggle: (d: DayOfWeek) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {DAYS_OF_WEEK.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => onToggle(d)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer border capitalize"
            style={{
              background: on ? '#EBF4E6' : '#fff',
              borderColor: on ? '#2A5E33' : '#E4DFD3',
              color: on ? '#2A5E33' : '#5C5C5C',
            }}
            aria-pressed={on}
          >
            {d.slice(0, 3)}
          </button>
        );
      })}
    </div>
  );
}

/** The generator's counts after a schedule write or a manual regenerate. */
export function GenerationSummary({ result }: { result: GenerateResult }) {
  const cells: [string, number][] = [
    ['created', result.created], ['updated', result.updated], ['cancelled', result.cancelled],
    ['unchanged', result.unchanged], ['skipped', result.skipped], ['frozen', result.frozen],
  ];
  return (
    <div className="rounded-xl border border-earth-100 bg-earth-15 p-3">
      <div className="text-[11px] text-text-muted mb-2">Generated {result.from} → {result.to}</div>
      <div className="flex flex-wrap gap-3">
        {cells.map(([k, v]) => (
          <div key={k} className="text-center min-w-[64px]">
            <div className="font-mono text-lg font-bold" style={{ color: v > 0 ? '#2A5E33' : '#A6A398' }}>{v}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
