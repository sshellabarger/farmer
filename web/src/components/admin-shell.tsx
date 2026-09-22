'use client';

import type { ReactNode } from 'react';
import { Header } from './header';

/** Page chrome shared by the staff screens: header, width, title row. */
export function AdminShell({
  title,
  subtitle,
  actions,
  width = 1200,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen" style={{ background: '#faf8f5' }}>
      <Header />
      <div className="mx-auto px-4 sm:px-6 py-6" style={{ maxWidth: width }}>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold m-0" style={{ color: '#1B3F24' }}>
              {title}
            </h1>
            {subtitle && (
              <p className="text-sm mt-1 mb-0" style={{ color: '#8a7e72' }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Loading placeholder used while a guard or fetch resolves. */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="min-h-screen" style={{ background: '#faf8f5' }}>
      <Header />
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-[#8a7e72]">{label}</div>
      </div>
    </div>
  );
}

/** Table wrapper with the shared card styling. */
export function TableCard({ children, minWidth = 720 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="bg-white rounded-xl border border-border-light overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div className="overflow-x-auto">
        <table className="w-full text-left" style={{ minWidth }}>
          {children}
        </table>
      </div>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap ${className}`}
      style={{ background: '#FAFAF8' }}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 text-[13.5px] text-text align-top ${className}`}>{children}</td>;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-text-muted">
        {children}
      </td>
    </tr>
  );
}

/** Friendly market-local date label from 'YYYY-MM-DD' (no browser tz math). */
export function formatDateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** Calendar weekday of a 'YYYY-MM-DD' string (zone-independent). */
export function weekdayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return DAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

/** 'HH:mm' (24 h) → '8:00 AM'. */
export function formatTime12h(time: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${m[2]} ${ampm}`;
}

/** ISO timestamp → short local string, or '—'. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
