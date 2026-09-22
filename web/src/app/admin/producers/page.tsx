'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Market, MembershipStatus, ProducerListItem } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, Field, Notice, PrimaryButton, SecondaryButton, SelectField, TextArea } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th } from '@/components/admin-shell';
import { normalizePhone } from '@/lib/phone';

const STATUSES: MembershipStatus[] = ['applied', 'under_review', 'approved', 'active', 'inactive'];

export default function ProducersPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Producers />
    </Suspense>
  );
}

function Producers() {
  const { ready, isAdmin, user } = useStaffGuard();
  const params = useSearchParams();
  const router = useRouter();

  const [markets, setMarkets] = useState<Market[]>([]);
  const [producers, setProducers] = useState<ProducerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  // Filters. Managers must pick one of their assigned markets (the API
  // requires market_id for them); admins may see everything.
  const isManager = user?.role === 'market_manager';
  const assigned = useMemo(() => user?.assigned_market_ids ?? [], [user]);
  const [marketId, setMarketId] = useState(params.get('market_id') || '');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  useEffect(() => {
    if (isManager && !marketId && assigned.length > 0) setMarketId(assigned[0]);
  }, [isManager, marketId, assigned]);

  useEffect(() => {
    if (!ready) return;
    api.getMarkets().then((d) => setMarkets([...(d.markets || [])].sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setMarkets([]));
  }, [ready]);

  const load = useCallback(async () => {
    if (isManager && !marketId) {
      setProducers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await api.getProducers({
        market_id: marketId || undefined,
        status: status || undefined,
        q: q.trim() || undefined,
        include_inactive: includeInactive ? 'true' : undefined,
      });
      setProducers(data.producers || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load producers');
    } finally {
      setLoading(false);
    }
  }, [isManager, marketId, status, q, includeInactive]);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [ready, load, q]);

  // Keep the URL in sync so the dashboard link and reloads land on the same view.
  useEffect(() => {
    if (!ready) return;
    const next = marketId ? `/admin/producers?market_id=${encodeURIComponent(marketId)}` : '/admin/producers';
    if (typeof window !== 'undefined' && window.location.pathname + window.location.search !== next) {
      window.history.replaceState({}, '', next);
    }
  }, [ready, marketId]);

  if (!ready) return <LoadingScreen />;

  const marketOptions = (isManager ? markets.filter((m) => assigned.includes(m.id)) : markets).map((m) => ({ value: m.id, label: m.name }));
  const marketName = (id: string) => markets.find((m) => m.id === id)?.name || id;

  return (
    <AdminShell
      title="Producers"
      subtitle="Vendors and their membership at each market"
      actions={
        <>
          <SecondaryButton small onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</SecondaryButton>
          {isAdmin && <PrimaryButton small onClick={() => setShowNew((v) => !v)}>{showNew ? 'Cancel' : '+ New producer'}</PrimaryButton>}
        </>
      }
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {isManager && assigned.length === 0 && (
        <div className="mb-4"><Notice kind="info">You have not been assigned to a market yet. Ask an SJCA administrator.</Notice></div>
      )}

      {isAdmin && showNew && (
        <div className="mb-6">
          <NewProducerForm
            markets={markets}
            onCreated={(id) => {
              setShowNew(false);
              router.push(`/admin/producers/detail?id=${encodeURIComponent(id)}`);
            }}
          />
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-border-light p-3 mb-4 flex flex-col gap-3" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr_auto] gap-3 items-end">
          <SelectField
            label={isManager ? 'Market (required)' : 'Market'}
            value={marketId}
            onChange={setMarketId}
            options={isManager ? marketOptions : [{ value: '', label: 'All markets' }, ...marketOptions]}
          />
          <Field label="Search" value={q} onChange={setQ} placeholder="Business, alias or contact name" />
          <div className="pb-2">
            <CheckboxField label="Include inactive" checked={includeInactive} onChange={setIncludeInactive} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mr-1">Status</span>
          <FilterChip label="Any" on={status === ''} onClick={() => setStatus('')} />
          {STATUSES.map((s) => (
            <FilterChip key={s} label={s.replace(/_/g, ' ')} on={status === s} onClick={() => setStatus(status === s ? '' : s)} />
          ))}
          <span className="text-xs text-text-muted ml-auto">{producers.length} producer{producers.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <TableCard>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Business</Th>
            <Th>Contact</Th>
            {isAdmin && <Th>Phone / email</Th>}
            <Th>Memberships</Th>
          </tr>
        </thead>
        <tbody>
          {loading && producers.length === 0 ? (
            <EmptyRow colSpan={isAdmin ? 4 : 3}>Loading producers…</EmptyRow>
          ) : producers.length === 0 ? (
            <EmptyRow colSpan={isAdmin ? 4 : 3}>{isManager && !marketId ? 'Pick a market to see its producers.' : 'No producers match.'}</EmptyRow>
          ) : (
            producers.map((p) => (
              <tr key={p.id} className={`border-b border-border-light last:border-none hover:bg-bg-alt transition-colors ${p.active ? '' : 'opacity-60'}`}>
                <Td>
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(p.id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                    {p.business_name}
                  </Link>
                  {p.aliases?.length > 0 && <div className="text-[11px] text-text-muted">also: {p.aliases.join(', ')}</div>}
                  {!p.active && <div className="mt-0.5"><StatusChip status="inactive" /></div>}
                </Td>
                <Td>{p.contact_name || <span className="text-text-muted">—</span>}</Td>
                {isAdmin && (
                  <Td>
                    <div className="font-mono text-[12px]">{p.phone || '—'}</div>
                    <div className="text-[12px] text-text-muted">{p.email || '—'}</div>
                  </Td>
                )}
                <Td>
                  <div className="flex flex-wrap gap-1.5">
                    {(p.memberships || []).length === 0 && <span className="text-text-muted text-[12px]">none</span>}
                    {(p.memberships || []).map((m) => (
                      <span key={m.market_id} className="inline-flex items-center gap-1 text-[12px]">
                        <span className="text-text-soft">{marketName(m.market_id)}</span>
                        <StatusChip status={m.status} />
                      </span>
                    ))}
                  </div>
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
    </AdminShell>
  );
}

function FilterChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 rounded-full text-xs font-semibold cursor-pointer border capitalize"
      style={{ background: on ? '#EBF4E6' : '#fff', borderColor: on ? '#2A5E33' : '#E4DFD3', color: on ? '#2A5E33' : '#5C5C5C' }}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/* ─── New producer (admin) ─── */

function NewProducerForm({ markets, onCreated }: { markets: Market[]; onCreated: (id: string) => void }) {
  const [businessName, setBusinessName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [memberMarkets, setMemberMarkets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id: string) => setMemberMarkets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    setError('');
    if (!businessName.trim()) { setError('A business name is required.'); return; }
    setSaving(true);
    try {
      const { producer } = await api.createProducer({
        business_name: businessName.trim(),
        contact_name: contactName.trim() || undefined,
        phone: phone.trim() ? normalizePhone(phone) : undefined,
        email: email.trim() || undefined,
        category: category.trim() || undefined,
        notes: notes.trim() || undefined,
        memberships: memberMarkets.map((market_id) => ({ market_id, status: 'approved' as const })),
      });
      onCreated(producer.id);
    } catch (err: any) {
      setError(err?.message || 'Could not create the producer');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 space-y-4">
      <h2 className="font-display text-lg font-bold m-0" style={{ color: '#21512C' }}>New producer</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Business name" value={businessName} onChange={setBusinessName} />
        <Field label="Contact name" value={contactName} onChange={setContactName} />
        <Field label="Phone" type="tel" value={phone} onChange={setPhone} placeholder="(501) 555-0100" />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Category" value={category} onChange={setCategory} placeholder="Produce, baked goods, …" />
      </div>
      <TextArea label="Notes (admin only)" value={notes} onChange={setNotes} />
      <div>
        <label className="block text-xs font-semibold text-earth-500 mb-1">Approve for markets</label>
        <div className="flex flex-wrap gap-3">
          {markets.length === 0 && <span className="text-sm text-earth-400">No markets yet.</span>}
          {markets.map((m) => (
            <CheckboxField key={m.id} label={m.name} checked={memberMarkets.includes(m.id)} onChange={() => toggle(m.id)} />
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <PrimaryButton onClick={submit} disabled={saving || !businessName.trim()}>{saving ? 'Creating…' : 'Create producer'}</PrimaryButton>
      </div>
    </div>
  );
}
