'use client';

import { Icon } from './icons';

// ─── Status Badge ────────────────────────────────────────────────
const STATUS_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  available: { bg: '#e8f5e9', color: '#2e7d32', label: 'Available' },
  partial: { bg: '#fff3e0', color: '#e65100', label: 'Partial' },
  sold: { bg: '#eee', color: '#777', label: 'Sold Out' },
  confirmed: { bg: '#e8f5e9', color: '#2e7d32', label: 'Confirmed' },
  pending: { bg: '#fff8e1', color: '#f9a825', label: 'Pending' },
  delivered: { bg: '#e3f2fd', color: '#1565c0', label: 'Delivered' },
  'in-transit': { bg: '#f3e5f5', color: '#7b1fa2', label: 'In Transit' },
  in_transit: { bg: '#f3e5f5', color: '#7b1fa2', label: 'In Transit' },
};

export function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] || { bg: '#eee', color: '#666', label: status };
  return (
    <span
      className="inline-block rounded-full text-[10.5px] font-bold tracking-wide uppercase whitespace-nowrap"
      style={{ background: c.bg, color: c.color, padding: '3px 10px' }}
    >
      {c.label}
    </span>
  );
}

// ─── Card ────────────────────────────────────────────────────────
export function Card({ children, className = '', style, onClick }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div className={`bg-white rounded-xl border border-earth-100 ${className}`} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

// ─── Section Title ───────────────────────────────────────────────
export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center mb-3.5">
      <h3 className="m-0 text-earth-900 font-display font-bold text-base">{children}</h3>
      {action}
    </div>
  );
}

// ─── Button ──────────────────────────────────────────────────────
interface BtnProps {
  children: React.ReactNode;
  primary?: boolean;
  small?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function Btn({ children, primary, small, onClick, className = '', style }: BtnProps) {
  return (
    <button
      onClick={onClick}
      className={`border-none rounded-lg font-semibold cursor-pointer font-sans ${className}`}
      style={{
        background: primary ? 'linear-gradient(135deg, #2d5016, #4a7c28)' : '#f5f0ea',
        color: primary ? '#fff' : '#5a5044',
        padding: small ? '5px 12px' : '8px 16px',
        fontSize: small ? 11 : 12,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ─── Tab Bar ─────────────────────────────────────────────────────
interface TabItem {
  id: string;
  icon: string;
  label: string;
  badge?: number;
}

export function TabBar({ active, onNav, items }: { active: string; onNav: (id: string) => void; items: TabItem[] }) {
  return (
    <div className="flex gap-[3px] p-[3px] bg-earth-50 rounded-[10px] flex-wrap">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onNav(item.id)}
          className="flex items-center gap-[5px] rounded-[7px] border-none cursor-pointer font-sans transition-all duration-150"
          style={{
            padding: '7px 12px',
            background: active === item.id ? '#fff' : 'transparent',
            color: active === item.id ? '#2d5016' : '#8a7e72',
            fontWeight: active === item.id ? 700 : 500,
            fontSize: 12,
            boxShadow: active === item.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
          }}
        >
          <Icon name={item.icon} size={14} />
          {item.label}
          {(item.badge ?? 0) > 0 && (
            <span className="bg-[#e65100] text-white text-[9px] font-bold px-[5px] py-[1px] rounded-full">
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Mini Bar Chart ──────────────────────────────────────────────
export function MiniBarChart({
  data,
  valueKey,
  labelKey,
  color = '#4a7c28',
  height = 140,
}: {
  data: Record<string, any>[];
  valueKey: string;
  labelKey: string;
  color?: string;
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d[valueKey]));
  return (
    <div className="flex items-end gap-1.5 px-1" style={{ height }}>
      {data.map((d, i) => {
        const h = (d[valueKey] / max) * (height - 24);
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className="text-[9px] font-bold text-earth-700">${d[valueKey]}</div>
            <div
              className="w-full rounded-t min-h-1 transition-all duration-300"
              style={{ height: h, background: `linear-gradient(180deg, ${color}, ${color}88)` }}
            />
            <div className="text-[10px] text-earth-500 font-semibold">{d[labelKey]}</div>
          </div>
        );
      })}
    </div>
  );
}
