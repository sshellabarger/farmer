'use client';

import { useState } from 'react';
import { Card, SectionTitle, Btn } from './ui';
import { FARMS, INVENTORY, EMOJI_MAP } from '@/lib/demo-data';

export function MultiFarmInventory() {
  const [filter, setFilter] = useState('all');
  const categories = ['all', ...Array.from(new Set(INVENTORY.map((i) => i.category)))];
  const filtered =
    filter === 'all'
      ? INVENTORY.filter((i) => i.status !== 'sold')
      : INVENTORY.filter((i) => i.category === filter && i.status !== 'sold');
  const byFarm = FARMS.map((f) => ({ ...f, items: filtered.filter((i) => i.farmId === f.id) })).filter(
    (f) => f.items.length > 0
  );

  return (
    <div>
      <SectionTitle
        action={
          <div className="flex gap-1">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className="px-3 py-[5px] rounded-full border-none text-[11px] font-semibold cursor-pointer font-sans capitalize"
                style={{
                  background: filter === c ? '#2d5016' : '#f0ebe4',
                  color: filter === c ? '#fff' : '#5a5044',
                }}
              >
                {c}
              </button>
            ))}
          </div>
        }
      >
        Browse All Farms
      </SectionTitle>
      <div className="flex flex-col gap-4">
        {byFarm.map((farm) => (
          <Card key={farm.id} className="overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 bg-earth-15 border-b border-earth-50">
              <span className="text-xl">{farm.emoji}</span>
              <div>
                <div className="font-bold text-[13.5px] text-earth-900">{farm.name}</div>
                <div className="text-[11px] text-earth-500">
                  {farm.location} · {farm.specialty}
                </div>
              </div>
              <div className="ml-auto text-[11px] text-farm-800 font-semibold">{farm.items.length} items available</div>
            </div>
            <div className="p-2">
              {farm.items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-2.5 py-2.5 rounded-lg transition-colors">
                  <span className="text-lg w-7 text-center">{EMOJI_MAP[item.category] || EMOJI_MAP.default}</span>
                  <div className="flex-1">
                    <div className="font-semibold text-[13px] text-earth-900">{item.product}</div>
                    <div className="text-[11px] text-earth-500">
                      {item.remaining} {item.unit} · Harvested{' '}
                      {item.harvestDate === '2026-03-21' ? 'today' : item.harvestDate.slice(5)}
                    </div>
                  </div>
                  <div className="font-extrabold text-sm text-farm-800 mr-2">
                    ${item.price.toFixed(2)}
                    <span className="text-[10px] font-medium text-earth-500">/{item.unit}</span>
                  </div>
                  <Btn primary small>
                    Order
                  </Btn>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
