'use client';

import { Icon } from './icons';
import { Card, SectionTitle, Btn } from './ui';
import { RECURRING_ORDERS } from '@/lib/demo-data';

export function RecurringOrders({ perspective }: { perspective: 'farmer' | 'market' }) {
  const items =
    perspective === 'farmer'
      ? RECURRING_ORDERS
      : RECURRING_ORDERS.filter((r) => r.marketId === 'm1');

  return (
    <div>
      <SectionTitle action={<Btn primary small>+ New Standing Order</Btn>}>Standing Orders</SectionTitle>
      <div className="flex flex-col gap-2">
        {items.map((r) => (
          <Card key={r.id} style={{ padding: 16, opacity: r.active ? 1 : 0.55 }}>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-[10px] flex items-center justify-center"
                style={{ background: r.active ? '#e8f5e9' : '#f5f0ea' }}
              >
                <Icon name="repeat" size={18} />
              </div>
              <div className="flex-1">
                <div className="font-bold text-[13px] text-earth-900">
                  {perspective === 'farmer' ? r.market : r.farm}
                </div>
                <div className="text-xs text-earth-500 mt-0.5">
                  {r.items.map((i) => `${i.qty} ${i.unit} ${i.product}`).join(' + ')}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs font-bold text-farm-800 flex items-center gap-1">
                  <Icon name="repeat" size={11} /> {r.frequency}
                </div>
                <div className="text-[11px] text-earth-500 mt-0.5">{r.day}</div>
                {r.nextDelivery && (
                  <div className="text-[10px] text-earth-700 mt-1 bg-earth-25 px-2 py-[2px] rounded-[10px]">
                    Next: {r.nextDelivery.slice(5)}
                  </div>
                )}
              </div>
              {/* Toggle */}
              <div
                className="w-9 h-5 rounded-[10px] cursor-pointer relative transition-colors"
                style={{ background: r.active ? '#4a7c28' : '#d0c8be' }}
              >
                <div
                  className="w-4 h-4 rounded-full bg-white absolute top-[2px] shadow transition-[left] duration-200"
                  style={{ left: r.active ? 18 : 2 }}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
