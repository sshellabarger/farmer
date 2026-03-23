'use client';

import { Icon } from './icons';
import { Card, StatusBadge, SectionTitle } from './ui';
import { ORDERS } from '@/lib/demo-data';

interface OrdersListProps {
  perspective: 'farmer' | 'market';
  farmFilter?: string;
}

export function OrdersList({ perspective, farmFilter }: OrdersListProps) {
  const items =
    perspective === 'market'
      ? ORDERS.filter((o) => o.marketId === 'm1')
      : farmFilter
        ? ORDERS.filter((o) => o.farmId === farmFilter)
        : ORDERS;

  const todayTotal = items.filter((o) => o.date === '2026-03-21').reduce((s, o) => s + o.total, 0);

  return (
    <div>
      <SectionTitle
        action={
          <span className="text-xs text-[#2e7d32] font-bold bg-farm-50 px-3 py-1 rounded-full">
            Today: ${todayTotal.toFixed(2)}
          </span>
        }
      >
        Orders
      </SectionTitle>
      <div className="flex flex-col gap-2">
        {items.map((order) => (
          <Card key={order.id} style={{ padding: 14 }}>
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2.5">
                <div className="w-[34px] h-[34px] rounded-lg bg-earth-25 flex items-center justify-center">
                  <Icon name={perspective === 'market' ? 'leaf' : 'store'} size={15} />
                </div>
                <div>
                  <div className="font-bold text-[13px] text-earth-900">
                    {perspective === 'market' ? order.farm : order.market}
                  </div>
                  <div className="text-[11px] text-earth-500">
                    #{order.id.slice(1)} · {order.date} · {order.deliveryTime}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={order.status} />
                <span
                  className="text-[11px] px-2 py-[3px] rounded-[10px] font-semibold flex items-center gap-1"
                  style={{
                    background: order.delivery === 'delivery' ? '#f3e5f5' : '#f5f0ea',
                    color: order.delivery === 'delivery' ? '#7b1fa2' : '#5a5044',
                  }}
                >
                  <Icon name={order.delivery === 'delivery' ? 'truck' : 'store'} size={10} />
                  {order.delivery}
                </span>
              </div>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-earth-50">
              <div className="text-xs text-earth-700">
                {order.items.map((i) => `${i.qty} ${i.unit} ${i.product}`).join(', ')}
              </div>
              <div className="font-extrabold text-[15px] text-farm-800">${order.total.toFixed(2)}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
