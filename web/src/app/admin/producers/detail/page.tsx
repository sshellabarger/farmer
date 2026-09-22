'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { MEMBERSHIP_TRANSITIONS, type Checkin, type FeePlan, type Market, type Membership, type MembershipStatus, type Producer } from '@/lib/types';
import { canAccessMarket, useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, Field, ListEditor, Notice, PrimaryButton, SaveBar, SecondaryButton, SelectField, TextArea } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatStamp } from '@/components/admin-shell';
import { normalizePhone } from '@/lib/phone';

export default function ProducerDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ProducerDetail />
    </Suspense>
  );
}

function ProducerDetail() {
  const { ready, isAdmin, user } = useStaffGuard();
  const params = useSearchParams();
  const id = params.get('id') || '';

  const [producer, setProducer] = useState<Producer | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [summary, setSummary] = useState<{ count: number; last_submitted_at: string | null } | null>(null);
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const reload = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const [p, m, c, mk] = await Promise.all([
        api.getProducer(id),
        api.getMemberships({ producer_id: id }).catch(() => ({ memberships: [] })),
        api.getCheckins({ producer_id: id }).catch(() => ({ checkins: [] })),
        api.getMarkets().catch(() => ({ markets: [] as Market[] })),
      ]);
      setProducer(p.producer);
      setSummary(p.checkins_summary);
      // Prefer the memberships endpoint (scoped per role); fall back to the
      // producer payload's list.
      setMemberships((m.memberships && m.memberships.length > 0 ? m.memberships : p.memberships) || []);
      setCheckins([...(c.checkins || [])].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)));
      setMarkets([...(mk.markets || [])].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err: any) {
      setError(err?.message || 'Could not load the producer');
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

  const runWrite = async (fn: () => Promise<unknown>, okMsg = 'Saved') => {
    setError('');
    try {
      await fn();
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
      <AdminShell title="Producer">
        <Notice kind="error">No producer id in the URL. <Link href="/admin/producers" className="font-semibold">Back to producers</Link></Notice>
      </AdminShell>
    );
  }
  if (loading && !producer) return <LoadingScreen label="Loading producer…" />;
  if (!producer) {
    return (
      <AdminShell title="Producer">
        <Notice kind="error">{error || 'Producer not found.'} <Link href="/admin/producers" className="font-semibold">Back to producers</Link></Notice>
      </AdminShell>
    );
  }

  const marketName = (mid: string) => markets.find((m) => m.id === mid)?.name || mid;

  return (
    <AdminShell
      title={producer.business_name}
      subtitle={
        <>
          {producer.contact_name || 'No contact name'} · {producer.source} · <Link href="/admin/producers" className="text-green-700">All producers</Link>
        </>
      }
      actions={!producer.active ? <StatusChip status="inactive" /> : undefined}
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {flash && <div className="mb-4"><Notice kind="success">{flash}</Notice></div>}

      <div className="space-y-6">
        <ProfileSection producer={producer} isAdmin={isAdmin} onSave={(data) => runWrite(() => api.updateProducer(producer.id, data), 'Producer saved')} />

        <MembershipsSection
          producer={producer}
          memberships={memberships}
          markets={markets}
          isAdmin={isAdmin}
          canAct={(marketId) => canAccessMarket(user, marketId)}
          marketName={marketName}
          onTransition={(m, to) => runWrite(() => api.updateMembership(m.id, { status: to }), `${marketName(m.market_id)}: ${to.replace(/_/g, ' ')}`)}
          onFeePlan={(m, fee_plan) => runWrite(() => api.updateMembership(m.id, { fee_plan }), 'Fee plan saved')}
          onAdd={(market_id, status) => runWrite(() => api.createMembership({ producer_id: producer.id, market_id, status }), `Added to ${marketName(market_id)}`)}
        />

        <CheckinsSection checkins={checkins} summary={summary} isAdmin={isAdmin} marketName={marketName} />
      </div>
    </AdminShell>
  );
}

/* ─── Profile ─── */

function ProfileSection({ producer, isAdmin, onSave }: { producer: Producer; isAdmin: boolean; onSave: (d: Parameters<typeof api.updateProducer>[1]) => Promise<boolean> }) {
  const [businessName, setBusinessName] = useState(producer.business_name);
  const [contactName, setContactName] = useState(producer.contact_name || '');
  const [phone, setPhone] = useState(producer.phone || '');
  const [email, setEmail] = useState(producer.email || '');
  const [category, setCategory] = useState(producer.category || '');
  const [notes, setNotes] = useState(producer.notes || '');
  const [active, setActive] = useState(producer.active);
  const [aliases, setAliases] = useState<string[]>(producer.aliases || []);
  const [emails, setEmails] = useState<string[]>(producer.emails || []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBusinessName(producer.business_name);
    setContactName(producer.contact_name || '');
    setPhone(producer.phone || '');
    setEmail(producer.email || '');
    setCategory(producer.category || '');
    setNotes(producer.notes || '');
    setActive(producer.active);
    setAliases(producer.aliases || []);
    setEmails(producer.emails || []);
  }, [producer]);

  const renamed = businessName.trim() !== producer.business_name;

  const save = async () => {
    setSaving(true);
    const data: Parameters<typeof api.updateProducer>[1] = {
      business_name: businessName.trim(),
      contact_name: contactName.trim(),
      phone: phone.trim() ? normalizePhone(phone) : null,
      email: email.trim() ? email.trim().toLowerCase() : null,
      category: category.trim(),
      active,
      aliases: aliases.filter((a) => a !== businessName.trim()),
      emails,
    };
    if (isAdmin) data.notes = notes;
    await onSave(data);
    setSaving(false);
  };

  const readOnly = !isAdmin;

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4 mt-0">Profile</h3>
      {readOnly && <div className="mb-3"><Notice kind="info">Producer records are edited by SJCA administrators.</Notice></div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Field label="Business name" value={businessName} onChange={setBusinessName} disabled={readOnly} />
          {renamed && <div className="text-[11px] text-earth-500 mt-1">Renaming keeps &ldquo;{producer.business_name}&rdquo; as an alias automatically.</div>}
        </div>
        <Field label="Contact name" value={contactName} onChange={setContactName} disabled={readOnly} />
        <Field label="Phone" type="tel" value={phone} onChange={setPhone} disabled={readOnly} placeholder={readOnly ? '' : '(501) 555-0100'} />
        <Field label="Primary email" type="email" value={email} onChange={setEmail} disabled={readOnly} />
        <Field label="Category" value={category} onChange={setCategory} disabled={readOnly} />
        <div className="flex items-end pb-2">
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={readOnly} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <ListEditor
          label="Aliases"
          hint="Other names this producer has used on forms."
          items={aliases}
          onChange={setAliases}
          placeholder="Add an alias"
          disabled={readOnly}
        />
        <ListEditor
          label="Emails"
          hint="Every address ever seen; applications are matched by email."
          items={emails}
          onChange={setEmails}
          placeholder="name@example.com"
          type="email"
          disabled={readOnly}
        />
      </div>

      {isAdmin && (
        <div className="mt-4">
          <TextArea label="Notes (admin only)" value={notes} onChange={setNotes} />
        </div>
      )}

      <div className="mt-4 text-[12px] text-text-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>SMS consent: <strong className="capitalize">{producer.sms_consent?.status?.replace(/_/g, ' ') || 'unknown'}</strong>{producer.sms_consent?.source ? ` (${producer.sms_consent.source})` : ''}</span>
        {producer.sms_opt_out_at && <span>Opted out {formatStamp(producer.sms_opt_out_at)}</span>}
        <span>Created {formatStamp(producer.created_at)}</span>
      </div>

      {!readOnly && <SaveBar saving={saving} onSave={save} />}
    </div>
  );
}

/* ─── Memberships ─── */

function MembershipsSection({
  producer,
  memberships,
  markets,
  isAdmin,
  canAct,
  marketName,
  onTransition,
  onFeePlan,
  onAdd,
}: {
  producer: Producer;
  memberships: Membership[];
  markets: Market[];
  isAdmin: boolean;
  canAct: (marketId: string) => boolean;
  marketName: (id: string) => string;
  onTransition: (m: Membership, to: MembershipStatus) => Promise<boolean>;
  onFeePlan: (m: Membership, plan: FeePlan) => Promise<boolean>;
  onAdd: (marketId: string, status: MembershipStatus) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [addMarket, setAddMarket] = useState('');
  const [addStatus, setAddStatus] = useState<MembershipStatus>('approved');
  const [adding, setAdding] = useState(false);

  const available = markets.filter((m) => !memberships.some((mm) => mm.market_id === m.id));

  useEffect(() => {
    if (!addMarket && available.length > 0) setAddMarket(available[0].id);
    if (addMarket && !available.some((m) => m.id === addMarket)) setAddMarket(available[0]?.id || '');
  }, [available, addMarket]);

  const act = async (m: Membership, to: MembershipStatus) => {
    setBusy(`${m.id}:${to}`);
    await onTransition(m, to);
    setBusy(null);
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4 mt-0">Memberships</h3>
      {memberships.length === 0 ? (
        <p className="text-sm text-earth-400 m-0">{producer.business_name} is not a member of any market.</p>
      ) : (
        <div className="space-y-3">
          {memberships.map((m) => {
            const allowed = canAct(m.market_id);
            const next = MEMBERSHIP_TRANSITIONS[m.status] || [];
            return (
              <div key={m.id} className="rounded-xl border border-earth-100 bg-earth-15 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/admin/markets/detail?id=${encodeURIComponent(m.market_id)}`} className="font-semibold text-green-700 no-underline hover:underline">{marketName(m.market_id)}</Link>
                    <StatusChip status={m.status} />
                    <span className="text-[11px] text-text-muted">{m.source}</span>
                  </div>
                  <div className="text-[12px] text-text-muted mt-0.5">
                    {m.approved_at ? `Approved ${formatStamp(m.approved_at)}` : 'Not yet approved'}
                    {m.history?.length > 0 && ` · ${m.history.length} change${m.history.length === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {allowed ? (
                    <select
                      value={m.fee_plan}
                      onChange={(e) => onFeePlan(m, e.target.value as FeePlan)}
                      className="px-2 py-1.5 rounded-lg border text-xs font-medium cursor-pointer"
                      style={{ borderColor: '#E4DFD3', color: '#3d3428', background: '#fff' }}
                      aria-label="Fee plan"
                    >
                      <option value="weekly">weekly</option>
                      <option value="season">season</option>
                      <option value="both">both</option>
                    </select>
                  ) : (
                    <span className="text-[12px] text-text-muted">{m.fee_plan}</span>
                  )}
                  {allowed && next.map((to) => (
                    <button
                      key={to}
                      type="button"
                      onClick={() => act(m, to)}
                      disabled={busy !== null}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border capitalize disabled:opacity-40"
                      style={to === 'inactive' ? { borderColor: '#fecaca', color: '#dc2626', background: '#fff' } : { borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}
                    >
                      {busy === `${m.id}:${to}` ? '…' : `→ ${to.replace(/_/g, ' ')}`}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAdmin && available.length > 0 && (
        <div className="mt-4 pt-4 border-t border-earth-100 grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2 items-end">
          <SelectField label="Add to market" value={addMarket} onChange={setAddMarket} options={available.map((m) => ({ value: m.id, label: m.name }))} />
          <SelectField label="Starting status" value={addStatus} onChange={(v) => setAddStatus(v as MembershipStatus)} options={['approved', 'active', 'applied', 'under_review'].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
          <PrimaryButton
            onClick={async () => {
              if (!addMarket) return;
              setAdding(true);
              await onAdd(addMarket, addStatus);
              setAdding(false);
            }}
            disabled={adding || !addMarket}
          >
            {adding ? 'Adding…' : 'Add'}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

/* ─── Check-ins ─── */

function CheckinsSection({
  checkins,
  summary,
  isAdmin,
  marketName,
}: {
  checkins: Checkin[];
  summary: { count: number; last_submitted_at: string | null } | null;
  isAdmin: boolean;
  marketName: (id: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? checkins : checkins.slice(0, 10);
  const dateOf = (c: Checkin) => c.market_date_id.slice(c.market_id.length + 1);
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  const money = (c: Checkin) => {
    const s = c.estimated_sales;
    if (!s) return '—';
    if (s.value === null) return s.raw || '—';
    return `$${s.value.toLocaleString()}${s.kind === 'range' ? ' (mid)' : ''}`;
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-base font-bold text-earth-800 m-0">Recent check-ins</h3>
        <span className="text-[12px] text-text-muted">
          {summary ? `${summary.count} total · last ${formatStamp(summary.last_submitted_at)}` : ''}
        </span>
      </div>
      <TableCard minWidth={isAdmin ? 820 : 700}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Market day</Th>
            <Th>Submitted</Th>
            {isAdmin && <Th>Sales</Th>}
            <Th>Transactions</Th>
            <Th>Attending next</Th>
            <Th>Sold out</Th>
            <Th>Unsold</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={isAdmin ? 7 : 6}>No check-ins yet.</EmptyRow>
          ) : (
            rows.map((c) => (
              <tr key={c.id} className="border-b border-border-light last:border-none">
                <Td>
                  <div className="font-mono text-[12px]">{dateOf(c)}</div>
                  <div className="text-[11px] text-text-muted">{marketName(c.market_id)}{c.flags?.length ? ` · ${c.flags.join(', ')}` : ''}</div>
                </Td>
                <Td><span className="text-[12px]">{formatStamp(c.submitted_at)}</span></Td>
                {isAdmin && <Td><span className="font-mono text-[12px]">{money(c)}</span></Td>}
                <Td>{c.transactions_estimate?.value ?? (c.transactions_estimate?.raw || '—')}</Td>
                <Td>{yesNo(c.attending_next)}</Td>
                <Td><span className="text-[12px]">{c.sold_out_items?.length ? c.sold_out_items.join(', ') : c.sold_out_raw || '—'}</span></Td>
                <Td><span className="text-[12px]">{c.unsold_items?.length ? c.unsold_items.join(', ') : c.unsold_raw || '—'}</span></Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
      {checkins.length > 10 && (
        <div className="mt-3">
          <SecondaryButton small onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${checkins.length}`}</SecondaryButton>
        </div>
      )}
    </div>
  );
}
