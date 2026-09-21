'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { Application, ApplicationStatus, Market } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, Notice, PrimaryButton, SecondaryButton, TextArea } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatStamp } from '@/components/admin-shell';

const TABS: { value: ApplicationStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'under_review', label: 'Under review' },
  { value: 'approved', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
];

/** Applications inbox (admin only, contract §8.3): review, approve or decline. */
export default function ApplicationsPage() {
  const { ready } = useStaffGuard({ adminOnly: true });
  const [tab, setTab] = useState<ApplicationStatus>('new');
  const [applications, setApplications] = useState<Application[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (status: ApplicationStatus) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getApplications({ status });
      setApplications(data.applications || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load applications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    api.getMarkets().then((d) => setMarkets(d.markets || [])).catch(() => setMarkets([]));
  }, [ready]);

  useEffect(() => {
    if (ready) load(tab);
  }, [ready, tab, load]);

  const marketName = (id: string) => markets.find((m) => m.id === id)?.name || id;

  const onDecided = (id: string) => {
    setExpanded(null);
    load(tab);
  };

  if (!ready) return <LoadingScreen />;

  return (
    <AdminShell
      title="Applications"
      subtitle="Vendor applications to sell at SJCA markets"
      actions={<SecondaryButton small onClick={() => load(tab)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</SecondaryButton>}
    >
      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className="px-3.5 py-1.5 rounded-full text-xs font-semibold cursor-pointer border"
            style={{
              background: tab === t.value ? '#EBF4E6' : '#fff',
              borderColor: tab === t.value ? '#2A5E33' : '#E4DFD3',
              color: tab === t.value ? '#2A5E33' : '#5C5C5C',
            }}
            aria-pressed={tab === t.value}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

      <TableCard minWidth={640}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Business</Th>
            <Th>Contact</Th>
            <Th>Markets</Th>
            <Th>Submitted</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {loading && applications.length === 0 ? (
            <EmptyRow colSpan={5}>Loading applications…</EmptyRow>
          ) : applications.length === 0 ? (
            <EmptyRow colSpan={5}>No {tab.replace('_', ' ')} applications.</EmptyRow>
          ) : (
            applications.map((a) => (
              <ApplicationRow
                key={a.id}
                application={a}
                markets={markets}
                marketName={marketName}
                expanded={expanded === a.id}
                onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                onDecided={() => onDecided(a.id)}
              />
            ))
          )}
        </tbody>
      </TableCard>
    </AdminShell>
  );
}

function ApplicationRow({
  application,
  markets,
  marketName,
  expanded,
  onToggle,
  onDecided,
}: {
  application: Application;
  markets: Market[];
  marketName: (id: string) => string;
  expanded: boolean;
  onToggle: () => void;
  onDecided: () => void;
}) {
  const a = application;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'none' | 'approve' | 'decline'>('none');
  const [note, setNote] = useState('');
  const [marketIds, setMarketIds] = useState<string[]>(a.markets_applied);

  const startReview = async () => {
    setBusy(true);
    setError('');
    try {
      await api.reviewApplication(a.id, { action: 'review' });
      onDecided();
    } catch (err: any) {
      setError(err?.message || 'Could not start review');
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    setError('');
    try {
      await api.reviewApplication(a.id, { action: 'decline', note: note.trim() || undefined });
      onDecided();
    } catch (err: any) {
      setError(err?.message || 'Could not decline the application');
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (marketIds.length === 0) { setError('Choose at least one market.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.reviewApplication(a.id, { action: 'approve', market_ids: marketIds, note: note.trim() || undefined });
      onDecided();
    } catch (err: any) {
      setError(err?.message || 'Could not approve the application');
    } finally {
      setBusy(false);
    }
  };

  const toggleMarket = (id: string) => setMarketIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <>
      <tr className="border-b border-border-light last:border-none hover:bg-bg-alt transition-colors cursor-pointer" onClick={onToggle}>
        <Td>
          <div className="font-semibold text-earth-800">{a.business_name}</div>
          {a.status === 'approved' && a.producer_id && (
            <Link
              href={`/admin/producers/detail?id=${encodeURIComponent(a.producer_id)}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-green-700 no-underline hover:underline"
            >
              View producer →
            </Link>
          )}
        </Td>
        <Td>
          <div>{a.contact_person}</div>
          <div className="text-[12px] text-text-muted">{a.email}</div>
          <div className="text-[12px] text-text-muted font-mono">{a.phone}</div>
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            {a.markets_applied.map((id) => (
              <span key={id} className="text-[12px] px-1.5 py-0.5 rounded bg-earth-50 border border-earth-100">{marketName(id)}</span>
            ))}
          </div>
        </Td>
        <Td>{formatStamp(a.submitted_at)}</Td>
        <Td className="text-right">
          <StatusChip status={a.status} />
        </Td>
      </tr>
      {expanded && (
        <tr className="border-b border-border-light last:border-none">
          <td colSpan={5} className="px-4 py-4 bg-bg-alt/60">
            {error && <div className="mb-3"><Notice kind="error">{error}</Notice></div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mb-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">Applicant</div>
                <div>{a.contact_person} · {a.email} · {a.phone}</div>
              </div>
              {a.decision_note && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">Decision note</div>
                  <div>{a.decision_note}</div>
                </div>
              )}
            </div>
            {Object.keys(a.extra || {}).length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">Additional answers</div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm m-0">
                  {Object.entries(a.extra).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-text-muted">{k.replace(/_/g, ' ')}</dt>
                      <dd className="m-0">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {a.status === 'new' && mode === 'none' && (
              <div className="flex gap-2">
                <PrimaryButton small onClick={startReview} disabled={busy}>{busy ? 'Working…' : 'Start review'}</PrimaryButton>
                <SecondaryButton small onClick={() => setMode('decline')} disabled={busy}>Decline…</SecondaryButton>
              </div>
            )}
            {a.status === 'under_review' && mode === 'none' && (
              <div className="flex gap-2">
                <PrimaryButton small onClick={() => setMode('approve')} disabled={busy}>Approve…</PrimaryButton>
                <SecondaryButton small onClick={() => setMode('decline')} disabled={busy}>Decline…</SecondaryButton>
              </div>
            )}

            {mode === 'approve' && (
              <div className="mt-3 p-3 rounded-xl border border-earth-100 bg-white max-w-md space-y-3">
                <div className="text-sm font-semibold text-earth-800">Approve for which markets?</div>
                <div className="flex flex-col gap-1.5">
                  {a.markets_applied.map((id) => (
                    <CheckboxField key={id} label={marketName(id)} checked={marketIds.includes(id)} onChange={() => toggleMarket(id)} />
                  ))}
                </div>
                <TextArea label="Note (optional)" value={note} onChange={setNote} />
                <div className="flex gap-2 justify-end">
                  <SecondaryButton small onClick={() => setMode('none')} disabled={busy}>Cancel</SecondaryButton>
                  <PrimaryButton small onClick={approve} disabled={busy}>{busy ? 'Approving…' : 'Approve'}</PrimaryButton>
                </div>
              </div>
            )}
            {mode === 'decline' && (
              <div className="mt-3 p-3 rounded-xl border border-earth-100 bg-white max-w-md space-y-3">
                <TextArea label="Reason (optional)" value={note} onChange={setNote} />
                <div className="flex gap-2 justify-end">
                  <SecondaryButton small onClick={() => setMode('none')} disabled={busy}>Cancel</SecondaryButton>
                  <PrimaryButton small onClick={decline} disabled={busy}>{busy ? 'Declining…' : 'Decline'}</PrimaryButton>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
