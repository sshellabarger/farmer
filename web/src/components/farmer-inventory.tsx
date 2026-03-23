'use client';

import { Icon } from './icons';
import { Card, StatusBadge, SectionTitle, Btn } from './ui';
import { INVENTORY, EMOJI_MAP } from '@/lib/demo-data';

export function FarmerInventory() {
  const farmInventory = INVENTORY.filter((i) => i.farmId === 'f1');

  return (
    <div>
      <SectionTitle action={<Btn primary small>+ Add Harvest</Btn>}>Current Inventory</SectionTitle>
      <div className="flex flex-col gap-2">
        {farmInventory.map((item) => (
          <Card key={item.id} className="flex items-center gap-3.5" style={{ padding: 14 }}>
            <div
              className="w-[42px] h-[42px] rounded-[10px] flex items-center justify-center text-xl"
              style={{ background: item.status === 'sold' ? '#eee' : '#e8f5e9' }}
            >
              {EMOJI_MAP[item.category] || EMOJI_MAP.default}
            </div>
            <div className="flex-1">
              <div className="font-bold text-[13.5px] text-earth-900">{item.product}</div>
              <div className="text-xs text-earth-500 mt-0.5">
                {item.remaining}/{item.qty} {item.unit} remaining · {item.harvestDate === '2026-03-21' ? 'Today' : item.harvestDate}
              </div>
              {item.remaining > 0 && item.remaining < item.qty && (
                <div className="mt-1 h-1 bg-earth-50 rounded-full overflow-hidden w-[120px]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(item.remaining / item.qty) * 100}%`,
                      background: item.remaining / item.qty < 0.3 ? '#e65100' : '#4a7c28',
                    }}
                  />
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="font-extrabold text-[15px] text-farm-800">
                ${item.price.toFixed(2)}
                <span className="text-[10px] font-medium text-earth-500">/{item.unit}</span>
              </div>
              <div className="mt-1">
                <StatusBadge status={item.status} />
              </div>
            </div>
            <div className="shrink-0 text-earth-300 cursor-pointer p-1">
              <Icon name="edit" size={15} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
