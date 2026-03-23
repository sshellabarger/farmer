'use client';

import { Icon } from './icons';
import { Card, SectionTitle, Btn } from './ui';
import { MARKETS } from '@/lib/demo-data';

export function FarmerMarkets() {
  return (
    <div>
      <SectionTitle action={<Btn primary small>+ Add Market</Btn>}>My Markets</SectionTitle>
      <div className="flex flex-col gap-2">
        {MARKETS.map((m) => (
          <Card key={m.id} className="flex items-center gap-3.5" style={{ padding: 14, opacity: m.active ? 1 : 0.5 }}>
            <div className="flex flex-col items-center shrink-0 w-6">
              <span className="text-lg font-extrabold text-farm-800 font-display">{m.priority}</span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-[13.5px] text-earth-900">{m.name}</span>
                <span className="text-[10px] px-[7px] py-[2px] rounded-[10px] bg-earth-50 text-earth-700 font-semibold">
                  {m.type}
                </span>
              </div>
              <div className="text-xs text-earth-500 mt-0.5">
                {m.contact} · Prefers {m.deliveryPref}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold" style={{ color: m.active ? '#2e7d32' : '#8a7e72' }}>
                {m.active ? 'Active' : 'Paused'}
              </span>
              <div
                className="w-9 h-5 rounded-[10px] cursor-pointer relative"
                style={{ background: m.active ? '#4a7c28' : '#d0c8be' }}
              >
                <div
                  className="w-4 h-4 rounded-full bg-white absolute top-[2px] shadow transition-[left] duration-200"
                  style={{ left: m.active ? 18 : 2 }}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
