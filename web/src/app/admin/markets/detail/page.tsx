'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  DAYS_OF_WEEK,
  type DayOfWeek,
  type ExtraQuestion,
  type GenerateResult,
  type Market,
  type MarketDate,
  type ScheduleVersionInput,
  type SkippedDate,
  type SpecialDate,
} from '@/lib/types';
import { canAccessMarket, useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import {
  CheckboxField,
  ConfirmButton,
  DateField,
  Field,
  ListEditor,
  Notice,
  PrimaryButton,
  SaveBar,
  SecondaryButton,
  SelectField,
  TimeField,
} from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatDateLabel, formatStamp, formatTime12h, weekdayLabel } from '@/components/admin-shell';
import { GenerationSummary, TIMEZONE_OPTIONS, WeekdayPicker } from '@/components/market-bits';

export default function MarketDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MarketDetail />
    </Suspense>
  );
}

function MarketDetail() {
  const { ready, isAdmin, user } = useStaffGuard();
  const params = useSearchParams();
  const id = params.get('id') || '';

  const [market, setMarket] = useState<Market | null>(null);
  const [dates, setDates] = useState<MarketDate[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState<GenerateResult | null>(null);
  const [flash, setFlash] = useState('');

  const reload = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const [m, d] = await Promise.all([api.getMarket(id), api.getMarketDates(id)]);
      setMarket(m.market);
      setDates([...(d.dates || [])].sort((a, b) => a.date.localeCompare(b.date)));
    } catch (err: any) {
      setError(err?.message || 'Could not load the market');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ready) reload();
  }, [ready, reload]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 3000);
  };

  /** Run a write, then re-fetch the market and its dates. */
  const runWrite = async (fn: () => Promise<unknown>, okMsg = 'Saved') => {
    setError('');
    try {
      const res = (await fn()) as { generation?: GenerateResult } | undefined;
      if (res && typeof res === 'object' && res.generation) setGeneration(res.generation);
      await reload();
      flashMsg(okMsg);
      return true;
    } catch (err: any) {
      setError(err?.message || 'The change did not save');
      return false;
    }
  };

  if (!ready) return <LoadingScreen />;
  if (!id) {
    return (
      <AdminShell title="Market">
        <Notice kind="error">No market id in the URL. <Link href="/admin/markets" className="font-semibold">Back to markets</Link></Notice>
      </AdminShell>
    );
  }
  if (loading && !market) return <LoadingScreen label="Loading market…" />;
  if (!market) {
    return (
      <AdminShell title="Market">
        <Notice kind="error">{error || 'Market not found.'} <Link href="/admin/markets" className="font-semibold">Back to markets</Link></Notice>
      </AdminShell>
    );
  }

  const canEditDates = canAccessMarket(user, market.id);

  return (
    <AdminShell
      title={market.name}
      subtitle={<><span className="font-mono">{market.slug}</span> · {market.timezone} · <Link href="/admin/markets" className="text-green-700">All markets</Link></>}
      actions={
        <>
          {!market.active && <StatusChip status="inactive" />}
          <Link href={`/admin/producers?market_id=${encodeURIComponent(market.id)}`} className="px-3 py-1.5 rounded-lg text-xs font-semibold no-underline border" style={{ borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}>
            Producers
          </Link>
        </>
      }
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {flash && <div className="mb-4"><Notice kind="success">{flash}</Notice></div>}
      {!isAdmin && (
        <div className="mb-4"><Notice kind="info">Market settings and schedules are edited by SJCA administrators. You can cancel or restore dates and edit their extra questions.</Notice></div>
      )}

      <div className="space-y-6">
        <SettingsSection market={market} readOnly={!isAdmin} onSave={(data) => runWrite(() => api.updateMarket(market.id, data), 'Settings saved')} />
        <WorkflowSection market={market} readOnly={!isAdmin} onSave={(data) => runWrite(() => api.updateMarket(market.id, data), 'Workflow saved')} />
        <QuietHoursSection market={market} readOnly={!isAdmin} onSave={(data) => runWrite(() => api.updateMarket(market.id, data), 'Quiet hours saved')} />
        <VersionsSection
          market={market}
          readOnly={!isAdmin}
          onAdd={(v) => runWrite(() => api.addScheduleVersion(market.id, v), 'Schedule version added')}
          onDelete={(vid) => runWrite(() => api.deleteScheduleVersion(market.id, vid), 'Schedule version deleted')}
        />
        <SkippedSection market={market} readOnly={!isAdmin} onSave={(list) => runWrite(() => api.setSkippedDates(market.id, list), 'Skipped dates saved')} />
        <SpecialSection market={market} readOnly={!isAdmin} onSave={(list) => runWrite(() => api.setSpecialDates(market.id, list), 'Special dates saved')} />
        <RegenerateSection
          readOnly={!isAdmin}
          generation={generation}
          onGenerate={(scope) => runWrite(() => api.generateDates(market.id, scope), `Dates regenerated (${scope})`)}
        />
        <DatesSection
          market={market}
          dates={dates}
          canEdit={canEditDates}
          onPatch={(dateId, data, msg) => runWrite(() => api.updateMarketDate(market.id, dateId, data), msg)}
        />
      </div>
    </AdminShell>
  );
}

/* ─── Sections ─── */

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-base font-bold text-earth-800 m-0">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

function SettingsSection({ market, readOnly, onSave }: { market: Market; readOnly: boolean; onSave: (d: Parameters<typeof api.updateMarket>[1]) => Promise<boolean> }) {
  const [name, setName] = useState(market.name);
  const [locName, setLocName] = useState(market.location?.name || '');
  const [locAddress, setLocAddress] = useState(market.location?.address || '');
  const [timezone, setTimezone] = useState(market.timezone);
  const [active, setActive] = useState(market.active);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(market.name);
    setLocName(market.location?.name || '');
    setLocAddress(market.location?.address || '');
    setTimezone(market.timezone);
    setActive(market.active);
  }, [market]);

  const tzOptions = TIMEZONE_OPTIONS.some((o) => o.value === timezone)
    ? TIMEZONE_OPTIONS
    : [{ value: timezone, label: timezone }, ...TIMEZONE_OPTIONS];

  const save = async () => {
    setSaving(true);
    await onSave({ name: name.trim(), location: { name: locName.trim(), address: locAddress.trim() }, timezone, active });
    setSaving(false);
  };

  return (
    <Card title="Settings">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" value={name} onChange={setName} disabled={readOnly} />
        <Field label="Slug" value={market.slug} disabled />
        <Field label="Location name" value={locName} onChange={setLocName} disabled={readOnly} />
        <Field label="Address" value={locAddress} onChange={setLocAddress} disabled={readOnly} />
        {readOnly ? (
          <Field label="Timezone" value={timezone} disabled />
        ) : (
          <SelectField label="Timezone" value={timezone} onChange={setTimezone} options={tzOptions} />
        )}
        <div className="flex items-end pb-2">
          <CheckboxField label="Active" hint="Inactive markets are hidden from the application form and get no new dates." checked={active} onChange={setActive} disabled={readOnly} />
        </div>
      </div>
      <p className="text-xs text-earth-500 mt-3 mb-0">Changing the timezone re-times every undecided future date.</p>
      {!readOnly && <SaveBar saving={saving} onSave={save} />}
    </Card>
  );
}

function WorkflowSection({ market, readOnly, onSave }: { market: Market; readOnly: boolean; onSave: (d: Parameters<typeof api.updateMarket>[1]) => Promise<boolean> }) {
  const wf = market.workflow;
  const [checkin, setCheckin] = useState(String(wf.checkin_offset_min));
  const [deadline, setDeadline] = useState(String(wf.deadline_offset_min));
  const [drafts, setDrafts] = useState(String(wf.drafts_offset_min));
  const [reminders, setReminders] = useState<string[]>(wf.reminder_offsets_min.map(String));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setCheckin(String(market.workflow.checkin_offset_min));
    setDeadline(String(market.workflow.deadline_offset_min));
    setDrafts(String(market.workflow.drafts_offset_min));
    setReminders(market.workflow.reminder_offsets_min.map(String));
  }, [market]);

  const save = async () => {
    setLocalError('');
    const nums = [checkin, deadline, drafts, ...reminders].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      setLocalError('Every offset must be a non-negative number of minutes.');
      return;
    }
    setSaving(true);
    await onSave({
      workflow: {
        checkin_offset_min: Number(checkin),
        reminder_offsets_min: reminders.map(Number).sort((a, b) => a - b),
        deadline_offset_min: Number(deadline),
        drafts_offset_min: Number(drafts),
      },
    });
    setSaving(false);
  };

  return (
    <Card title="Workflow offsets (minutes after the market closes)">
      {localError && <div className="mb-3"><Notice kind="error">{localError}</Notice></div>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Check-in text" type="number" value={checkin} onChange={setCheckin} disabled={readOnly} />
        <Field label="Check-in deadline" type="number" value={deadline} onChange={setDeadline} disabled={readOnly} />
        <Field label="Drafts generated" type="number" value={drafts} onChange={setDrafts} disabled={readOnly} />
      </div>
      <div className="mt-3">
        <ListEditor
          label="Reminder offsets"
          hint="One reminder text per entry, in minutes after close (1440 = one day)."
          items={reminders}
          onChange={setReminders}
          placeholder="1440"
          type="number"
          disabled={readOnly}
        />
      </div>
      {!readOnly && <SaveBar saving={saving} onSave={save} />}
    </Card>
  );
}

function QuietHoursSection({ market, readOnly, onSave }: { market: Market; readOnly: boolean; onSave: (d: Parameters<typeof api.updateMarket>[1]) => Promise<boolean> }) {
  const [start, setStart] = useState(market.quiet_hours.start);
  const [end, setEnd] = useState(market.quiet_hours.end);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStart(market.quiet_hours.start);
    setEnd(market.quiet_hours.end);
  }, [market]);

  const save = async () => {
    setSaving(true);
    await onSave({ quiet_hours: { start, end } });
    setSaving(false);
  };

  return (
    <Card title="Quiet hours (no texts go out)">
      <div className="grid grid-cols-2 gap-3 max-w-[360px]">
        <TimeField label="From" value={start} onChange={setStart} disabled={readOnly} />
        <TimeField label="Until" value={end} onChange={setEnd} disabled={readOnly} />
      </div>
      <p className="text-xs text-earth-500 mt-2 mb-0">Market-local time. A window that ends before it starts wraps past midnight.</p>
      {!readOnly && <SaveBar saving={saving} onSave={save} />}
    </Card>
  );
}

function VersionsSection({
  market,
  readOnly,
  onAdd,
  onDelete,
}: {
  market: Market;
  readOnly: boolean;
  onAdd: (v: ScheduleVersionInput) => Promise<boolean>;
  onDelete: (versionId: string) => Promise<boolean>;
}) {
  const versions = [...market.schedule.versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const [showAdd, setShowAdd] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [seasonStart, setSeasonStart] = useState('');
  const [seasonEnd, setSeasonEnd] = useState('');
  const [days, setDays] = useState<DayOfWeek[]>([]);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('12:00');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggleDay = (d: DayOfWeek) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const canAdd = effectiveFrom && seasonStart && seasonEnd && days.length > 0 && startTime && endTime;

  const add = async () => {
    setSaving(true);
    const ok = await onAdd({
      effective_from: effectiveFrom,
      season_start: seasonStart,
      season_end: seasonEnd,
      days_of_week: DAYS_OF_WEEK.filter((d) => days.includes(d)),
      start_time: startTime,
      end_time: endTime,
    });
    setSaving(false);
    if (ok) {
      setShowAdd(false);
      setEffectiveFrom(''); setSeasonStart(''); setSeasonEnd(''); setDays([]);
    }
  };

  return (
    <Card
      title="Schedule versions"
      aside={!readOnly && <SecondaryButton small onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Cancel' : '+ Add version'}</SecondaryButton>}
    >
      <p className="text-xs text-earth-500 mt-0 mb-3">
        Each date uses the latest version whose &ldquo;effective from&rdquo; is on or before it. Adding a version only changes undecided future dates.
      </p>
      <TableCard minWidth={640}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Effective from</Th>
            <Th>Season</Th>
            <Th>Days</Th>
            <Th>Hours</Th>
            <Th>Added</Th>
            {!readOnly && <Th />}
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-b border-border-light last:border-none">
              <Td>{formatDateLabel(v.effective_from)}</Td>
              <Td>{formatDateLabel(v.season_start)} – {formatDateLabel(v.season_end)}</Td>
              <Td className="capitalize">{v.days_of_week.map((d) => d.slice(0, 3)).join(', ')}</Td>
              <Td>{formatTime12h(v.start_time)}–{formatTime12h(v.end_time)}</Td>
              <Td><span className="text-[12px] text-text-muted">{formatStamp(v.created_at)} · {v.created_by}</span></Td>
              {!readOnly && (
                <Td className="text-right">
                  <ConfirmButton
                    label="Delete"
                    confirmLabel="Delete version"
                    disabled={versions.length <= 1}
                    busy={busyId === v.id}
                    onConfirm={async () => {
                      setBusyId(v.id);
                      await onDelete(v.id);
                      setBusyId(null);
                    }}
                  />
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </TableCard>
      {versions.length <= 1 && !readOnly && <p className="text-xs text-earth-500 mt-2 mb-0">The last remaining version cannot be deleted.</p>}

      {showAdd && !readOnly && (
        <div className="mt-4 p-4 rounded-xl bg-earth-15 border border-earth-100 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <DateField label="Effective from" value={effectiveFrom} onChange={setEffectiveFrom} />
            <DateField label="Season start" value={seasonStart} onChange={setSeasonStart} />
            <DateField label="Season end" value={seasonEnd} onChange={setSeasonEnd} />
            <TimeField label="Start time" value={startTime} onChange={setStartTime} />
            <TimeField label="End time" value={endTime} onChange={setEndTime} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-earth-500 mb-1">Market days</label>
            <WeekdayPicker value={days} onToggle={toggleDay} />
          </div>
          <div className="flex justify-end">
            <PrimaryButton small onClick={add} disabled={saving || !canAdd}>{saving ? 'Adding…' : 'Add version'}</PrimaryButton>
          </div>
        </div>
      )}
    </Card>
  );
}

function SkippedSection({ market, readOnly, onSave }: { market: Market; readOnly: boolean; onSave: (list: SkippedDate[]) => Promise<boolean> }) {
  const [list, setList] = useState<SkippedDate[]>(market.schedule.skipped_dates || []);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setList(market.schedule.skipped_dates || []);
    setDirty(false);
  }, [market]);

  const add = () => {
    if (!date || !reason.trim() || list.some((s) => s.date === date)) return;
    setList([...list, { date, reason: reason.trim() }].sort((a, b) => a.date.localeCompare(b.date)));
    setDate(''); setReason(''); setDirty(true);
  };

  const remove = (d: string) => {
    setList(list.filter((s) => s.date !== d));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    await onSave(list);
    setSaving(false);
  };

  return (
    <Card title="Skipped dates">
      <p className="text-xs text-earth-500 mt-0 mb-3">A skipped day is cancelled by the generator (unless it is already decided) and revived when un-skipped.</p>
      {list.length === 0 ? (
        <p className="text-sm text-earth-400 m-0">No skipped dates.</p>
      ) : (
        <ul className="m-0 p-0 list-none space-y-1.5">
          {list.map((s) => (
            <li key={s.date} className="flex items-center gap-3 text-sm">
              <span className="font-mono text-[13px]">{s.date}</span>
              <span className="text-text-soft flex-1">{s.reason}</span>
              {!readOnly && (
                <button type="button" onClick={() => remove(s.date)} className="bg-transparent border-none cursor-pointer text-earth-400 hover:text-red-500 text-sm" aria-label={`Remove ${s.date}`}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-[180px_1fr_auto] gap-2 items-end">
            <DateField label="Date" value={date} onChange={setDate} />
            <Field label="Reason" value={reason} onChange={setReason} placeholder="Holiday" />
            <SecondaryButton onClick={add} disabled={!date || !reason.trim()}>Add</SecondaryButton>
          </div>
          <div className="flex justify-end pt-3">
            <PrimaryButton onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save skipped dates'}</PrimaryButton>
          </div>
        </>
      )}
    </Card>
  );
}

function SpecialSection({ market, readOnly, onSave }: { market: Market; readOnly: boolean; onSave: (list: SpecialDate[]) => Promise<boolean> }) {
  const [list, setList] = useState<SpecialDate[]>(market.schedule.special_dates || []);
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('14:00');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setList(market.schedule.special_dates || []);
    setDirty(false);
  }, [market]);

  const add = () => {
    if (!date || !start || !end || list.some((s) => s.date === date)) return;
    setList([...list, { date, start_time: start, end_time: end, note: note.trim() }].sort((a, b) => a.date.localeCompare(b.date)));
    setDate(''); setNote(''); setDirty(true);
  };

  const remove = (d: string) => {
    setList(list.filter((s) => s.date !== d));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    await onSave(list);
    setSaving(false);
  };

  return (
    <Card title="Special dates">
      <p className="text-xs text-earth-500 mt-0 mb-3">A special date is a market day even outside the season or on a different weekday. Its own hours apply.</p>
      {list.length === 0 ? (
        <p className="text-sm text-earth-400 m-0">No special dates.</p>
      ) : (
        <ul className="m-0 p-0 list-none space-y-1.5">
          {list.map((s) => (
            <li key={s.date} className="flex items-center gap-3 text-sm">
              <span className="font-mono text-[13px]">{s.date}</span>
              <span className="text-text-soft">{formatTime12h(s.start_time)}–{formatTime12h(s.end_time)}</span>
              <span className="text-text-soft flex-1">{s.note}</span>
              {!readOnly && (
                <button type="button" onClick={() => remove(s.date)} className="bg-transparent border-none cursor-pointer text-earth-400 hover:text-red-500 text-sm" aria-label={`Remove ${s.date}`}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-[170px_120px_120px_1fr_auto] gap-2 items-end">
            <DateField label="Date" value={date} onChange={setDate} />
            <TimeField label="Start" value={start} onChange={setStart} />
            <TimeField label="End" value={end} onChange={setEnd} />
            <Field label="Note" value={note} onChange={setNote} placeholder="Holiday market" />
            <SecondaryButton onClick={add} disabled={!date || !start || !end}>Add</SecondaryButton>
          </div>
          <div className="flex justify-end pt-3">
            <PrimaryButton onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save special dates'}</PrimaryButton>
          </div>
        </>
      )}
    </Card>
  );
}

function RegenerateSection({
  readOnly,
  generation,
  onGenerate,
}: {
  readOnly: boolean;
  generation: GenerateResult | null;
  onGenerate: (scope: 'window' | 'season') => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<'window' | 'season' | null>(null);

  const run = async (scope: 'window' | 'season') => {
    setBusy(scope);
    await onGenerate(scope);
    setBusy(null);
  };

  return (
    <Card title="Regenerate dates">
      <p className="text-xs text-earth-500 mt-0 mb-3">
        Runs the generator by hand. <strong>Window</strong> covers the next eight weeks (what the nightly job does); <strong>Season</strong> covers every version&rsquo;s whole season. Decided dates are never touched.
      </p>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={() => run('window')} disabled={busy !== null}>{busy === 'window' ? 'Generating…' : 'Regenerate window'}</SecondaryButton>
          <SecondaryButton onClick={() => run('season')} disabled={busy !== null}>{busy === 'season' ? 'Generating…' : 'Regenerate season'}</SecondaryButton>
        </div>
      )}
      {generation && <div className="mt-3"><GenerationSummary result={generation} /></div>}
    </Card>
  );
}

/* ─── Dates table ─── */

function DatesSection({
  market,
  dates,
  canEdit,
  onPatch,
}: {
  market: Market;
  dates: MarketDate[];
  canEdit: boolean;
  onPatch: (dateId: string, data: Parameters<typeof api.updateMarketDate>[2], msg: string) => Promise<boolean>;
}) {
  const [statusFilter, setStatusFilter] = useState('');
  const [showPast, setShowPast] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const now = Date.now();
  const versionLabel = (d: MarketDate) => {
    if (d.schedule_version === 'special') return 'special';
    const idx = [...market.schedule.versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).findIndex((v) => v.id === d.schedule_version);
    return idx >= 0 ? `v${idx + 1}` : d.schedule_version.slice(0, 8);
  };

  const visible = dates.filter((d) => {
    if (statusFilter && d.status !== statusFilter) return false;
    if (!showPast && Date.parse(d.end_at) < now) return false;
    return true;
  });

  const hasActions = (d: MarketDate) =>
    !!(d.actions?.checkin_sent_at || d.actions?.deadline_processed_at || d.actions?.drafts_generated_at || d.actions?.approved_at || d.actions?.booth_texts_sent_at || (d.actions?.reminders_sent?.length ?? 0) > 0);

  const cancel = async (d: MarketDate) => {
    if (!reason.trim()) return;
    setBusy(d.id);
    const ok = await onPatch(d.id, { status: 'cancelled', cancellation_reason: reason.trim() }, `${formatDateLabel(d.date)} cancelled`);
    setBusy(null);
    if (ok) { setCancelling(null); setReason(''); }
  };

  const uncancel = async (d: MarketDate) => {
    setBusy(d.id);
    await onPatch(d.id, { status: 'collecting' }, `${formatDateLabel(d.date)} restored`);
    setBusy(null);
  };

  return (
    <Card
      title={`Dates (${dates.length})`}
      aside={
        <div className="flex items-center gap-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer" style={{ borderColor: '#E4DFD3', color: '#3d3428', background: '#fff' }}>
            <option value="">All statuses</option>
            <option value="collecting">Collecting</option>
            <option value="lineup_final">Lineup final</option>
            <option value="published">Published</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <CheckboxField label="Show past" checked={showPast} onChange={setShowPast} />
        </div>
      }
    >
      <TableCard minWidth={860}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Date</Th>
            <Th>Hours</Th>
            <Th>Status</Th>
            <Th>Version</Th>
            <Th>Questions</Th>
            <Th>Check-ins</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <EmptyRow colSpan={7}>{dates.length === 0 ? 'No dates yet — regenerate to create them.' : 'No dates match the filter.'}</EmptyRow>
          ) : (
            visible.map((d) => {
              const past = Date.parse(d.end_at) < now;
              const isOpen = expanded === d.id;
              return (
                <DateRowGroup key={d.id}>
                  <tr className={`border-b border-border-light ${past ? 'opacity-70' : ''}`}>
                    <Td>
                      <div className="font-semibold">{weekdayLabel(d.date)}, {formatDateLabel(d.date)}</div>
                      {d.note && <div className="text-[12px] text-text-muted">{d.note}</div>}
                      {d.status === 'cancelled' && d.cancellation_reason && (
                        <div className="text-[12px] text-red-500">{d.cancellation_reason}{d.cancelled_by ? ` · by ${d.cancelled_by}` : ''}</div>
                      )}
                    </Td>
                    <Td>{formatTime12h(d.start_time)}–{formatTime12h(d.end_time)}</Td>
                    <Td><StatusChip status={d.status} /> {d.special && <StatusChip status="special" />}</Td>
                    <Td><span className="font-mono text-[12px]">{versionLabel(d)}</span></Td>
                    <Td>
                      <button type="button" onClick={() => setExpanded(isOpen ? null : d.id)} className="bg-transparent border-none cursor-pointer text-green-700 text-xs font-semibold p-0">
                        {d.extra_questions?.length ?? 0} question{(d.extra_questions?.length ?? 0) === 1 ? '' : 's'} {isOpen ? '▲' : '▼'}
                      </button>
                    </Td>
                    <Td>
                      <Link href={`/admin/market-dates?id=${encodeURIComponent(d.id)}`} className="text-green-700 text-xs font-semibold no-underline hover:underline">
                        Check-ins
                      </Link>
                      <div className="text-[12px] text-text-muted mt-0.5 whitespace-nowrap" title="Check-in text sent / reminders sent / deadline processed">
                        <span title="Check-in text sent">{d.actions?.checkin_sent_at ? '✓' : '·'} link</span>
                        {' · '}
                        <span title="Reminders sent">{d.actions?.reminders_sent?.length ?? 0} rem.</span>
                        {' · '}
                        <span title="Deadline processed">{d.actions?.deadline_processed_at ? '✓' : '·'} deadline</span>
                      </div>
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      {canEdit && d.status === 'collecting' && !past && cancelling !== d.id && (
                        <button type="button" onClick={() => { setCancelling(d.id); setReason(''); }} className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border" style={{ borderColor: '#fecaca', color: '#dc2626', background: '#fff' }}>
                          Cancel
                        </button>
                      )}
                      {canEdit && d.status === 'cancelled' && !past && !hasActions(d) && (
                        <ConfirmButton label="Un-cancel" confirmLabel="Restore date" danger={false} busy={busy === d.id} onConfirm={() => uncancel(d)} />
                      )}
                    </Td>
                  </tr>
                  {cancelling === d.id && (
                    <tr className="border-b border-border-light bg-red-50/40">
                      <td colSpan={7} className="px-4 py-3">
                        <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                          <div className="flex-1">
                            <Field label="Reason for cancelling" value={reason} onChange={setReason} placeholder="Severe weather" />
                          </div>
                          <SecondaryButton onClick={() => setCancelling(null)}>Keep date</SecondaryButton>
                          <button type="button" onClick={() => cancel(d)} disabled={!reason.trim() || busy === d.id} className="px-4 py-2 rounded-xl text-sm font-semibold text-white border-none cursor-pointer disabled:opacity-40" style={{ background: '#dc2626' }}>
                            {busy === d.id ? 'Cancelling…' : 'Cancel this date'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {isOpen && (
                    <tr className="border-b border-border-light bg-earth-15">
                      <td colSpan={7} className="px-4 py-3">
                        <ExtraQuestionsEditor
                          questions={d.extra_questions || []}
                          readOnly={!canEdit}
                          onSave={(qs) => onPatch(d.id, { extra_questions: qs }, `Questions saved for ${formatDateLabel(d.date)}`)}
                        />
                      </td>
                    </tr>
                  )}
                </DateRowGroup>
              );
            })
          )}
        </tbody>
      </TableCard>
    </Card>
  );
}

/** Fragment wrapper so each date can render several <tr>s with one key. */
function DateRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ExtraQuestionsEditor({
  questions,
  readOnly,
  onSave,
}: {
  questions: ExtraQuestion[];
  readOnly: boolean;
  onSave: (qs: ExtraQuestion[]) => Promise<boolean>;
}) {
  type Draft = { key: string; prompt: string; type: ExtraQuestion['type']; options: string };
  const toDraft = (q: ExtraQuestion): Draft => ({ key: q.key, prompt: q.prompt, type: q.type, options: (q.options || []).join(', ') });
  const [rows, setRows] = useState<Draft[]>(questions.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setRows(questions.map(toDraft));
  }, [questions]);

  const update = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setError('');
    const out: ExtraQuestion[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(r.key)) { setError(`Key "${r.key}" must be 2–32 chars: lower-case letters, digits, underscores.`); return; }
      if (seen.has(r.key)) { setError(`Key "${r.key}" is used twice.`); return; }
      seen.add(r.key);
      if (!r.prompt.trim()) { setError(`Question "${r.key}" needs a prompt.`); return; }
      const q: ExtraQuestion = { key: r.key, prompt: r.prompt.trim(), type: r.type };
      if (r.type === 'choice') {
        const options = r.options.split(',').map((s) => s.trim()).filter(Boolean);
        if (options.length === 0) { setError(`Question "${r.key}" needs at least one option.`); return; }
        q.options = options;
      }
      out.push(q);
    }
    setSaving(true);
    await onSave(out);
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-earth-500">Extra check-in questions for this date</div>
      {rows.length === 0 && <p className="text-sm text-earth-400 m-0">No extra questions.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[150px_1fr_120px_1fr_auto] gap-2 items-end">
          <Field label="Key" value={r.key} onChange={(v) => update(i, { key: v })} placeholder="weekly_question" disabled={readOnly} />
          <Field label="Prompt" value={r.prompt} onChange={(v) => update(i, { prompt: v })} disabled={readOnly} />
          {readOnly ? (
            <Field label="Type" value={r.type} disabled />
          ) : (
            <SelectField label="Type" value={r.type} onChange={(v) => update(i, { type: v as ExtraQuestion['type'] })} options={[{ value: 'text', label: 'Text' }, { value: 'choice', label: 'Choice' }, { value: 'yes_no', label: 'Yes / no' }]} />
          )}
          <Field label="Options (comma-separated)" value={r.options} onChange={(v) => update(i, { options: v })} disabled={readOnly || r.type !== 'choice'} />
          {!readOnly ? (
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="h-[38px] px-3 rounded-xl border border-earth-200 bg-white cursor-pointer text-earth-500 hover:text-red-500 text-sm" aria-label="Remove question">×</button>
          ) : <span />}
        </div>
      ))}
      {error && <Notice kind="error">{error}</Notice>}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 justify-between">
          <SecondaryButton small onClick={() => setRows([...rows, { key: '', prompt: '', type: 'text', options: '' }])}>+ Add question</SecondaryButton>
          <PrimaryButton small onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save questions'}</PrimaryButton>
        </div>
      )}
    </div>
  );
}
