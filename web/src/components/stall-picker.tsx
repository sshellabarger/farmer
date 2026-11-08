'use client';

import type { StallPublic } from '@/lib/phase4-types';

/**
 * Cosmetic left-to-right ordering of stall rows. Rows are free labels set by
 * the admin; compass words get a natural map position, anything else keeps
 * alphabetical order in the middle. No stall list is hard-coded here.
 */
const ROW_RANK: Record<string, number> = { west: 0, 'north-west': 0, northwest: 0, center: 1, centre: 1, middle: 1, east: 2, 'north-east': 2, northeast: 2 };

function rowRank(row: string): number {
  return ROW_RANK[row.trim().toLowerCase()] ?? 1;
}

interface Column {
  row: string;
  stalls: StallPublic[];
  truck: boolean;
}

function buildColumns(stalls: StallPublic[]): Column[] {
  const byRow = new Map<string, StallPublic[]>();
  for (const s of stalls) {
    const list = byRow.get(s.row) ?? [];
    list.push(s);
    byRow.set(s.row, list);
  }
  const all: Column[] = [...byRow.entries()].map(([row, list]) => ({
    row,
    stalls: [...list].sort((a, b) => a.order - b.order),
    truck: list.every((s) => s.kind === 'food_truck'),
  }));
  const stallCols = all.filter((c) => !c.truck).sort((a, b) => rowRank(a.row) - rowRank(b.row) || a.row.localeCompare(b.row));
  const truckCols = all.filter((c) => c.truck);
  // Food truck slots sit between the rows of stalls.
  const mid = Math.ceil(stallCols.length / 2);
  return [...stallCols.slice(0, mid), ...truckCols, ...stallCols.slice(mid)];
}

/**
 * Pick up to `max` preferred stalls, in order. Rows are columns with north at
 * the top (booths are listed in ascending `order`); powered stalls are
 * marked; stalls a current vendor usually takes are greyed but still
 * selectable. Each stall is a 44 px+ tap target.
 */
export function StallPicker({
  stalls,
  selected,
  max,
  onChange,
}: {
  stalls: StallPublic[];
  selected: string[];
  max: number;
  onChange: (ids: string[]) => void;
}) {
  if (stalls.length === 0) return null;
  const columns = buildColumns(stalls);
  const byId = new Map(stalls.map((s) => [s.id, s]));
  const full = selected.length >= max;

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (!full) onChange([...selected, id]);
  };

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-earth-500 mb-1.5">
        <span>North</span>
        <span>
          {selected.length} of {max} chosen
        </span>
      </div>
      <div
        className="grid gap-2 rounded-xl border border-earth-100 bg-earth-25 p-2"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        role="group"
        aria-label="Choose your preferred stalls"
      >
        {columns.map((col) => (
          <div key={col.row} className="flex flex-col gap-1.5 min-w-0">
            {col.stalls.map((s) => {
              const pick = selected.indexOf(s.id);
              const isPicked = pick >= 0;
              const blocked = !isPicked && full;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  disabled={blocked}
                  aria-pressed={isPicked}
                  aria-label={`${s.label}${s.power ? ', has power' : ''}${s.usually_taken ? ', usually taken' : ''}${isPicked ? `, choice ${pick + 1}` : ''}`}
                  className={`relative rounded-lg border text-left px-2 py-1.5 cursor-pointer disabled:cursor-not-allowed ${
                    isPicked ? 'border-farm-500 bg-green-50 text-green-800' : 'border-earth-200 bg-white text-earth-800'
                  } ${s.usually_taken && !isPicked ? 'opacity-55' : ''} ${blocked ? 'opacity-40' : ''}`}
                  style={{ minHeight: 48 }}
                >
                  <span className="block text-[14px] font-bold leading-tight">{s.label}</span>
                  <span className="block text-[10.5px] leading-tight text-earth-500">
                    {s.kind === 'food_truck' ? 'food truck' : s.usually_taken ? 'usually taken' : s.power ? 'power' : ' '}
                  </span>
                  {s.power && s.usually_taken && s.kind !== 'food_truck' && (
                    <span className="block text-[10.5px] leading-tight text-earth-500">power</span>
                  )}
                  {isPicked && (
                    <span
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-white text-[11px] font-bold flex items-center justify-center"
                      style={{ background: '#21512C' }}
                      aria-hidden="true"
                    >
                      {pick + 1}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-earth-500 mt-1.5">
        <span>South</span>
        <span className="capitalize">{columns.map((c) => c.row).join(' / ')}</span>
      </div>
      {selected.length > 0 && (
        <p className="text-sm text-earth-700 mt-2 mb-0">
          Your picks, in order:{' '}
          {selected.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              {i + 1}. {byId.get(id)?.label ?? id}
            </span>
          ))}
          {'. '}
          <button type="button" onClick={() => onChange([])} className="bg-transparent border-none cursor-pointer text-earth-600 underline text-sm p-0">
            Clear
          </button>
        </p>
      )}
    </div>
  );
}
