'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { useRouter } from 'next/navigation';

/* ─── Types ─── */
interface UserRow {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  role: string;
  farm_name: string | null;
  market_name: string | null;
  message_count: number;
  order_count: number;
  inventory_count: number;
  last_message_at: string | null;
  created_at: string;
}

interface Broadcast {
  id: string;
  audience: string;
  message: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
}

type Tab = 'utilization' | 'broadcast' | 'history';

/* ─── Helpers ─── */
function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function roleBadge(role: string) {
  const colors: Record<string, { bg: string; text: string }> = {
    farmer: { bg: '#EBF4E6', text: '#2A5E33' },
    market: { bg: '#DBEAFE', text: '#1E40AF' },
    both: { bg: '#FDE68A', text: '#92400E' },
    admin: { bg: '#FCE7F3', text: '#9D174D' },
  };
  const c = colors[role] || { bg: '#F3F4F6', text: '#6B7280' };
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}
    >
      {role}
    </span>
  );
}

/* ─── Component ─── */
export default function AdminPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('utilization');

  // Utilization state
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [sortField, setSortField] = useState<keyof UserRow>('last_message_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filterRole, setFilterRole] = useState<string>('');

  // Broadcast state
  const [audience, setAudience] = useState<'farmers' | 'markets' | 'all'>('all');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<any>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  // History state
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Auth guard: redirect non-admin
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    } else if (!isLoading && isAuthenticated && user?.role !== 'admin') {
      router.push('/farmer');
    }
  }, [isLoading, isAuthenticated, user, router]);

  // Load utilization data
  const loadUtilization = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const data = await api.getUtilization();
      setUsers(data.users || []);
    } catch (err) {
      console.error('Failed to load utilization:', err);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  // Load broadcast history
  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const data = await api.getBroadcasts();
      setBroadcasts(data.broadcasts || []);
    } catch (err) {
      console.error('Failed to load broadcast history:', err);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') {
      if (tab === 'utilization') loadUtilization();
      if (tab === 'history') loadHistory();
    }
  }, [user, tab, loadUtilization, loadHistory]);

  // Sorting
  const handleSort = (field: keyof UserRow) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sortedUsers = [...users]
    .filter(u => !filterRole || u.role === filterRole)
    .sort((a, b) => {
      const aVal = a[sortField] ?? '';
      const bVal = b[sortField] ?? '';
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });

  // Broadcast send
  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setSendResult(null);
    try {
      const result = await api.sendBroadcast({ audience, message: message.trim() });
      setSendResult(result);
      setMessage('');
      setConfirmSend(false);
    } catch (err: any) {
      setSendResult({ error: err.message || 'Failed to send' });
    } finally {
      setSending(false);
    }
  };

  // Guard rendering
  if (isLoading || !isAuthenticated || user?.role !== 'admin') {
    return (
      <div className="min-h-screen" style={{ background: '#faf8f5' }}>
        <Header />
        <div className="flex items-center justify-center h-64">
          <div className="animate-pulse text-[#8a7e72]">
            {isLoading ? 'Loading...' : 'Access denied'}
          </div>
        </div>
      </div>
    );
  }

  // Summary stats
  const totalUsers = users.filter(u => u.role !== 'admin').length;
  const farmerCount = users.filter(u => u.role === 'farmer' || u.role === 'both').length;
  const marketCount = users.filter(u => u.role === 'market' || u.role === 'both').length;
  const totalMessages = users.reduce((s, u) => s + u.message_count, 0);
  const totalOrders = users.reduce((s, u) => s + u.order_count, 0);
  const activeThisWeek = users.filter(u => {
    if (!u.last_message_at) return false;
    const d = new Date(u.last_message_at);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return d >= weekAgo;
  }).length;

  return (
    <div className="min-h-screen" style={{ background: '#faf8f5' }}>
      <Header />

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold" style={{ color: '#1B3F24' }}>
            Admin Dashboard
          </h1>
          <p className="text-sm mt-1" style={{ color: '#8a7e72' }}>
            Platform utilization and broadcast messaging
          </p>
        </div>

        {/* Tab bar */}
        <div className="flex gap-2 mb-6">
          {([
            { id: 'utilization' as Tab, label: 'Utilization' },
            { id: 'broadcast' as Tab, label: 'Broadcast Message' },
            { id: 'history' as Tab, label: 'Broadcast History' },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer border-none transition-colors"
              style={{
                background: tab === t.id ? '#2A5E33' : '#F2EEE5',
                color: tab === t.id ? '#fff' : '#5C5C5C',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ══════ UTILIZATION TAB ══════ */}
        {tab === 'utilization' && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-6">
              {[
                { label: 'Total Users', val: totalUsers, color: '#2A5E33' },
                { label: 'Farmers', val: farmerCount, color: '#2A5E33' },
                { label: 'Markets', val: marketCount, color: '#3B7DD8' },
                { label: 'Messages', val: totalMessages, color: '#C9622F' },
                { label: 'Orders', val: totalOrders, color: '#9333EA' },
                { label: 'Active (7d)', val: activeThisWeek, color: '#059669' },
              ].map(s => (
                <div key={s.label} className="bg-white rounded-xl p-4 border border-border-light" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{s.label}</div>
                  <div className="font-mono text-2xl font-bold mt-1" style={{ color: s.color }}>{s.val}</div>
                </div>
              ))}
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3 mb-4">
              <select
                value={filterRole}
                onChange={e => setFilterRole(e.target.value)}
                className="px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer"
                style={{ borderColor: '#E4DFD3', color: '#3d3428', background: '#fff' }}
              >
                <option value="">All Roles</option>
                <option value="farmer">Farmers</option>
                <option value="market">Markets</option>
                <option value="both">Both</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={loadUtilization}
                disabled={loadingUsers}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border-none"
                style={{ background: '#EBF4E6', color: '#2A5E33' }}
              >
                {loadingUsers ? 'Loading...' : 'Refresh'}
              </button>
              <span className="text-xs text-text-muted ml-auto">
                {sortedUsers.length} user{sortedUsers.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Users table */}
            {loadingUsers ? (
              <div className="text-center py-12 text-text-muted text-sm">Loading utilization data...</div>
            ) : (
              <div className="bg-white rounded-xl border border-border-light overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left" style={{ minWidth: 900 }}>
                    <thead>
                      <tr className="border-b border-border-light">
                        {[
                          { key: 'name' as keyof UserRow, label: 'User' },
                          { key: 'role' as keyof UserRow, label: 'Role' },
                          { key: 'farm_name' as keyof UserRow, label: 'Farm / Market' },
                          { key: 'message_count' as keyof UserRow, label: 'Messages' },
                          { key: 'order_count' as keyof UserRow, label: 'Orders' },
                          { key: 'inventory_count' as keyof UserRow, label: 'Inventory' },
                          { key: 'last_message_at' as keyof UserRow, label: 'Last Active' },
                          { key: 'created_at' as keyof UserRow, label: 'Joined' },
                        ].map(col => (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted cursor-pointer hover:text-text whitespace-nowrap"
                            style={{ background: '#FAFAF8' }}
                          >
                            {col.label}
                            {sortField === col.key && (
                              <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map((u, i) => (
                        <tr
                          key={u.id}
                          className="border-b border-border-light last:border-none hover:bg-bg-alt transition-colors"
                          style={{ animation: `fadeUp 0.2s ease ${i * 0.02}s both` }}
                        >
                          <td className="px-4 py-3">
                            <div className="font-sans text-[14px] font-semibold text-text">{u.name}</div>
                            <div className="font-sans text-[11px] text-text-muted">{u.phone}</div>
                          </td>
                          <td className="px-4 py-3">{roleBadge(u.role)}</td>
                          <td className="px-4 py-3">
                            <div className="font-sans text-[13px] text-text">
                              {u.farm_name || u.market_name || '—'}
                            </div>
                            {u.farm_name && u.market_name && (
                              <div className="font-sans text-[11px] text-text-muted">{u.market_name}</div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-[14px] font-semibold" style={{ color: u.message_count > 0 ? '#C9622F' : '#ccc' }}>
                              {u.message_count}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-[14px] font-semibold" style={{ color: u.order_count > 0 ? '#9333EA' : '#ccc' }}>
                              {u.order_count}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-[14px] font-semibold" style={{ color: u.inventory_count > 0 ? '#2A5E33' : '#ccc' }}>
                              {u.inventory_count}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-sans text-[13px]" style={{ color: u.last_message_at ? '#3d3428' : '#ccc' }}>
                              {timeAgo(u.last_message_at)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-sans text-[12px] text-text-muted">
                              {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* ══════ BROADCAST TAB ══════ */}
        {tab === 'broadcast' && (
          <div className="max-w-[640px]">
            <div className="bg-white rounded-xl p-6 border border-border-light" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <h2 className="font-display font-bold text-lg mb-1" style={{ color: '#1B3F24' }}>
                Send Broadcast SMS
              </h2>
              <p className="text-sm mb-5" style={{ color: '#8a7e72' }}>
                This will send an SMS to every user in the selected audience. Messages are sent individually.
              </p>

              {/* Audience selector */}
              <div className="mb-4">
                <label className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide block mb-2">
                  Audience
                </label>
                <div className="flex gap-2">
                  {([
                    { id: 'all' as const, label: 'All Users', count: totalUsers },
                    { id: 'farmers' as const, label: 'Farmers', count: farmerCount },
                    { id: 'markets' as const, label: 'Markets', count: marketCount },
                  ]).map(a => (
                    <button
                      key={a.id}
                      onClick={() => setAudience(a.id)}
                      className="flex-1 rounded-lg py-3 border-2 cursor-pointer font-sans text-[14px] font-semibold transition-all"
                      style={{
                        background: audience === a.id ? '#EBF4E6' : '#fff',
                        borderColor: audience === a.id ? '#2A5E33' : '#E4DFD3',
                        color: audience === a.id ? '#2A5E33' : '#5C5C5C',
                      }}
                    >
                      {a.label}
                      <span className="block font-mono text-[12px] mt-0.5 font-normal" style={{ color: '#8a7e72' }}>
                        {a.count} user{a.count !== 1 ? 's' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Message input */}
              <div className="mb-4">
                <label className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide block mb-2">
                  Message
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Type your broadcast message..."
                  rows={4}
                  maxLength={1600}
                  className="w-full px-4 py-3 rounded-xl border text-[15px] outline-none resize-y font-sans leading-relaxed"
                  style={{ borderColor: '#E4DFD3', color: '#3d3428' }}
                />
                <div className="text-right text-[11px] mt-1" style={{ color: message.length > 1500 ? '#BC4639' : '#8a7e72' }}>
                  {message.length} / 1,600
                </div>
              </div>

              {/* Send / confirm */}
              {!confirmSend ? (
                <button
                  onClick={() => setConfirmSend(true)}
                  disabled={!message.trim()}
                  className="w-full h-12 rounded-xl font-sans text-[15px] font-semibold border-none cursor-pointer text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  style={{ background: 'linear-gradient(135deg, #2A5E33 0%, #3D7A47 100%)' }}
                >
                  Preview &amp; Send
                </button>
              ) : (
                <div className="rounded-xl border-2 p-4" style={{ borderColor: '#C9622F', background: '#FFF8F3' }}>
                  <div className="font-sans text-[14px] font-semibold mb-2" style={{ color: '#C9622F' }}>
                    Confirm broadcast
                  </div>
                  <p className="text-[13px] mb-3 leading-relaxed" style={{ color: '#3d3428' }}>
                    This will send the following message to <strong>{audience === 'all' ? totalUsers : audience === 'farmers' ? farmerCount : marketCount}</strong> {audience === 'all' ? 'users' : audience}:
                  </p>
                  <div className="bg-white rounded-lg p-3 mb-3 border text-[13px] leading-relaxed" style={{ borderColor: '#E4DFD3', color: '#3d3428' }}>
                    {message}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmSend(false)}
                      className="flex-1 h-11 rounded-lg font-sans text-[14px] font-semibold border cursor-pointer"
                      style={{ borderColor: '#E4DFD3', color: '#5C5C5C', background: '#fff' }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSend}
                      disabled={sending}
                      className="flex-1 h-11 rounded-lg font-sans text-[14px] font-semibold border-none cursor-pointer text-white disabled:opacity-50"
                      style={{ background: '#C9622F' }}
                    >
                      {sending ? 'Sending...' : 'Send Now'}
                    </button>
                  </div>
                </div>
              )}

              {/* Result */}
              {sendResult && (
                <div
                  className="mt-4 rounded-xl p-4 text-sm"
                  style={{
                    background: sendResult.error ? '#FEF2F2' : '#D1FAE5',
                    color: sendResult.error ? '#DC2626' : '#065F46',
                  }}
                >
                  {sendResult.error ? (
                    <p><strong>Error:</strong> {sendResult.error}</p>
                  ) : (
                    <>
                      <p className="font-semibold mb-1">Broadcast sent successfully</p>
                      <p>
                        {sendResult.sent} of {sendResult.total} messages delivered
                        {sendResult.failed > 0 && <span className="text-red-600"> ({sendResult.failed} failed)</span>}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════ HISTORY TAB ══════ */}
        {tab === 'history' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-text-muted">{broadcasts.length} broadcast{broadcasts.length !== 1 ? 's' : ''} sent</span>
              <button
                onClick={loadHistory}
                disabled={loadingHistory}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border-none"
                style={{ background: '#EBF4E6', color: '#2A5E33' }}
              >
                {loadingHistory ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {loadingHistory ? (
              <div className="text-center py-12 text-text-muted text-sm">Loading...</div>
            ) : broadcasts.length === 0 ? (
              <div className="text-center py-12 text-text-muted text-sm bg-white rounded-xl border border-border-light">
                No broadcasts sent yet
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {broadcasts.map((b, i) => {
                  const audienceLabel = b.audience === 'all' ? 'All Users' : b.audience === 'farmers' ? 'Farmers' : 'Markets';
                  return (
                    <div
                      key={b.id}
                      className="bg-white rounded-xl p-4 border border-border-light"
                      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)', animation: `fadeUp 0.2s ease ${i * 0.03}s both` }}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                            style={{ background: '#EBF4E6', color: '#2A5E33' }}
                          >
                            {audienceLabel}
                          </span>
                          <span className="text-[12px] text-text-muted">
                            {b.sent_count}/{b.recipient_count} sent
                            {b.failed_count > 0 && (
                              <span className="text-red-500 ml-1">({b.failed_count} failed)</span>
                            )}
                          </span>
                        </div>
                        <span className="text-[12px] text-text-muted whitespace-nowrap">
                          {b.created_at ? new Date(b.created_at).toLocaleString() : '—'}
                        </span>
                      </div>
                      <p className="text-[14px] leading-relaxed" style={{ color: '#3d3428' }}>
                        {b.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
