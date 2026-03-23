'use client';

import { useState, useEffect } from 'react';
import { Icon } from '@/components/icons';
import { Card } from '@/components/ui';
import { SMSChat } from '@/components/sms-chat';
import { Header } from '@/components/header';
import { api } from '@/lib/api';
import {
  FARMER_SCRIPTS, MARKET_SCRIPTS,
} from '@/lib/demo-data';

type View = 'home' | 'farmer-dash' | 'market-dash';

/* ─── Overview Stats (Live) ─── */
function OverviewStats() {
  const [stats, setStats] = useState({ revenue: 0, orders: 0, items: 0, farms: 0, markets: 0, deliveries: 0 });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [farms, markets, inventory, orders, deliveries] = await Promise.all([
          api.getAllFarms().catch(() => ({ farms: [] })),
          api.getAllMarkets().catch(() => ({ markets: [] })),
          api.getInventory().catch(() => ({ inventory: [] })),
          api.getOrders().catch(() => ({ orders: [] })),
          api.getDeliveries().catch(() => ({ deliveries: [] })),
        ]);
        const openOrders = (orders.orders || []).filter((o: any) => ['pending', 'confirmed', 'in_transit'].includes(o.status));
        const activeItems = (inventory.inventory || []).filter((i: any) => i.status !== 'sold');
        const activeDeliveries = (deliveries.deliveries || []).filter((d: any) => d.status !== 'completed' && d.status !== 'failed');
        const todayRevenue = openOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
        setStats({
          revenue: todayRevenue,
          orders: openOrders.length,
          items: activeItems.length,
          farms: (farms.farms || []).length,
          markets: (markets.markets || []).length,
          deliveries: activeDeliveries.length,
        });
      } catch { /* ignore */ }
      finally { setLoaded(true); }
    })();
  }, []);

  if (!loaded) return <div className="text-center py-4 text-earth-400 text-sm">Loading stats...</div>;

  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-2.5 mb-5">
      {[
        { label: "Revenue", value: `$${stats.revenue.toFixed(0)}`, icon: 'dollar', c: '#2e7d32' },
        { label: 'Open Orders', value: stats.orders, icon: 'cart', c: '#e65100' },
        { label: 'Items Listed', value: stats.items, icon: 'package', c: '#1565c0' },
        { label: 'Farms', value: stats.farms, icon: 'leaf', c: '#4a7c28' },
        { label: 'Markets', value: stats.markets, icon: 'store', c: '#7b1fa2' },
        { label: 'Deliveries', value: stats.deliveries, icon: 'truck', c: '#e6a700' },
      ].map((s, i) => (
        <Card key={i} style={{ padding: '14px 16px' }}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <div style={{ color: s.c, opacity: 0.7 }}><Icon name={s.icon} size={14} /></div>
            <span className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide">{s.label}</span>
          </div>
          <div className="text-2xl font-extrabold text-earth-900 font-display">{s.value}</div>
        </Card>
      ))}
    </div>
  );
}

/* ─── Main Page ─── */
export default function Home() {
  const [view, setView] = useState<View>('home');
  const [farmerDemoIdx, setFarmerDemoIdx] = useState(0);
  const [marketDemoIdx, setMarketDemoIdx] = useState(0);

  return (
    <div className="font-sans min-h-screen bg-earth-15">
      <Header />

      {/* Sub-nav */}
      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 pt-3">
        <div className="flex gap-[3px] overflow-x-auto pb-1 -mx-1 px-1">
          {[
            { id: 'home', label: 'Overview' },
            { id: 'farmer-dash', label: '🌱 Farmer' },
            { id: 'market-dash', label: '🏪 Market' },
          ].map((n) => (
            <button
              key={n.id}
              onClick={() => {
                if (n.id === 'farmer-dash') { window.location.href = '/farmer'; return; }
                if (n.id === 'market-dash') { window.location.href = '/market'; return; }
                setView(n.id as View);
              }}
              className="border rounded-lg text-[11px] font-semibold cursor-pointer font-sans transition-all whitespace-nowrap"
              style={{
                padding: '5px 12px',
                background: view === n.id ? '#2d501615' : 'transparent',
                borderColor: view === n.id ? '#2d501630' : 'transparent',
                color: view === n.id ? '#2d5016' : '#8b7355',
              }}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-5">
        {view === 'home' && (
          <div style={{ animation: 'fadeIn 0.25s ease' }}>
            {/* Live Stats */}
            <OverviewStats />

            {/* SMS Demo Columns */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              {/* Farmer SMS */}
              <div>
                <div className="mb-2">
                  <h3 className="m-0 font-display font-bold text-earth-900 text-[15px]">🌱 Farmer SMS</h3>
                </div>
                <div className="flex gap-1 mb-2.5 overflow-x-auto pb-1">
                  {FARMER_SCRIPTS.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => setFarmerDemoIdx(i)}
                      className="whitespace-nowrap border rounded-full text-[10px] font-semibold cursor-pointer font-sans transition-all"
                      style={{
                        padding: '4px 10px',
                        background: farmerDemoIdx === i ? '#2d5016' : 'transparent',
                        borderColor: farmerDemoIdx === i ? '#2d5016' : '#d4cdc2',
                        color: farmerDemoIdx === i ? '#fff' : '#8b7355',
                      }}
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
                <div className="h-[440px]">
                  <SMSChat
                    key={`farmer-${farmerDemoIdx}`}
                    script={FARMER_SCRIPTS[farmerDemoIdx].script}
                    userRole="farmer"
                    title={FARMER_SCRIPTS[farmerDemoIdx].farm}
                  />
                </div>
              </div>
              {/* Market SMS */}
              <div>
                <div className="mb-2">
                  <h3 className="m-0 font-display font-bold text-earth-900 text-[15px]">🏪 Market SMS</h3>
                </div>
                <div className="flex gap-1 mb-2.5 overflow-x-auto pb-1">
                  {MARKET_SCRIPTS.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => setMarketDemoIdx(i)}
                      className="whitespace-nowrap border rounded-full text-[10px] font-semibold cursor-pointer font-sans transition-all"
                      style={{
                        padding: '4px 10px',
                        background: marketDemoIdx === i ? '#1565c0' : 'transparent',
                        borderColor: marketDemoIdx === i ? '#1565c0' : '#d4cdc2',
                        color: marketDemoIdx === i ? '#fff' : '#8b7355',
                      }}
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
                <div className="h-[440px]">
                  <SMSChat
                    key={`market-${marketDemoIdx}`}
                    script={MARKET_SCRIPTS[marketDemoIdx].script}
                    userRole="market"
                    title={MARKET_SCRIPTS[marketDemoIdx].market}
                  />
                </div>
              </div>
            </div>

            {/* Platform Features */}
            <Card style={{ padding: 20 }}>
              <div className="text-xs font-bold text-earth-500 uppercase tracking-wide mb-3.5">Platform Features</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                {[
                  { icon: 'msg', title: 'Text-First', desc: 'Natural language SMS for all core actions' },
                  { icon: 'bell', title: 'Smart Alerts', desc: 'Proactive suggestions and reminders' },
                  { icon: 'users', title: 'Multi-Farm', desc: 'Markets browse across all connected farms' },
                  { icon: 'truck', title: 'Logistics', desc: 'Delivery scheduling and route coordination' },
                  { icon: 'repeat', title: 'Standing Orders', desc: 'Recurring orders with auto-fulfillment' },
                  { icon: 'chart', title: 'Analytics', desc: 'Sales trends, top sellers, market insights' },
                ].map((f, i) => (
                  <div key={i} className="p-3 bg-earth-15 rounded-lg">
                    <div className="text-farm-600 mb-1.5"><Icon name={f.icon} size={16} /></div>
                    <div className="font-bold text-xs text-earth-900 mb-[3px]">{f.title}</div>
                    <div className="text-[11px] text-earth-500 leading-snug">{f.desc}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
