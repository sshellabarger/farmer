'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Market, StaffRole, StaffUser } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, Field, Notice, PrimaryButton, SecondaryButton } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatStamp } from '@/components/admin-shell';
import { normalizePhone } from '@/lib/phone';

/** Staff user management (admin only, contract §8.3): invite by text, edit role/markets/active. */
export default function StaffUsersPage() {
  const { ready } = useStaffGuard({ adminOnly: true });
  const { user: me } = useAuth();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, m] = await Promise.all([api.getStaffUsers(), api.getMarkets()]);
      setUsers(u.users || []);
      setMarkets(m.markets || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load staff users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const marketName = (id: string) => markets.find((m) => m.id === id)?.name || id;

  if (!ready) return <LoadingScreen />;

  return (
    <AdminShell
      title="Users"
      subtitle="Admins and market managers who can sign in to this dashboard"
      actions={
        <>
          <SecondaryButton small onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</SecondaryButton>
          <PrimaryButton small onClick={() => setShowInvite((v) => !v)}>{showInvite ? 'Cancel' : '+ Invite by text'}</PrimaryButton>
        </>
      }
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {toast && <div className="mb-4"><Notice kind="info">{toast}</Notice></div>}

      {showInvite && (
        <div className="mb-6">
          <InviteForm
            markets={markets}
            onInvited={(sms) => {
              setShowInvite(false);
              setToast(`Invite sent — SMS ${sms.status}${sms.error ? `: ${sms.error}` : ''}.`);
              load();
            }}
          />
        </div>
      )}

      <TableCard>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Name</Th>
            <Th>Phone</Th>
            <Th>Role</Th>
            <Th>Markets</Th>
            <Th>Active</Th>
            <Th>Invited</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {loading && users.length === 0 ? (
            <EmptyRow colSpan={7}>Loading users…</EmptyRow>
          ) : users.length === 0 ? (
            <EmptyRow colSpan={7}>No staff users yet.</EmptyRow>
          ) : (
            users.map((u) => (
              <UserRow
                key={u.id}
                staffUser={u}
                markets={markets}
                marketName={marketName}
                isSelf={u.id === me?.id}
                onChanged={load}
                onResent={(sms) => setToast(`Invite re-sent — SMS ${sms.status}${sms.error ? `: ${sms.error}` : ''}.`)}
                onError={setError}
              />
            ))
          )}
        </tbody>
      </TableCard>
    </AdminShell>
  );
}

function UserRow({
  staffUser,
  markets,
  marketName,
  isSelf,
  onChanged,
  onResent,
  onError,
}: {
  staffUser: StaffUser;
  markets: Market[];
  marketName: (id: string) => string;
  isSelf: boolean;
  onChanged: () => void;
  onResent: (sms: { status: string; error?: string }) => void;
  onError: (msg: string) => void;
}) {
  const u = staffUser;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<StaffRole>(u.role === 'admin' ? 'admin' : 'market_manager');
  const [assigned, setAssigned] = useState<string[]>(u.assigned_market_ids);

  const toggleMarket = (id: string) => setAssigned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    setBusy(true);
    onError('');
    try {
      await api.updateStaffUser(u.id, { role, assigned_market_ids: role === 'market_manager' ? assigned : [] });
      setEditing(false);
      onChanged();
    } catch (err: any) {
      onError(err?.message || 'Could not update the user');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    setBusy(true);
    onError('');
    try {
      await api.updateStaffUser(u.id, { active: !u.active });
      onChanged();
    } catch (err: any) {
      onError(err?.message || 'Could not update the user');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    onError('');
    try {
      const { sms } = await api.resendStaffInvite(u.id);
      onResent(sms);
      onChanged();
    } catch (err: any) {
      onError(err?.message || 'Could not resend the invite');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="border-b border-border-light last:border-none hover:bg-bg-alt transition-colors">
        <Td>
          <div className="font-semibold text-earth-800">{u.name}</div>
          {u.email && <div className="text-[12px] text-text-muted">{u.email}</div>}
        </Td>
        <Td className="font-mono text-[12px]">{u.phone}</Td>
        <Td><StatusChip status={u.role} /></Td>
        <Td>
          {u.role === 'admin' ? (
            <span className="text-[12px] text-text-muted">all markets</span>
          ) : u.assigned_market_ids.length === 0 ? (
            <span className="text-[12px] text-text-muted">none</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {u.assigned_market_ids.map((id) => (
                <span key={id} className="text-[12px] px-1.5 py-0.5 rounded bg-earth-50 border border-earth-100">{marketName(id)}</span>
              ))}
            </div>
          )}
        </Td>
        <Td>
          {isSelf ? (
            <span className="text-[12px] text-text-muted">you</span>
          ) : (
            <button
              type="button"
              onClick={toggleActive}
              disabled={busy}
              className="cursor-pointer border-none bg-transparent p-0"
              title={u.active ? 'Deactivate' : 'Reactivate'}
            >
              <StatusChip status={u.active ? 'active' : 'inactive'} />
            </button>
          )}
        </Td>
        <Td className="text-[12px] text-text-muted">{formatStamp(u.invited_at)}</Td>
        <Td className="text-right">
          <div className="flex gap-2 justify-end">
            <SecondaryButton small onClick={resend} disabled={busy}>Resend</SecondaryButton>
            {!isSelf && (
              <SecondaryButton small onClick={() => setEditing((v) => !v)} disabled={busy}>{editing ? 'Cancel' : 'Edit'}</SecondaryButton>
            )}
          </div>
        </Td>
      </tr>
      {editing && !isSelf && (
        <tr className="border-b border-border-light last:border-none bg-bg-alt/60">
          <td colSpan={7} className="px-4 py-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-semibold text-earth-500 mb-1">Role</label>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="radio" checked={role === 'admin'} onChange={() => setRole('admin')} /> Admin
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="radio" checked={role === 'market_manager'} onChange={() => setRole('market_manager')} /> Market manager
                  </label>
                </div>
              </div>
              {role === 'market_manager' && (
                <div>
                  <label className="block text-xs font-semibold text-earth-500 mb-1">Assigned markets</label>
                  <div className="flex flex-wrap gap-3">
                    {markets.map((m) => (
                      <CheckboxField key={m.id} label={m.name} checked={assigned.includes(m.id)} onChange={() => toggleMarket(m.id)} />
                    ))}
                  </div>
                </div>
              )}
              <PrimaryButton small onClick={save} disabled={busy || (role === 'market_manager' && assigned.length === 0)}>
                {busy ? 'Saving…' : 'Save'}
              </PrimaryButton>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function InviteForm({ markets, onInvited }: { markets: Market[]; onInvited: (sms: { status: string; error?: string }) => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('market_manager');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleMarket = (id: string) => setAssigned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    setError('');
    if (!phone.trim() || !name.trim()) { setError('Phone and name are required.'); return; }
    if (role === 'market_manager' && assigned.length === 0) { setError('Pick at least one market for a market manager.'); return; }
    setSaving(true);
    try {
      const { sms } = await api.inviteStaffUser({
        phone: normalizePhone(phone),
        name: name.trim(),
        role,
        assigned_market_ids: role === 'market_manager' ? assigned : [],
        email: email.trim() || undefined,
      });
      onInvited(sms);
    } catch (err: any) {
      setError(err?.message || 'Could not send the invite');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 space-y-4">
      <h2 className="font-display text-lg font-bold m-0" style={{ color: '#21512C' }}>Invite by text</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Phone" type="tel" value={phone} onChange={setPhone} placeholder="(501) 555-0100" />
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Email (optional)" type="email" value={email} onChange={setEmail} />
      </div>
      <div>
        <label className="block text-xs font-semibold text-earth-500 mb-1">Role</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="radio" checked={role === 'admin'} onChange={() => setRole('admin')} /> Admin
          </label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="radio" checked={role === 'market_manager'} onChange={() => setRole('market_manager')} /> Market manager
          </label>
        </div>
      </div>
      {role === 'market_manager' && (
        <div>
          <label className="block text-xs font-semibold text-earth-500 mb-1">Assigned markets</label>
          <div className="flex flex-wrap gap-3">
            {markets.length === 0 && <span className="text-sm text-earth-400">No markets yet.</span>}
            {markets.map((m) => (
              <CheckboxField key={m.id} label={m.name} checked={assigned.includes(m.id)} onChange={() => toggleMarket(m.id)} />
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Sending…' : 'Send invite'}</PrimaryButton>
      </div>
    </div>
  );
}
