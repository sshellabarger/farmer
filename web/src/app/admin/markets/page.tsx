'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DAYS_OF_WEEK, type DayOfWeek, type Market, type PublicMarket } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, DateField, Field, Notice, PrimaryButton, SecondaryButton, SelectField, TimeField } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatDateLabel, formatTime12h } from '@/components/admin-shell';
import { TIMEZONE_OPTIONS, WeekdayPicker } from '@/components/market-bits';

export default function MarketsPage() {
  const { ready, isAdmin } = useStaffGuard();
  const router = useRouter();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [nextById, setNextById] = useState<Record<string, PublicMarket['next']>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [mine, pub] = await Promise.all([
        api.getMarkets(),
        // The public list carries each active market's next date; failures
        // only cost the "next date" column.
        api.getPublicMarkets().catch(() => ({ markets: [] as PublicMarket[] })),
      ]);
      setMarkets([...(mine.markets || [])].sort((a, b) => a.name.localeCompare(b.name)));
      const map: Record<string, PublicMarket['next']> = {};
      for (const m of pub.markets || []) map[m.id] = m.next;
      setNextById(map);
    } catch (err: any) {
      setError(err?.message || 'Could not load markets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!ready) return <LoadingScreen />;

  return (
    <AdminShell
      title="Markets"
      subtitle="Every market carries its own schedule, workflow offsets and quiet hours"
      actions={
        <>
          <SecondaryButton small onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</SecondaryButton>
          {isAdmin && (
            <PrimaryButton small onClick={() => setShowNew((v) => !v)}>{showNew ? 'Cancel' : '+ New market'}</PrimaryButton>
          )}
        </>
      }
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

      {isAdmin && showNew && (
        <div className="mb-6">
          <NewMarketForm
            onCreated={(m) => {
              setShowNew(false);
              router.push(`/admin/markets/detail?id=${encodeURIComponent(m.id)}`);
            }}
          />
        </div>
      )}

      <TableCard>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Market</Th>
            <Th>Location</Th>
            <Th>Timezone</Th>
            <Th>Active</Th>
            <Th>Next date</Th>
          </tr>
        </thead>
        <tbody>
          {loading && markets.length === 0 ? (
            <EmptyRow colSpan={5}>Loading markets…</EmptyRow>
          ) : markets.length === 0 ? (
            <EmptyRow colSpan={5}>{isAdmin ? 'No markets yet — create the first one.' : 'No markets are assigned to you yet.'}</EmptyRow>
          ) : (
            markets.map((m) => {
              const next = nextById[m.id];
              return (
                <tr key={m.id} className="border-b border-border-light last:border-none hover:bg-bg-alt transition-colors">
                  <Td>
                    <Link href={`/admin/markets/detail?id=${encodeURIComponent(m.id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                      {m.name}
                    </Link>
                    <div className="text-[11px] text-text-muted font-mono">{m.slug}</div>
                  </Td>
                  <Td>
                    <div>{m.location?.name || '—'}</div>
                    {m.location?.address && <div className="text-[12px] text-text-muted">{m.location.address}</div>}
                  </Td>
                  <Td><span className="font-mono text-[12px]">{m.timezone}</span></Td>
                  <Td><StatusChip status={m.active ? 'active' : 'inactive'} /></Td>
                  <Td>
                    {next ? (
                      <>
                        <div>{formatDateLabel(next.date)}</div>
                        <div className="text-[12px] text-text-muted">{formatTime12h(next.start_time)}–{formatTime12h(next.end_time)}</div>
                      </>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </TableCard>
    </AdminShell>
  );
}

/* ─── New market form (admin) ─── */

function NewMarketForm({ onCreated }: { onCreated: (m: Market) => void }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [locName, setLocName] = useState('');
  const [locAddress, setLocAddress] = useState('');
  const [timezone, setTimezone] = useState('America/Chicago');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [seasonStart, setSeasonStart] = useState('');
  const [seasonEnd, setSeasonEnd] = useState('');
  const [days, setDays] = useState<DayOfWeek[]>([]);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('12:00');
  const [quietStart, setQuietStart] = useState('21:00');
  const [quietEnd, setQuietEnd] = useState('08:00');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleDay = (d: DayOfWeek) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const slugOk = /^[a-z0-9][a-z0-9-]{1,31}$/.test(slug);
  const canSubmit =
    slugOk && name.trim() && locName.trim() && effectiveFrom && seasonStart && seasonEnd && days.length > 0 && startTime && endTime;

  const submit = async () => {
    setError('');
    if (!canSubmit) {
      setError('Fill in the slug, name, location, one schedule version and at least one weekday.');
      return;
    }
    setSaving(true);
    try {
      const { market } = await api.createMarket({
        slug,
        name: name.trim(),
        location: { name: locName.trim(), address: locAddress.trim() },
        timezone,
        schedule: {
          versions: [{
            effective_from: effectiveFrom,
            season_start: seasonStart,
            season_end: seasonEnd,
            days_of_week: DAYS_OF_WEEK.filter((d) => days.includes(d)),
            start_time: startTime,
            end_time: endTime,
          }],
        },
        quiet_hours: { start: quietStart, end: quietEnd },
        active,
      });
      onCreated(market);
    } catch (err: any) {
      setError(err?.message || 'Could not create the market');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 space-y-5">
      <h2 className="font-display text-lg font-bold m-0" style={{ color: '#21512C' }}>New market</h2>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Field label="Slug (permanent id)" value={slug} onChange={(v) => setSlug(v.toLowerCase())} placeholder="wlrfm" />
          {slug && !slugOk && <div className="text-[11px] text-red-500 mt-1">2–32 chars: lower-case letters, digits, hyphens; must start with a letter or digit.</div>}
        </div>
        <Field label="Name" value={name} onChange={setName} placeholder="West Little Rock Farmers Market" />
        <Field label="Location name" value={locName} onChange={setLocName} placeholder="Breckenridge Village" />
        <Field label="Address" value={locAddress} onChange={setLocAddress} placeholder="Optional" />
        <SelectField label="Timezone" value={timezone} onChange={setTimezone} options={TIMEZONE_OPTIONS} />
        <div className="flex items-end pb-2">
          <CheckboxField label="Active (visible on the application form)" checked={active} onChange={setActive} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-earth-800 mb-2 mt-0">First schedule version</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <DateField label="Effective from" value={effectiveFrom} onChange={setEffectiveFrom} />
          <DateField label="Season start" value={seasonStart} onChange={setSeasonStart} />
          <DateField label="Season end" value={seasonEnd} onChange={setSeasonEnd} />
          <TimeField label="Start time" value={startTime} onChange={setStartTime} />
          <TimeField label="End time" value={endTime} onChange={setEndTime} />
        </div>
        <div className="mt-3">
          <label className="block text-xs font-semibold text-earth-500 mb-1">Market days</label>
          <WeekdayPicker value={days} onToggle={toggleDay} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-earth-800 mb-2 mt-0">Quiet hours (no texts)</h3>
        <div className="grid grid-cols-2 gap-3 max-w-[360px]">
          <TimeField label="From" value={quietStart} onChange={setQuietStart} />
          <TimeField label="Until" value={quietEnd} onChange={setQuietEnd} />
        </div>
      </div>

      <div className="flex justify-end">
        <PrimaryButton onClick={submit} disabled={saving || !canSubmit}>{saving ? 'Creating…' : 'Create market'}</PrimaryButton>
      </div>
    </div>
  );
}
