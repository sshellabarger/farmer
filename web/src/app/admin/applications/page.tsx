'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { ApplicationListItem } from '@/lib/phase4-types';
import type { Market } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { Field, Notice, SecondaryButton, SelectField } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatStamp } from '@/components/admin-shell';

const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'under_review', label: 'Under review' },
  { value: 'approved', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const INSURANCE_LABEL: Record<string, string> = {
  have: 'Has insurance',
  none: 'No insurance',
  need_guidance: 'Needs guidance',
};

function humanize(key: string): string {
  return key.replace(/_/g, ' ');
}

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Applications />
    </Suspense>
  );
}

/** Applications queue (admin only): filter, scan, open one to review. */
function Applications() {
  const { ready } = useStaffGuard({ adminOnly: true });
  const router = useRouter();
  const params = useSearchParams();

  const [markets, setMarkets] = useState<Market[]>([]);
  const [rows, setRows] = useState<ApplicationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [status, setStatus] = useState(params.get('status') || 'new');
  const [marketId, setMarketId] = useState(params.get('market_id') || '');
  const [season, setSeason] = useState(params.get('season') || '');
  const [fee, setFee] = useState('');
  const [category, setCategory] = useState('');
  const [returning, setReturning] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!ready) return;
    api
      .getMarkets()
      .then((d) => setMarkets([...(d.markets || [])].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setMarkets([]));
  }, [ready]);

  const marketName = useCallback((id: string) => markets.find((m) => m.id === id)?.name || id, [markets]);

  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of markets) {
      if (marketId && m.id !== marketId) continue;
      for (const c of m.categories || []) if (!seen.has(c.key)) seen.set(c.key, c.label);
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  }, [markets, marketId]);

  const productLabel = useCallback(
    (marketIdOfRow: string, key: string) =>
      markets.find((m) => m.id === marketIdOfRow)?.product_types?.find((t) => t.key === key)?.label || humanize(key),
    [markets],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getApplicationsV2({
        market_id: marketId || undefined,
        season: season.trim() || undefined,
        status: status || undefined,
        fee: fee || undefined,
        category: category || undefined,
        returning: returning === 'true' || returning === 'false' ? returning : undefined,
        q: debouncedQ || undefined,
      });
      setRows(data.applications || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load applications');
    } finally {
      setLoading(false);
    }
  }, [marketId, season, status, fee, category, returning, debouncedQ]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!ready) return <LoadingScreen />;

  return (
    <AdminShell
      title="Applications"
      subtitle="Vendor applications for the season. Every producer re-applies each season."
      actions={<SecondaryButton small onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</SecondaryButton>}
    >
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value || 'all'}
            type="button"
            onClick={() => setStatus(t.value)}
            className="px-3.5 py-1.5 rounded-full text-xs font-semibold cursor-pointer border"
            style={{
              background: status === t.value ? '#EBF4E6' : '#fff',
              borderColor: status === t.value ? '#2A5E33' : '#E4DFD3',
              color: status === t.value ? '#2A5E33' : '#5C5C5C',
            }}
            aria-pressed={status === t.value}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
        <SelectField
          label="Market"
          value={marketId}
          onChange={setMarketId}
          options={[{ value: '', label: 'All markets' }, ...markets.map((m) => ({ value: m.id, label: m.name }))]}
        />
        <Field label="Season" value={season} onChange={setSeason} placeholder="current" />
        <SelectField
          label="Application fee"
          value={fee}
          onChange={setFee}
          options={[
            { value: '', label: 'Any' },
            { value: 'unpaid', label: 'Unpaid' },
            { value: 'paid', label: 'Paid' },
            { value: 'waived', label: 'Waived' },
          ]}
        />
        <SelectField label="Category" value={category} onChange={setCategory} options={[{ value: '', label: 'Any' }, ...categoryOptions]} />
        <SelectField
          label="New or returning"
          value={returning}
          onChange={setReturning}
          options={[
            { value: '', label: 'Either' },
            { value: 'false', label: 'New vendors' },
            { value: 'true', label: 'Returning' },
          ]}
        />
        <Field label="Search" value={q} onChange={setQ} placeholder="Business, name or email" />
      </div>

      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

      <TableCard minWidth={980}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Business</Th>
            <Th>Contact</Th>
            <Th>Products</Th>
            <Th>Booth</Th>
            <Th>Fee</Th>
            <Th>Insurance</Th>
            <Th>Submitted</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <EmptyRow colSpan={8}>Loading applications...</EmptyRow>
          ) : rows.length === 0 ? (
            <EmptyRow colSpan={8}>No applications match these filters.</EmptyRow>
          ) : (
            rows.map((a) => (
              <tr
                key={a.id}
                className="border-b border-border-light last:border-none hover:bg-bg-alt transition-colors cursor-pointer"
                onClick={() => router.push(`/admin/applications/detail?id=${encodeURIComponent(a.id)}`)}
              >
                <Td>
                  <Link
                    href={`/admin/applications/detail?id=${encodeURIComponent(a.id)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-semibold text-earth-800 no-underline hover:underline"
                  >
                    {a.business_name}
                  </Link>
                  <div className="text-[11px] text-text-muted">
                    {marketName(a.market_id)} - {a.season}
                    {a.is_returning ? ' - returning' : ' - new'}
                  </div>
                </Td>
                <Td>
                  <div>{a.contact_name}</div>
                  <div className="text-[12px] text-text-muted">{a.email}</div>
                  <div className="text-[12px] text-text-muted font-mono">{a.mobile}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.product_types.map((t) => (
                      <span key={t} className="text-[12px] px-1.5 py-0.5 rounded bg-earth-50 border border-earth-100">{productLabel(a.market_id, t)}</span>
                    ))}
                  </div>
                  {a.permits_pending > 0 && (
                    <div className="text-[11px] mt-1" style={{ color: '#92400E' }}>
                      {a.permits_pending} permit{a.permits_pending === 1 ? '' : 's'} to provide
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StatusChip status={a.rate} />
                    <span className="text-[12px]">
                      {a.spaces} space{a.spaces === 1 ? '' : 's'}
                      {a.electric ? ' - power' : ''}
                    </span>
                  </div>
                </Td>
                <Td><StatusChip status={a.fee_status} /></Td>
                <Td><span className="text-[12px]">{INSURANCE_LABEL[a.insurance_status] || a.insurance_status}</span></Td>
                <Td><span className="text-[12px]">{formatStamp(a.submitted_at)}</span></Td>
                <Td><StatusChip status={a.status} /></Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
    </AdminShell>
  );
}
