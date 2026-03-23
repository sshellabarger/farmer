'use client';

import { Icon } from './icons';
import { StatusBadge } from './ui';
import { ORDERS } from '@/lib/demo-data';

const STATUS_COLORS: Record<string, string> = {
  delivered: '#1565c0',
  'in-transit': '#7b1fa2',
  confirmed: '#2e7d32',
  pending: '#f9a825',
};

export function DeliveryTimeline() {
  const deliveries = ORDERS.filter((o) => o.date === '2026-03-21').sort((a, b) =>
    a.deliveryTime.localeCompare(b.deliveryTime)
  );

  return (
    <div className="flex flex-col">
      {deliveries.map((d, i) => {
        const dotColor = STATUS_COLORS[d.status] || '#999';
        return (
          <div key={d.id} className="flex gap-3.5" style={{ padding: '14px 0', borderBottom: i < deliveries.length - 1 ? '1px solid #f0ebe4' : 'none' }}>
            <div className="flex flex-col items-center w-12 shrink-0">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{
                  background: dotColor,
                  border: '2px solid #fff',
                  boxShadow: `0 0 0 2px ${dotColor}44`,
                }}
              />
              {i < deliveries.length - 1 && <div className="w-0.5 flex-1 bg-earth-100 mt-1" />}
            </div>
            <div className="flex-1">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-bold text-[13px] text-earth-900">{d.deliveryTime}</span>
                  <span className="text-xs text-earth-500 ml-2">{d.market}</span>
                </div>
                <StatusBadge status={d.status} />
              </div>
              <div className="text-xs text-earth-700 mt-1">
                {d.items.map((it) => `${it.qty}${it.unit} ${it.product}`).join(', ')}
              </div>
              <div className="flex gap-3 mt-1.5 text-[11px]">
                <span className="text-earth-500 flex items-center gap-1">
                  <Icon name={d.delivery === 'delivery' ? 'truck' : 'store'} size={12} />
                  {d.delivery === 'delivery' ? 'Delivery' : 'Pickup'}
                </span>
                <span className="text-farm-800 font-bold">${d.total.toFixed(2)}</span>
                <span className="text-earth-500">from {d.farm}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
