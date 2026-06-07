'use client';

import { useState, useRef } from 'react';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';

/* ─── Channel data ─── */
interface Channel {
  rank: number;
  tier: 'high' | 'mid' | 'low';
  badge: string;
  title: string;
  subtitle: string;
  barLabel: string;
  barPct: number;
  barNote: string;
  how: string;
  points: string[];
  why: string;
}

const CHANNELS: Record<number, Channel> = {
  1: {
    rank: 1, tier: 'high', badge: '~100% to farmer',
    title: 'Farmers Markets',
    subtitle: 'West Little Rock · North Little Rock',
    barLabel: '~100% direct', barPct: 100,
    barNote: 'Every dollar the customer pays goes directly to the grower. No intermediary margin. The farmer sets the price and keeps the revenue, minus minimal market fees.',
    how: 'Farmers sell directly to consumers at two in-person markets in Central Arkansas. The West Little Rock Farmers Market at Breckenridge Village and a second market in North Little Rock. Farmers bring their product, staff their own table, and interact directly with customers.',
    points: ['West Little Rock Farmers Market (Breckenridge Village)', 'North Little Rock Farmers Market', 'Direct customer interaction'],
    why: 'In-person markets build lasting customer loyalty and let farmers capture full retail value. They are also a low-barrier entry point for new growers learning to sell.',
  },
  2: {
    rank: 2, tier: 'high', badge: '85% to farmer',
    title: 'SJCA Online Market',
    subtitle: 'Online marketplace with Little Rock pickup',
    barLabel: '85% to farmer', barPct: 85,
    barNote: 'Farmers receive 85 cents of every retail dollar. The remaining 15 percent covers payment processing, platform operations, and pickup coordination. As a nonprofit, no margin goes to profit.',
    how: 'Customers browse and order from participating farmers through the SJCA online marketplace, then pick up their order at one of two Little Rock locations on designated pickup days. Farmers list product availability each week and deliver only what was ordered, reducing waste.',
    points: ['Two Little Rock pickup locations', 'Year-round availability', 'Pre-orders reduce farmer waste'],
    why: 'The online market extends direct-to-consumer sales beyond the weekly farmers market schedule and gives customers a reliable way to buy local without weather dependency or limited market hours.',
  },
  3: {
    rank: 3, tier: 'high', badge: '70–75% to farmer',
    title: 'The Farm Stop',
    subtitle: 'Year-round farm store at Breckenridge Village',
    barLabel: '70–75% to farmer', barPct: 72,
    barNote: 'Farmers receive 70 to 75 cents of every retail dollar. The remaining 25 to 30 percent covers store operations rather than profit, since SJCA is a nonprofit.',
    how: 'The Farm Stop operates on a consignment model. Multiple local producers stock the shelves and SJCA staff handles all retail sales, customer service, and inventory tracking. The farmer supplies the product and sets the price.',
    points: ['Year-round sales, not season-dependent', 'No market day labor required from farmer', 'Aggregates multiple producers in one storefront'],
    why: 'Farm Stop returns are far above typical grocery margins of 20 to 40 percent. The model expands shelf time for farmer product without expanding their labor.',
  },
  4: {
    rank: 4, tier: 'mid', badge: 'Above wholesale',
    title: 'Chef Direct',
    subtitle: '20+ local restaurants purchasing direct from growers',
    barLabel: 'Above wholesale', barPct: 58,
    barNote: 'Prices negotiated directly between farmer and chef, typically above commodity wholesale rates. Farmers retain full proceeds with no intermediary fee.',
    how: 'SJCA connects farmers directly with chefs at 20+ Central Arkansas restaurants. Farmers and chefs negotiate prices directly, cutting out the distributor margin. Chefs source locally for menu differentiation, farmers gain a premium buyer who values quality over commodity pricing.',
    points: ['Premium pricing for specialty varieties', 'Predictable repeat orders', 'Direct relationships with buyers'],
    why: 'Restaurant buyers value heirloom and specialty varieties that are difficult to move at volume through wholesale channels. The relationships also tend to last across seasons.',
  },
  5: {
    rank: 5, tier: 'mid', badge: 'Market rate volume',
    title: 'Wholesale via Spring Creek Food Hub',
    subtitle: "Arkansas's largest local food wholesale market",
    barLabel: 'Wholesale market rate', barPct: 42,
    barNote: 'Per-unit returns are lower than direct sales, but the wholesale channel moves significant volume and provides access to institutional buyers that smaller farms cannot reach independently.',
    how: "Through SJCA's partnership with Spring Creek Food Hub in Springdale, Central Arkansas farmers can list and sell product into the largest local food wholesale market in the state. SJCA handles the connection so farmers do not have to manage NW Arkansas logistics directly.",
    points: ['Access to NW Arkansas institutional buyers', 'Move larger quantities per transaction', 'Established food hub logistics and aggregation'],
    why: 'Spring Creek operates the largest local food wholesale network in Arkansas, connecting farmers with grocery, food service, and institutional buyers across the region.',
  },
  6: {
    rank: 6, tier: 'low', badge: 'Cash on surplus',
    title: 'MCO Processing Seconds',
    subtitle: 'Market Center of the Ozarks, Springdale AR',
    barLabel: 'Partial recovery', barPct: 25,
    barNote: 'Returns are below primary market prices but represent real cash recovered from product that would otherwise be discarded or composted.',
    how: 'Imperfect, surplus, or cosmetically blemished produce that does not meet retail or restaurant standards gets sold or processed through the Market Center of the Ozarks. MCO converts seconds into value-added shelf-stable goods, opening a recovery channel for product that would otherwise be wasted.',
    points: ['Cosmetically imperfect produce', 'Surplus after primary market sales', 'Gleaned field product post-harvest'],
    why: 'MCO provides aggregation, processing, and sales infrastructure for regional farm product, including value-added processing of seconds into shelf-stable goods like sauces and preserves.',
  },
  7: {
    rank: 7, tier: 'low', badge: 'Tax deduction value',
    title: 'Donation to Hunger Relief Alliance Organizations',
    subtitle: 'Non-cash charitable value through community partners',
    barLabel: 'Non-cash value', barPct: 15,
    barNote: 'No cash changes hands, but the farmer converts a total loss into a documented charitable contribution. For pass-through entities, the donation offsets taxable farm income.',
    how: 'When produce cannot be sold but is still food-safe, SJCA coordinates donation to Hunger Relief Alliance member organizations. The farmer receives documentation of the fair market value donated, which may be claimed as a non-cash charitable deduction on their tax return. The food goes to community food assistance programs.',
    points: ['Edible surplus not marketable elsewhere', 'Post-harvest field gleanings', 'End-of-season crop surplus'],
    why: 'Hunger Relief Alliance partners distribute food across Arkansas communities, creating a dignified path for unsellable but edible surplus while giving farmers a tax benefit on what would otherwise be a total loss.',
  },
};

const TIER_COLORS = {
  high: { accent: '#52b788', dark: '#2d6a4f', bg: '#d8f3dc', badgeBg: '#d8f3dc', badgeText: '#1a3d2b' },
  mid:  { accent: '#5c4a8a', dark: '#5c4a8a', bg: '#ede9f6', badgeBg: '#ede9f6', badgeText: '#5c4a8a' },
  low:  { accent: '#e9850a', dark: '#7a4400', bg: '#fff3cd', badgeBg: '#fff3cd', badgeText: '#7a4400' },
};

/* ─── SVG Satellite positions ─── */
const SATELLITES = [
  { id: 1, cx: 360, cy: 125, r: 86, lines: { x1: 360, y1: 270, x2: 360, y2: 211 }, label: ['Farmers', 'Markets'], pct: '~100%' },
  { id: 2, cx: 543.7, cy: 213.5, r: 80, lines: { x1: 430.4, y1: 303.9, x2: 481.2, y2: 263.4 }, label: ['SJCA Online', 'Market'], pct: '85%' },
  { id: 3, cx: 589.1, cy: 412.3, r: 74, lines: { x1: 447.7, y1: 380, x2: 516.9, y2: 395.8 }, label: ['The', 'Farm Stop'], pct: '70–75%' },
  { id: 4, cx: 462, cy: 571.7, r: 68, lines: { x1: 399.1, y1: 441.1, x2: 432.5, y2: 510.4 }, label: ['Chef', 'Direct'], pct: 'Premium' },
  { id: 5, cx: 258, cy: 571.7, r: 62, lines: { x1: 320.9, y1: 441.1, x2: 284.9, y2: 515.9 }, label: ['Wholesale'], pct: 'Volume' },
  { id: 6, cx: 130.9, cy: 412.3, r: 56, lines: { x1: 272.3, y1: 380, x2: 185.5, y2: 399.8 }, label: ['MCO', 'Seconds'], pct: 'Recovery' },
  { id: 7, cx: 176.3, cy: 213.5, r: 50, lines: { x1: 289.6, y1: 303.9, x2: 215.4, y2: 244.7 }, label: ['Donation'], pct: 'Tax' },
];

/* ─── Component ─── */
export default function AboutPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [barAnimated, setBarAnimated] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const showDetail = (id: number) => {
    setActiveId(id);
    setBarAnimated(false);
    // Trigger bar animation after render
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setBarAnimated(true));
    });
    // Scroll to panel on mobile
    setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  };

  const active = activeId ? CHANNELS[activeId] : null;
  const tc = active ? TIER_COLORS[active.tier] : null;

  return (
    <div className="min-h-screen" style={{ background: '#faf8f3' }}>
      <Header />

      {/* Hero header */}
      <header className="relative overflow-hidden" style={{ background: '#1a3d2b', color: '#fff', padding: '48px 40px 40px' }}>
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2352b788' fill-opacity='0.06'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4h-4z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }} />
        <div className="max-w-[1000px] mx-auto relative">
          <div className="flex items-center gap-2 mb-2.5 text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: '#52b788' }}>
            <span className="inline-block w-6 h-0.5" style={{ background: '#52b788' }} />
            St. Joseph Center of Arkansas
          </div>
          <h1 className="font-display font-bold leading-[1.15] mb-3.5" style={{ fontSize: 'clamp(28px, 5vw, 44px)' }}>
            Revenue Network
          </h1>
          <p className="font-sans font-light max-w-[580px] leading-relaxed" style={{ fontSize: 16, color: 'rgba(255,255,255,0.72)' }}>
            Seven revenue channels connecting Arkansas growers to buyers, from direct sales at the farmers market to community food donations. Each channel is sized by its revenue potential to the farmer.
          </p>
        </div>
      </header>

      {/* Diagram section */}
      <section className="max-w-[1000px] mx-auto px-5 sm:px-10 pt-10 text-center">
        <div className="text-sm tracking-wide mb-1" style={{ color: '#6b6b63' }}>FARMER REVENUE ECOSYSTEM</div>
        <h2 className="font-display font-bold text-[22px] mb-1.5" style={{ color: '#1a3d2b' }}>Seven channels, one farmer</h2>
        <p className="text-sm mb-4" style={{ color: '#44443f' }}>Click any channel to learn how it works and what it returns to the grower.</p>
        <p className="text-xs italic max-w-[540px] mx-auto mb-5" style={{ color: '#6b6b63' }}>Circle size reflects revenue potential. Larger circles return more dollars to the farmer per unit of product.</p>

        {/* Desktop SVG diagram */}
        <div className="hidden sm:block relative w-full max-w-[720px] mx-auto" style={{ paddingTop: '100%' }}>
          <svg viewBox="0 0 720 720" className="absolute top-0 left-0 w-full h-full" style={{ overflow: 'visible' }}
            role="img" aria-label="Circular diagram with farmer in center and seven revenue channels arranged around them">
            <defs>
              <radialGradient id="farmerGrad" cx="50%" cy="40%" r="60%">
                <stop offset="0%" stopColor="#52b788" />
                <stop offset="100%" stopColor="#2d6a4f" />
              </radialGradient>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                <feOffset dx="0" dy="2" />
                <feComponentTransfer><feFuncA type="linear" slope="0.18" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* Connecting lines */}
            <g stroke="#c9d5cb" strokeWidth="1.5" strokeDasharray="4 4" fill="none">
              {SATELLITES.map(s => (
                <line key={s.id} x1={s.lines.x1} y1={s.lines.y1} x2={s.lines.x2} y2={s.lines.y2} />
              ))}
            </g>

            {/* Center farmer */}
            <g style={{ pointerEvents: 'none' }} filter="url(#softShadow)">
              <circle cx="360" cy="360" r="90" fill="url(#farmerGrad)" />
              <circle cx="360" cy="360" r="90" fill="none" stroke="#ffffff" strokeWidth="3" opacity="0.4" />
              <text x="360" y="350" textAnchor="middle" fontFamily="'Playfair Display', serif" fontSize="34" fill="#ffffff">{'🌱'}</text>
              <text x="360" y="388" textAnchor="middle" fontFamily="'Playfair Display', serif" fontSize="20" fontWeight="700" fill="#ffffff">FARMER</text>
            </g>

            {/* Satellites */}
            {SATELLITES.map(s => {
              const ch = CHANNELS[s.id];
              const tierColor = TIER_COLORS[ch.tier];
              const isActive = activeId === s.id;
              const labelY = s.cy - s.r * 0.4;
              const fontSize = s.r > 70 ? 15 : s.r > 60 ? 14 : s.r > 50 ? 13 : 12;
              const chFontSize = s.r > 70 ? 13 : s.r > 60 ? 12 : s.r > 50 ? 11 : 10;
              const pctFontSize = s.r > 70 ? 18 : s.r > 60 ? 17 : s.r > 50 ? 15 : 13;

              return (
                <g key={s.id} className="cursor-pointer transition-transform hover:scale-105" style={{ transformOrigin: `${s.cx}px ${s.cy}px` }}
                  onClick={() => showDetail(s.id)}>
                  <circle cx={s.cx} cy={s.cy} r={s.r} fill="#ffffff" filter="url(#softShadow)" />
                  <circle cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke={tierColor.accent} strokeWidth={isActive ? 4 : 3} />
                  <text x={s.cx} y={labelY} textAnchor="middle" fontFamily="'Playfair Display', serif" fontSize={chFontSize} fontWeight="700" fill={tierColor.accent}>
                    CHANNEL {s.id}
                  </text>
                  {s.label.map((line, li) => (
                    <text key={li} x={s.cx} y={labelY + 22 + li * 17} textAnchor="middle" fontFamily="'Source Sans 3', sans-serif" fontSize={fontSize} fontWeight="600" fill="#1a1a18">
                      {line}
                    </text>
                  ))}
                  <text x={s.cx} y={labelY + 22 + s.label.length * 17 + 8} textAnchor="middle" fontFamily="'Playfair Display', serif" fontSize={pctFontSize} fontWeight="700" fill={tierColor.dark}>
                    {s.pct}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Mobile channel list */}
        <div className="flex sm:hidden flex-col gap-2.5 text-left mt-2">
          {SATELLITES.map(s => {
            const ch = CHANNELS[s.id];
            const tierColor = TIER_COLORS[ch.tier];
            const isActive = activeId === s.id;
            return (
              <button key={s.id} onClick={() => showDetail(s.id)}
                className="flex items-center gap-3 rounded-xl p-3.5 border-none cursor-pointer text-left w-full transition-all active:scale-[0.99]"
                style={{
                  background: isActive ? tierColor.bg : '#fff',
                  borderLeft: `4px solid ${tierColor.accent}`,
                  boxShadow: '0 4px 20px rgba(26,61,43,0.08)',
                }}>
                <span className="font-display font-bold text-[22px] w-[30px] text-center shrink-0" style={{ color: tierColor.accent }}>
                  {String(s.id).padStart(2, '0')}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-display font-bold text-[15px] leading-tight" style={{ color: '#1a1a18' }}>{ch.title}</span>
                  <span className="block text-xs mt-0.5" style={{ color: '#6b6b63' }}>{ch.subtitle}</span>
                </span>
                <span className="font-display font-bold text-[13px] shrink-0 text-right leading-tight" style={{ color: tierColor.dark }}>{s.pct}</span>
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex justify-center gap-7 flex-wrap mt-7 text-[13px]">
          {[
            { color: '#52b788', label: 'Highest return to farmer' },
            { color: '#a08edd', label: 'Moderate return' },
            { color: '#e9850a', label: 'Value recovery' },
          ].map(l => (
            <div key={l.label} className="flex items-center gap-2" style={{ color: '#44443f' }}>
              <span className="w-3 h-3 rounded-full inline-block" style={{ background: l.color }} />
              {l.label}
            </div>
          ))}
        </div>
      </section>

      {/* Detail panel */}
      <section className="max-w-[1000px] mx-auto px-5 sm:px-10 py-8" ref={panelRef}>
        {!active ? (
          <div className="text-center text-sm italic py-5" style={{ color: '#6b6b63' }}>Tap or click any channel to see how it works</div>
        ) : (
          <div className="bg-white rounded-xl p-6 sm:p-8" style={{
            boxShadow: '0 4px 20px rgba(26,61,43,0.08)',
            borderLeft: `6px solid ${tc!.accent}`,
            animation: 'slideIn 0.3s ease',
          }}>
            {/* Header */}
            <div className="flex flex-wrap items-start gap-3 sm:gap-5 pb-5 mb-5 border-b" style={{ borderBottomColor: '#e8e4dc' }}>
              <span className="font-display font-bold text-[38px] leading-none shrink-0" style={{ color: tc!.accent }}>
                {String(active.rank).padStart(2, '0')}
              </span>
              <div className="flex-1 min-w-[180px]">
                <div className="font-display font-bold text-2xl leading-tight mb-1" style={{ color: '#1a1a18' }}>{active.title}</div>
                <div className="text-sm" style={{ color: '#6b6b63' }}>{active.subtitle}</div>
              </div>
              <span className="text-[13px] font-semibold px-3.5 py-1.5 rounded-full text-center leading-snug shrink-0" style={{ background: tc!.badgeBg, color: tc!.badgeText }}>
                {active.badge}
              </span>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <h4 className="text-[11px] font-semibold tracking-[0.1em] uppercase mb-2" style={{ color: '#6b6b63' }}>How it works</h4>
                <p className="text-sm leading-relaxed" style={{ color: '#44443f' }}>{active.how}</p>
              </div>
              <div>
                <h4 className="text-[11px] font-semibold tracking-[0.1em] uppercase mb-2" style={{ color: '#6b6b63' }}>Farmer return</h4>
                <div className="font-display font-bold text-[26px] leading-none mb-2" style={{ color: tc!.dark }}>{active.barLabel}</div>
                <div className="h-[9px] rounded-full overflow-hidden" style={{ background: '#e8e4dc' }}>
                  <div className="h-full rounded-full transition-all duration-700" style={{
                    background: tc!.accent,
                    width: barAnimated ? `${active.barPct}%` : '0%',
                  }} />
                </div>
                <p className="text-[13px] mt-3 leading-relaxed" style={{ color: '#44443f' }}>{active.barNote}</p>
              </div>
              <div>
                <h4 className="text-[11px] font-semibold tracking-[0.1em] uppercase mb-2" style={{ color: '#6b6b63' }}>Key points</h4>
                <ul className="text-sm leading-loose pl-4.5 list-disc" style={{ color: '#44443f' }}>
                  {active.points.map(p => <li key={p}>{p}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="text-[11px] font-semibold tracking-[0.1em] uppercase mb-2" style={{ color: '#6b6b63' }}>Why it matters</h4>
                <p className="text-sm leading-relaxed" style={{ color: '#44443f' }}>{active.why}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Callout */}
      <div className="max-w-[1000px] mx-auto px-5 sm:px-10 pb-6">
        <div className="rounded-xl p-7" style={{ background: '#edf8ee', borderLeft: '5px solid #2d6a4f' }}>
          <h3 className="font-display font-bold text-lg mb-2.5" style={{ color: '#1a3d2b' }}>A complete market system, not just one path to market</h3>
          <p className="text-sm leading-relaxed" style={{ color: '#44443f' }}>
            Most small farms rely on a single channel and absorb all the risk when that channel fails. SJCA&apos;s seven-channel model gives Arkansas growers a portfolio approach. Maximize returns through direct sales to consumers, capture mid-tier volume through chef and wholesale relationships, recover value from imperfect product through seconds processing, and convert truly unsellable surplus into a tax benefit by donating to Hunger Relief Alliance partners. Because SJCA operates as a nonprofit, every channel is designed around farmer benefit rather than organizational profit. No product is wasted. Every harvest has a home.
          </p>
        </div>
      </div>

      {/* Nonprofit banner */}
      <div style={{ background: 'linear-gradient(90deg, #52b788 0%, #2d6a4f 100%)', color: '#fff', padding: '22px 40px' }}>
        <div className="max-w-[1000px] mx-auto flex items-center gap-5 flex-wrap">
          <div className="w-[52px] h-[52px] rounded-full flex items-center justify-center text-2xl shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }}>
            <span role="img" aria-label="wheat">&#x1F33E;</span>
          </div>
          <div className="flex-1 min-w-[240px]">
            <div className="font-display font-bold text-lg mb-1">A nonprofit network means more money to the farmer</div>
            <div className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.92)' }}>
              St. Joseph Center of Arkansas is a <strong className="font-semibold text-white">nonprofit organization</strong>. We don&apos;t require a profit margin, only enough revenue to cover operational costs. Every channel above is engineered to send the maximum possible share to the people growing the food.
            </div>
          </div>
        </div>
      </div>

      {/* Service pillars */}
      <section className="max-w-[1000px] mx-auto px-5 sm:px-10 pt-12 pb-2">
        <div className="text-center mb-8">
          <div className="text-[11px] tracking-[0.14em] uppercase font-semibold mb-2.5" style={{ color: '#2d6a4f' }}>HOW SJCA SHOWS UP FOR FARMERS</div>
          <h2 className="font-display font-bold text-[26px] leading-tight mb-3" style={{ color: '#1a3d2b' }}>More than market access. Full-service farmer support.</h2>
          <p className="text-[15px] max-w-[660px] mx-auto leading-relaxed" style={{ color: '#44443f' }}>
            SJCA doesn&apos;t just open doors to revenue channels. Our team builds the markets, cultivates the buyer relationships, and walks farmers through every transaction as needed.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[
            { icon: '📚', title: 'Market Development & Training', body: 'SJCA actively develops each revenue channel and trains farmers in the skills needed to succeed, from pricing and packaging to inventory management and customer service.' },
            { icon: '🤝', title: 'Relationship Building', body: 'Staff cultivate the buyer relationships that make each channel work, including chefs, food hub partners, market customers, and hunger relief coordinators across the region.' },
            { icon: '🛎️', title: 'Transaction Concierge', body: 'For farmers who need it, SJCA staff walk through every transaction in person, from listing product online to coordinating delivery and processing payment.' },
          ].map((card) => (
            <div key={card.title} className="bg-white p-7 rounded-xl border-t-4 transition-all hover:-translate-y-0.5" style={{ borderTopColor: '#52b788', boxShadow: '0 4px 20px rgba(26,61,43,0.08)' }}>
              <div className="w-[50px] h-[50px] rounded-xl flex items-center justify-center text-2xl mb-4" style={{ background: '#d8f3dc' }}>{card.icon}</div>
              <h3 className="font-display font-bold text-lg mb-2.5 leading-tight" style={{ color: '#1a3d2b' }}>{card.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: '#44443f' }}>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-xs tracking-wide py-5 px-10" style={{ background: '#1a3d2b', color: 'rgba(255,255,255,0.6)' }}>
        St. Joseph Center of Arkansas &nbsp;&middot;&nbsp; A nonprofit network connecting Arkansas farmers to markets
      </footer>

      <ChatWidget />

      {/* slideIn animation (scoped) */}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
