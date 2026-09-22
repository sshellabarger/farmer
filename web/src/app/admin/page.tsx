'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { DashboardCard, Providers } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { Notice, SecondaryButton } from '@/components/form';
import { AdminShell, LoadingScreen, formatDateLabel, formatTime12h, weekdayLabel } from '@/components/admin-shell';

/** Staff dashboard (contract §8.3): one card per market the user can see. */
export default function DashboardPage() {
  const { ready, isAdmin } = useStaffGuard();
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getDashboard();
      setCards(data.markets || []);
      setGeneratedAt(data.generated_at || null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
    if (isAdmin) {
      // Managers get 403 here; anyone may see a transient error. Either way
      // the banner is just a hint, so failures are swallowed.
      api.getProviders().then(setProviders).catch(() => setProviders(null));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!ready) return <LoadingScreen />;

  return (
    <AdminShell
      title="Dashboard"
      subtitle={generatedAt ? `Updated ${new Date(generatedAt).toLocaleTimeString()}` : 'Markets, next dates and check-in progress'}
      actions={<SecondaryButton small onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</SecondaryButton>}
    >
      {providers && providers.real_sends_possible === false && (
        <div className="mb-5">
          <Notice kind="warning">
            <strong>Test mode</strong> — texts and emails are simulated (SMS provider: {providers.sms_provider}, email: {providers.email_provider}).
          </Notice>
        </div>
      )}

      {error && (
        <div className="mb-5">
          <Notice kind="error">{error}</Notice>
        </div>
      )}

      {loading && cards.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading markets…</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border bg-white" style={{ borderColor: '#E4DFD3' }}>
          <p className="text-lg mb-2 mt-0" style={{ color: '#3d3428' }}>No markets yet</p>
          <p className="text-sm m-0" style={{ color: '#8a7e72' }}>
            {isAdmin ? (
              <>Create one under <Link href="/admin/markets" className="text-green-700 font-semibold">Markets</Link>.</>
            ) : (
              <>You have not been assigned to a market yet. Ask an SJCA administrator.</>
            )}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((card) => (
            <MarketCard key={card.market.id} card={card} />
          ))}
        </div>
      )}
    </AdminShell>
  );
}

function MarketCard({ card }: { card: DashboardCard }) {
  const { market, next_date, collecting_date, progress, upcoming_count } = card;
  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;

  return (
    <div className="bg-white rounded-2xl border border-border-light p-5 flex flex-col gap-4" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold m-0" style={{ color: '#1B3F24' }}>{market.name}</h2>
          <div className="text-[12px] text-text-muted mt-0.5">
            {market.timezone} · {upcoming_count} upcoming date{upcoming_count === 1 ? '' : 's'}
          </div>
        </div>
        {!market.active && <StatusChip status="inactive" />}
      </div>

      {/* Next date */}
      <div className="rounded-xl p-3 bg-earth-15 border border-earth-100">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">Next market day</div>
        {next_date ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[15px] text-text">
              {weekdayLabel(next_date.date)}, {formatDateLabel(next_date.date)}
            </span>
            <span className="text-[13px] text-text-soft">
              {formatTime12h(next_date.start_time)}–{formatTime12h(next_date.end_time)}
            </span>
            <StatusChip status={next_date.status} />
            {next_date.special && <StatusChip status="special" />}
          </div>
        ) : (
          <div className="text-sm text-text-muted">No upcoming date scheduled</div>
        )}
      </div>

      {/* Collecting */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">Check-ins</div>
        {collecting_date ? (
          <>
            <div className="flex items-center justify-between text-[13px] mb-1.5">
              <span className="text-text">
                Collecting:{' '}
                <Link href={`/admin/market-dates?id=${encodeURIComponent(collecting_date.id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                  {formatDateLabel(collecting_date.date)}
                </Link>
              </span>
              {progress && (
                <span className="font-mono text-text-soft">
                  {progress.checkins}/{progress.active_memberships} ({percent}%)
                </span>
              )}
            </div>
            <div className="h-2 rounded-full bg-earth-100 overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full" style={{ width: `${percent}%`, background: 'linear-gradient(90deg, #2A5E33, #559B61)', animation: 'growBar 0.6s ease' }} />
            </div>
          </>
        ) : (
          <div className="text-sm text-text-muted">Nothing being collected right now</div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1 border-t border-border-light">
        <Link href={`/admin/markets/detail?id=${encodeURIComponent(market.id)}`} className="px-3 py-1.5 rounded-lg text-xs font-semibold no-underline border" style={{ borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}>
          Market details
        </Link>
        <Link href={`/admin/producers?market_id=${encodeURIComponent(market.id)}`} className="px-3 py-1.5 rounded-lg text-xs font-semibold no-underline border" style={{ borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}>
          Producers
        </Link>
      </div>
    </div>
  );
}
