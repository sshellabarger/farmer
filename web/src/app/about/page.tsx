'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';
import { Icon } from '@/components/icons';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';

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

/* Tier palette — stays inside the FarmLink greens/harvest/clay system */
const TIER_COLORS = {
  high: { accent: '#3D7A47', dark: '#21512C', bg: '#EBF4E6', badgeBg: '#DCEDD6', badgeText: '#1B3F24' },
  mid:  { accent: '#C9622F', dark: '#8F441E', bg: '#FBEFE6', badgeBg: '#F6E2D2', badgeText: '#8F441E' },
  low:  { accent: '#8B7355', dark: '#5F4D38', bg: '#F3EDE4', badgeBg: '#E9DFD0', badgeText: '#5F4D38' },
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
export default function RevenueNetworkPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [barAnimated, setBarAnimated] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const showDetail = (id: number) => {
    setActiveId(id);
    setBarAnimated(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setBarAnimated(true));
    });
    setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  };

  const active = activeId ? CHANNELS[activeId] : null;
  const tc = active ? TIER_COLORS[active.tier] : null;

  return (
    <div className="min-h-screen bg-bg font-sans">
      <Header />

      {/* ── Hero ── */}
      <header className="relative overflow-hidden px-5 sm:px-10 py-14 md:py-20" style={{ background: '#142E1B', color: '#fff' }}>
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%237BC487' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4h-4z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }} />
        <div className="max-w-[1020px] mx-auto relative">
          <div className="kicker mb-4" style={{ color: '#7BC487' }}>St. Joseph Center of Arkansas · A nonprofit network</div>
          <h1 className="font-display font-semibold tracking-tight mb-4" style={{ fontSize: 'clamp(34px, 5.5vw, 54px)', lineHeight: 1.08 }}>
            Every harvest
            <br />
            has a home.
          </h1>
          <p className="max-w-[560px] leading-relaxed mb-8" style={{ fontSize: 16, color: 'rgba(255,255,255,0.74)' }}>
            Seven revenue channels connect Arkansas growers to buyers — from full-retail farmers
            markets down to tax-deductible donation. One text to FarmLink puts your harvest in
            front of all of them.
          </p>
          <div className="flex gap-3 flex-wrap">
            <a
              href={smsHref('Hi FarmLink! Tell me about selling through the network.')}
              className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full no-underline bg-white font-bold text-[15px] text-green-800"
              style={{ boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}
            >
              <Icon name="msg" size={17} />
              Text {FARMLINK_NUMBER_DISPLAY}
            </a>
            <Link
              href="/signup?role=farmer"
              className="inline-flex items-center px-7 py-3.5 rounded-full no-underline font-semibold text-[15px] text-white"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)' }}
            >
              Join as a farm
            </Link>
          </div>
        </div>
      </header>

      {/* ── Diagram ── */}
      <section className="max-w-[1020px] mx-auto px-5 sm:px-10 pt-12 md:pt-16 text-center">
        <div className="kicker mb-3">Farmer revenue ecosystem</div>
        <h2 className="h-display mb-2" style={{ fontSize: 'clamp(26px, 3.6vw, 36px)' }}>Seven channels, one farmer</h2>
        <p className="text-[15px] text-text-soft mb-2">Tap any channel to see how it works and what it returns to the grower.</p>
        <p className="text-[13px] italic text-text-muted max-w-[540px] mx-auto mb-6">Circle size reflects revenue potential — larger circles return more dollars to the farmer per unit of product.</p>

        {/* Desktop SVG diagram */}
        <div className="hidden sm:block relative w-full max-w-[720px] mx-auto" style={{ paddingTop: '100%' }}>
          <svg viewBox="0 0 720 720" className="absolute top-0 left-0 w-full h-full" style={{ overflow: 'visible' }}
            role="img" aria-label="Circular diagram with farmer in center and seven revenue channels arranged around them">
            <defs>
              <radialGradient id="farmerGrad" cx="50%" cy="40%" r="60%">
                <stop offset="0%" stopColor="#559B61" />
                <stop offset="100%" stopColor="#21512C" />
              </radialGradient>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                <feOffset dx="0" dy="2" />
                <feComponentTransfer><feFuncA type="linear" slope="0.16" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* Connecting lines */}
            <g stroke="#C9D5CB" strokeWidth="1.5" strokeDasharray="4 4" fill="none">
              {SATELLITES.map(s => (
                <line key={s.id} x1={s.lines.x1} y1={s.lines.y1} x2={s.lines.x2} y2={s.lines.y2} />
              ))}
            </g>

            {/* Center farmer */}
            <g style={{ pointerEvents: 'none' }} filter="url(#softShadow)">
              <circle cx="360" cy="360" r="90" fill="url(#farmerGrad)" />
              <circle cx="360" cy="360" r="90" fill="none" stroke="#ffffff" strokeWidth="3" opacity="0.4" />
              <text x="360" y="350" textAnchor="middle" fontSize="34" fill="#ffffff">{'🌱'}</text>
              <text x="360" y="390" textAnchor="middle" fontFamily="'Fraunces', Georgia, serif" fontSize="21" fontWeight="600" letterSpacing="0.06em" fill="#ffffff">FARMER</text>
            </g>

            {/* Satellites */}
            {SATELLITES.map(s => {
              const ch = CHANNELS[s.id];
              const tierColor = TIER_COLORS[ch.tier];
              const isActive = activeId === s.id;
              const labelY = s.cy - s.r * 0.4;
              const fontSize = s.r > 70 ? 15 : s.r > 60 ? 14 : s.r > 50 ? 13 : 12;
              const chFontSize = s.r > 70 ? 12 : s.r > 60 ? 11 : 10;
              const pctFontSize = s.r > 70 ? 18 : s.r > 60 ? 17 : s.r > 50 ? 15 : 13;

              return (
                <g key={s.id} className="cursor-pointer transition-transform hover:scale-105" style={{ transformOrigin: `${s.cx}px ${s.cy}px` }}
                  onClick={() => showDetail(s.id)}>
                  <circle cx={s.cx} cy={s.cy} r={s.r} fill="#ffffff" filter="url(#softShadow)" />
                  <circle cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke={tierColor.accent} strokeWidth={isActive ? 4 : 3} />
                  <text x={s.cx} y={labelY} textAnchor="middle" fontFamily="'Source Sans 3', sans-serif" fontSize={chFontSize} fontWeight="700" letterSpacing="0.08em" fill={tierColor.accent}>
                    CHANNEL {s.id}
                  </text>
                  {s.label.map((line, li) => (
                    <text key={li} x={s.cx} y={labelY + 22 + li * 17} textAnchor="middle" fontFamily="'Source Sans 3', sans-serif" fontSize={fontSize} fontWeight="600" fill="#1E231B">
                      {line}
                    </text>
                  ))}
                  <text x={s.cx} y={labelY + 22 + s.label.length * 17 + 10} textAnchor="middle" fontFamily="'Fraunces', Georgia, serif" fontSize={pctFontSize} fontWeight="600" fill={tierColor.dark}>
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
                className="flex items-center gap-3 rounded-2xl p-4 border-none cursor-pointer text-left w-full transition-all active:scale-[0.99]"
                style={{
                  background: isActive ? tierColor.bg : '#fff',
                  borderLeft: `4px solid ${tierColor.accent}`,
                  boxShadow: '0 3px 16px rgba(20,46,27,0.07)',
                }}>
                <span className="font-display font-semibold text-[22px] w-[32px] text-center shrink-0" style={{ color: tierColor.accent }}>
                  {String(s.id).padStart(2, '0')}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-display font-semibold text-[16px] leading-tight text-text">{ch.title}</span>
                  <span className="block text-xs mt-0.5 text-text-muted">{ch.subtitle}</span>
                </span>
                <span className="font-display font-semibold text-[13px] shrink-0 text-right leading-tight" style={{ color: tierColor.dark }}>{s.pct}</span>
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex justify-center gap-6 flex-wrap mt-7 text-[13px] text-text-soft">
          {[
            { color: TIER_COLORS.high.accent, label: 'Highest return to farmer' },
            { color: TIER_COLORS.mid.accent, label: 'Moderate return' },
            { color: TIER_COLORS.low.accent, label: 'Value recovery' },
          ].map(l => (
            <div key={l.label} className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full inline-block" style={{ background: l.color }} />
              {l.label}
            </div>
          ))}
        </div>
      </section>

      {/* ── Detail panel ── */}
      <section className="max-w-[1020px] mx-auto px-5 sm:px-10 py-8" ref={panelRef}>
        {!active ? (
          <div className="text-center text-sm italic text-text-muted py-5">Tap or click any channel to see how it works</div>
        ) : (
          <div className="bg-white rounded-2xl p-6 sm:p-9" style={{
            boxShadow: '0 4px 20px rgba(20,46,27,0.07)',
            borderLeft: `6px solid ${tc!.accent}`,
            animation: 'fadeUp 0.3s ease',
          }}>
            {/* Header */}
            <div className="flex flex-wrap items-start gap-3 sm:gap-5 pb-5 mb-5 border-b border-border-light">
              <span className="font-display font-semibold text-[40px] leading-none shrink-0" style={{ color: tc!.accent }}>
                {String(active.rank).padStart(2, '0')}
              </span>
              <div className="flex-1 min-w-[180px]">
                <div className="font-display font-semibold text-[24px] leading-tight mb-1 text-text">{active.title}</div>
                <div className="text-sm text-text-muted">{active.subtitle}</div>
              </div>
              <span className="text-[13px] font-semibold px-3.5 py-1.5 rounded-full text-center leading-snug shrink-0" style={{ background: tc!.badgeBg, color: tc!.badgeText }}>
                {active.badge}
              </span>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <h4 className="kicker mb-2.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>How it works</h4>
                <p className="text-sm leading-relaxed text-text-soft">{active.how}</p>
              </div>
              <div>
                <h4 className="kicker mb-2.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Farmer return</h4>
                <div className="font-display font-semibold text-[26px] leading-none mb-2.5" style={{ color: tc!.dark }}>{active.barLabel}</div>
                <div className="h-[9px] rounded-full overflow-hidden bg-earth-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{
                    background: tc!.accent,
                    width: barAnimated ? `${active.barPct}%` : '0%',
                  }} />
                </div>
                <p className="text-[13px] mt-3 leading-relaxed text-text-soft">{active.barNote}</p>
              </div>
              <div>
                <h4 className="kicker mb-2.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Key points</h4>
                <ul className="text-sm leading-loose pl-4.5 list-disc text-text-soft">
                  {active.points.map(p => <li key={p}>{p}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="kicker mb-2.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Why it matters</h4>
                <p className="text-sm leading-relaxed text-text-soft">{active.why}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Portfolio callout ── */}
      <div className="max-w-[1020px] mx-auto px-5 sm:px-10 pb-8">
        <div className="rounded-2xl p-7 md:p-8 bg-green-50" style={{ borderLeft: '5px solid #21512C' }}>
          <h3 className="font-display font-semibold text-[19px] md:text-[21px] mb-2.5 text-green-800">A complete market system, not just one path to market</h3>
          <p className="text-sm leading-relaxed text-text-soft m-0">
            Most small farms rely on a single channel and absorb all the risk when that channel fails.
            SJCA&apos;s seven-channel model gives Arkansas growers a portfolio approach: maximize returns
            through direct sales, capture mid-tier volume through chef and wholesale relationships,
            recover value from imperfect product through seconds processing, and convert truly
            unsellable surplus into a tax benefit through donation. No product is wasted.
            Every harvest has a home.
          </p>
        </div>
      </div>

      {/* ── Nonprofit band ── */}
      <div className="px-5 sm:px-10 py-7" style={{ background: 'linear-gradient(90deg, #3D7A47 0%, #21512C 100%)', color: '#fff' }}>
        <div className="max-w-[1020px] mx-auto flex items-center gap-5 flex-wrap">
          <div className="w-[52px] h-[52px] rounded-full flex items-center justify-center text-2xl shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }}>
            <span role="img" aria-label="wheat">&#x1F33E;</span>
          </div>
          <div className="flex-1 min-w-[240px]">
            <div className="font-display font-semibold text-[18px] md:text-[19px] mb-1">A nonprofit network means more money to the farmer</div>
            <div className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.9)' }}>
              St. Joseph Center of Arkansas is a <strong className="font-semibold text-white">nonprofit organization</strong>.
              We don&apos;t require a profit margin, only enough revenue to cover operational costs.
              Every channel above is engineered to send the maximum possible share to the people growing the food.
            </div>
          </div>
        </div>
      </div>

      {/* ── Service pillars ── */}
      <section className="max-w-[1020px] mx-auto px-5 sm:px-10 pt-14 pb-6">
        <div className="text-center mb-9">
          <div className="kicker mb-3">How SJCA shows up for farmers</div>
          <h2 className="h-display mb-3" style={{ fontSize: 'clamp(24px, 3.4vw, 32px)' }}>More than market access. Full-service farmer support.</h2>
          <p className="text-[15px] max-w-[640px] mx-auto leading-relaxed text-text-soft">
            SJCA doesn&apos;t just open doors to revenue channels — our team builds the markets,
            cultivates the buyer relationships, and walks farmers through every transaction as needed.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[
            { icon: '📚', title: 'Market development & training', body: 'SJCA actively develops each revenue channel and trains farmers in the skills needed to succeed, from pricing and packaging to inventory management and customer service.' },
            { icon: '🤝', title: 'Relationship building', body: 'Staff cultivate the buyer relationships that make each channel work, including chefs, food hub partners, market customers, and hunger relief coordinators across the region.' },
            { icon: '🛎️', title: 'Transaction concierge', body: 'For farmers who need it, SJCA staff walk through every transaction in person, from listing product online to coordinating delivery and processing payment.' },
          ].map((card) => (
            <div key={card.title} className="bg-white p-7 rounded-2xl border border-border transition-transform hover:-translate-y-0.5" style={{ boxShadow: '0 3px 16px rgba(20,46,27,0.05)' }}>
              <div className="w-[50px] h-[50px] rounded-xl flex items-center justify-center text-2xl mb-4 bg-green-50">{card.icon}</div>
              <h3 className="font-display font-semibold text-[18px] mb-2.5 leading-tight text-text">{card.title}</h3>
              <p className="text-sm leading-relaxed text-text-soft m-0">{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Closing CTA ── */}
      <section className="px-5 sm:px-10 py-12 md:py-16">
        <div className="max-w-[860px] mx-auto text-center">
          <h2 className="h-display mb-3" style={{ fontSize: 'clamp(26px, 4vw, 38px)' }}>Put all seven channels to work.</h2>
          <p className="text-[15px] text-text-soft mb-8 max-w-[460px] mx-auto">
            Join the network and your harvest reaches every channel — starting with a single text.
          </p>
          <div className="flex gap-3 justify-center flex-wrap">
            <a
              href={smsHref('Hi FarmLink! I want to join the network.')}
              className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full no-underline text-white font-bold text-[15px] transition-opacity hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)', boxShadow: '0 4px 18px rgba(42,94,51,0.3)' }}
            >
              <Icon name="msg" size={17} />
              Text {FARMLINK_NUMBER_DISPLAY}
            </a>
            <Link
              href="/signup"
              className="inline-flex items-center px-7 py-3.5 rounded-full no-underline bg-white text-text font-semibold text-[15px] border border-border hover:bg-earth-25 transition-colors"
            >
              Create a free account
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="text-center text-xs tracking-wide py-6 px-10" style={{ background: '#142E1B', color: 'rgba(255,255,255,0.6)' }}>
        St. Joseph Center of Arkansas &nbsp;&middot;&nbsp; A nonprofit network connecting Arkansas farmers to markets &nbsp;&middot;&nbsp; Text {FARMLINK_NUMBER_DISPLAY}
      </footer>

      <ChatWidget />
    </div>
  );
}
