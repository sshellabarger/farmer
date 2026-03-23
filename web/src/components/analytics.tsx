'use client';

import { Icon } from './icons';
import { Card, SectionTitle, MiniBarChart } from './ui';
import { WEEKLY_SALES, TOP_PRODUCTS } from '@/lib/demo-data';

const MARKET_BREAKDOWN = [
  { name: 'ABC Market', rev: 1240, pct: 38, orders: 18 },
  { name: 'River Market', rev: 890, pct: 27, orders: 12 },
  { name: 'Hillcrest Co-op', rev: 620, pct: 19, orders: 9 },
  { name: 'Heights Corner', rev: 514, pct: 16, orders: 7 },
];

export function Analytics() {
  const weekTotal = WEEKLY_SALES.reduce((s, d) => s + d.revenue, 0);

  return (
    <div>
      <SectionTitle>Sales Analytics</SectionTitle>
      <div className="grid grid-cols-2 gap-3.5">
        {/* Weekly Revenue */}
        <Card style={{ padding: 18 }}>
          <div className="text-xs font-bold text-earth-500 uppercase tracking-wide mb-3.5">This Week&apos;s Revenue</div>
          <div className="text-[28px] font-extrabold text-earth-900 font-display mb-1">
            ${weekTotal.toLocaleString()}
          </div>
          <div className="text-xs text-[#2e7d32] font-semibold mb-4 flex items-center gap-1">
            <Icon name="trendUp" size={13} /> +15% vs last week
          </div>
          <MiniBarChart data={WEEKLY_SALES} valueKey="revenue" labelKey="day" />
        </Card>

        {/* Top Products */}
        <Card style={{ padding: 18 }}>
          <div className="text-xs font-bold text-earth-500 uppercase tracking-wide mb-3.5">Top Products (This Month)</div>
          <div className="flex flex-col gap-2.5">
            {TOP_PRODUCTS.map((p, i) => {
              const maxRev = TOP_PRODUCTS[0].revenue;
              return (
                <div key={i}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[12.5px] font-semibold text-earth-900">{p.product}</span>
                    <span
                      className="text-xs font-bold"
                      style={{ color: p.trend.startsWith('+') ? '#2e7d32' : '#e65100' }}
                    >
                      {p.trend}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-earth-50 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(p.revenue / maxRev) * 100}%`,
                          background: 'linear-gradient(90deg, #2d5016, #4a7c28)',
                        }}
                      />
                    </div>
                    <span className="text-[11px] font-bold text-earth-700 min-w-[50px] text-right">${p.revenue}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Market Breakdown */}
      <Card style={{ padding: 18, marginTop: 14 }}>
        <div className="text-xs font-bold text-earth-500 uppercase tracking-wide mb-3.5">Revenue by Market</div>
        <div className="grid grid-cols-4 gap-3">
          {MARKET_BREAKDOWN.map((m, i) => (
            <div key={i} className="text-center p-3.5 bg-earth-15 rounded-[10px]">
              <div className="text-[22px] font-extrabold text-earth-900 font-display">${m.rev}</div>
              <div className="text-[11px] text-earth-500 mt-0.5">{m.orders} orders</div>
              <div className="w-full h-1 bg-earth-100 rounded-full mt-2 overflow-hidden">
                <div className="h-full bg-farm-600 rounded-full" style={{ width: `${m.pct}%` }} />
              </div>
              <div className="text-xs font-bold text-earth-900 mt-2">{m.name}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
