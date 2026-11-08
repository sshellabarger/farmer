'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AssignmentSource, BoothDoc } from '@/lib/phase4-types';
import { StatusChip } from './status-chip';

/**
 * Booth map pieces shared by the market's Booths card (edit mode) and the
 * Assignments panel on the market-date page (read mode with a select per
 * booth). Phase 4 contract section 4.2. The layout is data-driven: one column
 * per booth `row`, booths ordered by `order` (ascending = north to south,
 * north at the top). Nothing here names a market's stall list.
 */

/** Preferred left-to-right order of the WLRFM style rows; any other row label follows alphabetically. */
const PREFERRED_ROW_ORDER = ['west', 'center', 'east'];

export function orderRows(rows: string[]): string[] {
  const unique = Array.from(new Set(rows));
  const preferred = PREFERRED_ROW_ORDER.filter((r) => unique.includes(r));
  const rest = unique.filter((r) => !PREFERRED_ROW_ORDER.includes(r)).sort((a, b) => a.localeCompare(b));
  return [...preferred, ...rest];
}

export function groupBoothsByRow(booths: BoothDoc[]): { row: string; booths: BoothDoc[] }[] {
  const byRow = new Map<string, BoothDoc[]>();
  for (const b of booths) {
    const list = byRow.get(b.row) ?? [];
    list.push(b);
    byRow.set(b.row, list);
  }
  return orderRows(Array.from(byRow.keys())).map((row) => ({
    row,
    booths: [...(byRow.get(row) ?? [])].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
  }));
}

/** The column layout. `renderBooth` draws one booth cell. */
export function BoothGrid({
  booths,
  renderBooth,
  empty,
}: {
  booths: BoothDoc[];
  renderBooth: (booth: BoothDoc, index: number, rowBooths: BoothDoc[]) => ReactNode;
  empty?: ReactNode;
}) {
  const columns = groupBoothsByRow(booths);
  if (columns.length === 0) {
    return <div className="text-sm text-earth-400">{empty ?? 'No booths yet.'}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">North</div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`, minWidth: columns.length * 230 }}>
        {columns.map((col) => (
          <div key={col.row} className="min-w-0">
            <div className="text-xs font-semibold text-earth-600 capitalize mb-2 pb-1 border-b border-earth-100">{col.row}</div>
            <div className="space-y-2">{col.booths.map((b, i) => renderBooth(b, i, col.booths))}</div>
          </div>
        ))}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mt-1">South</div>
    </div>
  );
}

/* ─── Edit mode (market Booths card) ─── */

const cellInput =
  'w-full px-2 py-1 border border-earth-200 rounded-lg text-xs focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 disabled:bg-earth-50 disabled:text-earth-400';

function BoothEditCell({
  booth,
  canEdit,
  isFirst,
  isLast,
  busy,
  onPatch,
  onMove,
  onRetire,
}: {
  booth: BoothDoc;
  canEdit: boolean;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onPatch: (booth: BoothDoc, data: Partial<Pick<BoothDoc, 'label' | 'size' | 'notes' | 'power' | 'active'>>) => void;
  onMove: (direction: -1 | 1) => void;
  onRetire: (booth: BoothDoc) => void;
}) {
  const [label, setLabel] = useState(booth.label);
  const [size, setSize] = useState(booth.size);
  const [notes, setNotes] = useState(booth.notes);

  useEffect(() => {
    setLabel(booth.label);
    setSize(booth.size);
    setNotes(booth.notes);
  }, [booth]);

  const commit = () => {
    const data: Partial<Pick<BoothDoc, 'label' | 'size' | 'notes'>> = {};
    if (label.trim() && label.trim() !== booth.label) data.label = label.trim();
    if (size.trim() !== booth.size) data.size = size.trim();
    if (notes.trim() !== booth.notes) data.notes = notes.trim();
    if (Object.keys(data).length > 0) onPatch(booth, data);
  };

  return (
    <div className={`rounded-xl border border-earth-100 p-2.5 ${booth.active ? 'bg-white' : 'bg-earth-50 opacity-70'}`}>
      <div className="flex items-center gap-2 mb-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commit}
          disabled={!canEdit || busy}
          maxLength={12}
          aria-label={`Label for ${booth.label}`}
          className={`${cellInput} font-semibold w-20`}
        />
        {booth.kind === 'food_truck' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 whitespace-nowrap">food truck</span>}
        {!booth.active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-earth-100 text-earth-600">inactive</span>}
        {canEdit && (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={isFirst || busy}
              aria-label={`Move ${booth.label} north`}
              title="Move north"
              className="w-6 h-6 rounded border border-earth-200 bg-white text-xs cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ^
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={isLast || busy}
              aria-label={`Move ${booth.label} south`}
              title="Move south"
              className="w-6 h-6 rounded border border-earth-200 bg-white text-xs cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              v
            </button>
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={size} onChange={(e) => setSize(e.target.value)} onBlur={commit} disabled={!canEdit || busy} placeholder="Size" aria-label={`Size for ${booth.label}`} className={cellInput} />
        <input value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={commit} disabled={!canEdit || busy} placeholder="Notes" aria-label={`Notes for ${booth.label}`} className={cellInput} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <label className={`flex items-center gap-1.5 ${canEdit ? 'cursor-pointer' : ''}`}>
          <input
            type="checkbox"
            checked={booth.power}
            disabled={!canEdit || busy}
            onChange={(e) => onPatch(booth, { power: e.target.checked })}
            className="accent-[#21512C]"
          />
          Power
        </label>
        {canEdit &&
          (booth.active ? (
            <button
              type="button"
              onClick={() => onRetire(booth)}
              disabled={busy}
              className="bg-transparent border-none text-xs cursor-pointer text-red-600 hover:underline disabled:opacity-40 p-0"
            >
              Retire
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPatch(booth, { active: true })}
              disabled={busy}
              className="bg-transparent border-none text-xs cursor-pointer text-green-700 hover:underline disabled:opacity-40 p-0"
            >
              Reactivate
            </button>
          ))}
      </div>
    </div>
  );
}

export function BoothEditGrid({
  booths,
  canEdit,
  busyId,
  onPatch,
  onReorderRow,
  onRetire,
}: {
  booths: BoothDoc[];
  canEdit: boolean;
  busyId: string | null;
  onPatch: (booth: BoothDoc, data: Partial<Pick<BoothDoc, 'label' | 'size' | 'notes' | 'power' | 'active'>>) => void;
  /** The full new id order for one row. */
  onReorderRow: (row: string, boothIds: string[]) => void;
  onRetire: (booth: BoothDoc) => void;
}) {
  return (
    <BoothGrid
      booths={booths}
      empty="No booths yet. Add one below, or seed the map."
      renderBooth={(b, i, rowBooths) => (
        <BoothEditCell
          key={b.id}
          booth={b}
          canEdit={canEdit}
          isFirst={i === 0}
          isLast={i === rowBooths.length - 1}
          busy={busyId !== null}
          onPatch={onPatch}
          onRetire={onRetire}
          onMove={(direction) => {
            const ids = rowBooths.map((x) => x.id);
            const j = i + direction;
            if (j < 0 || j >= ids.length) return;
            [ids[i], ids[j]] = [ids[j], ids[i]];
            onReorderRow(b.row, ids);
          }}
        />
      )}
    />
  );
}

/* ─── Read mode with a select per booth (Assignments panel) ─── */

export interface AssignOption {
  producer_id: string;
  business_name: string;
  spaces: 1 | 2;
  /** The labels of the booths this vendor holds right now. */
  held: string[];
}

export function AssignGrid({
  booths,
  options,
  disabled,
  onSelect,
}: {
  booths: { booth: BoothDoc; assignment: { producer_id: string; business_name: string; source: AssignmentSource } | null }[];
  options: AssignOption[];
  disabled: boolean;
  /** `producerId` is '' to leave the booth empty. */
  onSelect: (booth: BoothDoc, producerId: string) => void;
}) {
  const byId = new Map(booths.map((b) => [b.booth.id, b]));
  return (
    <BoothGrid
      booths={booths.map((b) => b.booth)}
      renderBooth={(booth) => {
        const entry = byId.get(booth.id);
        const assignment = entry?.assignment ?? null;
        return (
          <div key={booth.id} className={`rounded-xl border p-2.5 ${assignment ? 'border-earth-100 bg-white' : 'border-dashed border-earth-200 bg-earth-15'}`}>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="font-bold text-sm text-earth-800">{booth.label}</span>
              {booth.power && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">power</span>}
              {booth.kind === 'food_truck' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">food truck</span>}
              {assignment && <StatusChip status={assignment.source} />}
            </div>
            <select
              value={assignment?.producer_id ?? ''}
              onChange={(e) => onSelect(booth, e.target.value)}
              disabled={disabled}
              aria-label={`Vendor for ${booth.label}`}
              className={`${cellInput} bg-white`}
            >
              <option value="">Unassigned</option>
              {options.map((o) => (
                <option key={o.producer_id} value={o.producer_id}>
                  {o.business_name}
                  {o.spaces === 2 ? ' (2 spaces)' : ''}
                  {o.held.length > 0 && o.producer_id !== assignment?.producer_id ? ` - now ${o.held.join(' + ')}` : ''}
                </option>
              ))}
            </select>
          </div>
        );
      }}
    />
  );
}
