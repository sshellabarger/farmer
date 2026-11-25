'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { Header } from '@/components/header';
import { PhoneSMS } from '@/components/phone-sms';
import { FARMLINK_NUMBER_DISPLAY, smsHref, DEPOT_ADDRESS } from '@/lib/constants';

const FARMER_SCRIPT = [
  { from: 'user', text: "Hey, I've got 100lb of Cherokee Tomatoes" },
  { from: 'app', text: 'Nice! 🍅 Harvested today?' },
  { from: 'user', text: 'yes' },
  { from: 'app', text: "I don't see a price set for Cherokee Tomatoes. What do you want to sell them for?" },
  { from: 'user', text: '2.99 lb' },
  { from: 'app', text: 'Got it — Cherokee Tomatoes, 100lb @ $2.99/lb.\n\nNotify all markets?' },
  { from: 'user', text: 'nope let ABC market know first, then everyone else' },
  { from: 'app', text: 'Done! ✅\n\n📱 ABC Market notified first\n⏱️ Other markets will see it in 30 min\n\nAnything else to list?' },
];

const MARKET_SCRIPT = [
  { from: 'app', text: '🌿 New from Green Acres Farm:\n\nCherokee Tomatoes\n100lb available · $2.99/lb\nHarvested today\n\nWant to order?' },
  { from: 'user', text: 'yes, 40lb' },
  { from: 'app', text: '40lb Cherokee Tomatoes @ $2.99/lb\nTotal: $119.60\n\nConfirm order?' },
  { from: 'user', text: 'yes' },
  { from: 'app', text: 'Order confirmed! ✅\n\n📍 Pickup at FarmLink Depot\n10301 N Rodney Parham Rd, STE C1\n\nOrder #1247' },
  { from: 'user', text: 'do they have any herbs?' },
  { from: 'app', text: 'Yes! Green Acres has:\n\n🌿 Fresh Basil — 20 bunches · $2.50/bunch\n🌿 Cilantro — 15 bunches · $1.75/bunch\n\nWant to add any to your order?' },
  { from: 'user', text: '10 basil' },
  { from: 'app', text: 'Added! Updated order #1247:\n\n🍅 40lb Cherokee Tomatoes — $119.60\n🌿 10 Fresh Basil — $25.00\n\nNew total: $144.60 ✅' },
];

const PROOF_POINTS = [
  { val: '1 text', label: 'is all it takes to list your harvest' },
  { val: '< 30 sec', label: 'typical reply from the FarmLink AI' },
  { val: '7', label: 'revenue channels in one network' },
  { val: '$0', label: 'cost to farmers during the pilot' },
];

const STEPS = [
  {
    step: '01',
    emoji: '📱',
    title: 'Text your harvest',
    desc: 'Send a text about what you picked. FarmLink understands plain language — just talk like you would to a friend.',
    example: '"Hey, 100lb Cherokee Tomatoes, picked today"',
  },
  {
    step: '02',
    emoji: '🔔',
    title: 'Buyers get notified',
    desc: 'Restaurants, groceries, food banks, and schools see your listing — your best buyers first, with a head start you control.',
    example: 'ABC Market gets a 30 min head start',
  },
  {
    step: '03',
    emoji: '📍',
    title: 'Drop off, get paid',
    desc: 'Bring orders to the FarmLink Depot. Buyers pick up from the same spot. One address, zero coordination hassle.',
    example: 'One depot · Drop-off and pickup same day',
  },
];

const FARMER_BENEFITS = [
  'List inventory from the tractor seat — one text and it’s live',
  'Priority buyers get first pick; you control who sees what, and when',
  'Standing orders repeat themselves — same items, same schedule',
  'Seven revenue channels so no harvest goes to waste',
];

const MARKET_BENEFITS = [
  'First pick of local harvests, delivered to your phone',
  'Order by reply — confirmations, totals, and pickup details in seconds',
  'Standing orders for staples; substitutions handled by text',
  'One depot pickup point — no farm-by-farm coordination',
];

const FEATURES = [
  { icon: 'msg', title: 'Natural conversations', desc: 'No commands to memorize. Text naturally and the AI handles pricing, inventory, orders, and more.' },
  { icon: 'zap', title: 'Priority notifications', desc: 'Rank your best buyers. They see listings first, with configurable delays before inventory goes wide.' },
  { icon: 'repeat', title: 'Standing orders', desc: 'Recurring orders run themselves. Markets text a substitution or "skip" — that’s the whole workflow.' },
  { icon: 'truck', title: 'One depot', desc: 'Farmers drop off, buyers pick up — one central Little Rock location instead of a dozen delivery runs.' },
  { icon: 'users', title: 'Every kind of buyer', desc: 'Restaurants, groceries, food hubs, food banks, schools, and co-ops — list once, reach the whole network.' },
  { icon: 'chart', title: 'A dashboard when you want it', desc: 'The web app shows inventory, orders, and your full message history. Same brain, same thread as your texts.' },
];

const CHANNEL_PREVIEW = [
  { name: 'Farmers markets', pct: 100, note: '~100% to farmer' },
  { name: 'SJCA online market', pct: 85, note: '85%' },
  { name: 'The Farm Stop', pct: 72, note: '70–75%' },
  { name: 'Chef direct', pct: 58, note: 'Above wholesale' },
  { name: 'Wholesale food hub', pct: 42, note: 'Volume' },
  { name: 'Processing seconds', pct: 25, note: 'Recovery' },
  { name: 'Donation', pct: 15, note: 'Tax value' },
];

export default function LandingPage() {
  const router = useRouter();
  const [activeDemo, setActiveDemo] = useState<'farmer' | 'market'>('farmer');
  const [videoOpen, setVideoOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg font-sans">
      {/* ── VIDEO MODAL ── */}
      {videoOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="FarmLink overview video"
          onClick={() => setVideoOpen(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(20,46,27,0.82)', backdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[960px] rounded-2xl overflow-hidden bg-black shadow-2xl"
            style={{ aspectRatio: '16 / 9' }}
          >
            <button
              onClick={() => setVideoOpen(false)}
              aria-label="Close video"
              className="absolute top-3 right-3 z-10 w-10 h-10 rounded-full flex items-center justify-center text-white border-none cursor-pointer font-sans font-bold text-lg"
              style={{ background: 'rgba(0,0,0,0.6)' }}
            >
              ✕
            </button>
            <video src="/farmlink-overview.mp4" controls autoPlay playsInline className="w-full h-full object-contain bg-black" />
          </div>
        </div>
      )}

      <Header />

      {/* ── HERO ── */}
      <section className="px-4 md:px-6 lg:px-10 pt-12 md:pt-20 pb-12 md:pb-20 max-w-[1180px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Copy */}
          <div style={{ animation: 'fadeUp 0.8s ease' }}>
            <div className="kicker mb-5">Built for Arkansas farms · No app required</div>
            <h1 className="h-display mb-5" style={{ fontSize: 'clamp(38px, 6vw, 60px)' }}>
              Sell your harvest
              <br />
              <span className="text-green-600 italic">with a text.</span>
            </h1>
            <p className="text-[16px] md:text-[18px] leading-relaxed text-text-soft mb-8 max-w-[460px]">
              FarmLink connects farmers with restaurants, groceries, food banks, and schools through
              plain text messages. List inventory, take orders, drop off at one depot — all from the
              phone already in your pocket.
            </p>
            <div className="flex gap-3 flex-wrap items-center">
              <a
                href={smsHref('Hi FarmLink! I want to sell my harvest.')}
                className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full no-underline text-white font-bold text-[15px] md:text-base transition-opacity hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)', boxShadow: '0 4px 18px rgba(42,94,51,0.32)' }}
              >
                <Icon name="msg" size={18} />
                Text {FARMLINK_NUMBER_DISPLAY}
              </a>
              <button
                onClick={() => router.push('/signup')}
                className="px-7 py-3.5 rounded-full bg-white text-text font-semibold text-[15px] md:text-base cursor-pointer border border-border hover:bg-earth-25 transition-colors"
              >
                Create a free account
              </button>
            </div>
            <button
              onClick={() => setVideoOpen(true)}
              className="mt-5 inline-flex items-center gap-2 bg-transparent border-none cursor-pointer text-green-700 font-semibold text-sm hover:text-green-600 px-0"
            >
              <span className="w-8 h-8 rounded-full bg-green-50 flex items-center justify-center">▶</span>
              Watch the 90-second overview
            </button>
            <div className="mt-8 pt-6 border-t border-border-light flex items-center gap-3 max-w-[460px]" style={{ animation: 'fadeUp 0.8s ease 0.3s both' }}>
              <img src="/SJCA_logo_transparent.png" alt="St. Joseph Center of Arkansas" className="h-10 w-auto" />
              <p className="text-[13px] text-text-muted leading-snug m-0">
                A nonprofit network by the <strong className="text-text-soft font-semibold">St. Joseph Center of Arkansas</strong> —
                built so more of every food dollar reaches the grower.
              </p>
            </div>
          </div>

          {/* Phone demo */}
          <div className="flex flex-col items-center" style={{ animation: 'fadeUp 0.8s ease 0.2s both' }}>
            <div className="relative">
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] md:w-[400px] h-[320px] md:h-[400px] rounded-full pointer-events-none"
                style={{ background: 'radial-gradient(circle, rgba(42,94,51,0.09) 0%, transparent 70%)' }}
              />
              <div className="block md:hidden">
                <PhoneSMS script={activeDemo === 'farmer' ? FARMER_SCRIPT : MARKET_SCRIPT} title="FarmLink" autoPlay compact key={`m-${activeDemo}`} />
              </div>
              <div className="hidden md:block">
                <PhoneSMS script={activeDemo === 'farmer' ? FARMER_SCRIPT : MARKET_SCRIPT} title="FarmLink" autoPlay key={`d-${activeDemo}`} />
              </div>
            </div>
            <div className="flex gap-2 justify-center mt-5">
              {[
                { id: 'farmer' as const, label: '🌾 As a farmer' },
                { id: 'market' as const, label: '🏪 As a buyer' },
              ].map(v => (
                <button
                  key={v.id}
                  onClick={() => setActiveDemo(v.id)}
                  className={`px-4 py-2 rounded-full font-semibold text-[13px] cursor-pointer transition-all border ${
                    activeDemo === v.id ? 'bg-green-600 text-white border-green-600' : 'bg-white text-text-soft border-border'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── PROOF BAR ── */}
      <section className="py-9 md:py-12" style={{ background: '#1B3F24' }}>
        <div className="max-w-[1020px] mx-auto grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8 text-center px-4 md:px-6">
          {PROOF_POINTS.map((s, i) => (
            <div key={i} style={{ animation: `fadeUp 0.6s ease ${i * 0.1}s both` }}>
              <div className="font-display font-semibold text-[28px] md:text-[34px] text-white tracking-tight">{s.val}</div>
              <div className="text-[12px] md:text-[13px] mt-1.5 leading-snug" style={{ color: 'rgba(255,255,255,0.66)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="py-14 md:py-24 px-4 md:px-6 lg:px-10 max-w-[1020px] mx-auto scroll-mt-16">
        <div className="text-center mb-10 md:mb-14">
          <div className="kicker mb-3">How it works</div>
          <h2 className="h-display mb-3" style={{ fontSize: 'clamp(28px, 4vw, 40px)' }}>From field to market in three texts</h2>
          <p className="text-[15px] md:text-base text-text-soft max-w-[480px] mx-auto">No complicated apps. No training. If you can send a text, you already know how to use FarmLink.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
          {STEPS.map((item, i) => (
            <div key={i} className="bg-white rounded-[20px] p-7 md:p-8 border border-border relative overflow-hidden" style={{ animation: `fadeUp 0.6s ease ${i * 0.15}s both` }}>
              <div className="absolute top-4 right-5 font-display font-semibold text-[56px] md:text-[68px] text-green-50 leading-none select-none">{item.step}</div>
              <div className="text-3xl md:text-4xl mb-4 relative">{item.emoji}</div>
              <h3 className="font-display font-semibold text-[19px] md:text-[21px] text-text mb-2 relative">{item.title}</h3>
              <p className="text-sm leading-relaxed text-text-soft mb-5 relative">{item.desc}</p>
              <div className="px-3.5 py-2.5 rounded-lg font-mono text-[11px] md:text-xs leading-relaxed bg-clay-50 text-clay-500 relative">{item.example}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── FOR FARMS / FOR MARKETS ── */}
      <section id="for-you" className="py-14 md:py-20 px-4 md:px-6 lg:px-10 bg-bg-alt scroll-mt-16">
        <div className="max-w-[1020px] mx-auto">
          <div className="text-center mb-10 md:mb-12">
            <div className="kicker mb-3">Who it&apos;s for</div>
            <h2 className="h-display mb-3" style={{ fontSize: 'clamp(28px, 4vw, 40px)' }}>Built for both sides of the table</h2>
            <p className="text-[15px] md:text-base text-text-soft max-w-[520px] mx-auto">Growers list it. Buyers grab it. The network handles everything in between.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-6">
            {/* Farmer card */}
            <div className="bg-white rounded-[24px] p-7 md:p-9 border border-border flex flex-col" style={{ animation: 'fadeUp 0.6s ease both' }}>
              <div className="text-4xl mb-4">🌾</div>
              <h3 className="font-display font-semibold text-[22px] md:text-[24px] text-text mb-1.5">For farms &amp; growers</h3>
              <p className="text-sm text-text-soft mb-5">Spend your time growing — not making phone calls, driving routes, or learning software.</p>
              <ul className="list-none p-0 m-0 mb-7 flex flex-col gap-3">
                {FARMER_BENEFITS.map(b => (
                  <li key={b} className="flex items-start gap-2.5 text-sm text-text-soft leading-relaxed">
                    <span className="mt-0.5 w-5 h-5 rounded-full bg-green-50 flex items-center justify-center shrink-0">
                      <Icon name="check" size={12} className="text-green-600" />
                    </span>
                    {b}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => router.push('/signup?role=farmer')}
                className="mt-auto w-full py-3.5 rounded-full text-white font-bold text-[15px] cursor-pointer border-none transition-opacity hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
              >
                Start selling →
              </button>
            </div>
            {/* Market card */}
            <div className="bg-white rounded-[24px] p-7 md:p-9 border border-border flex flex-col" style={{ animation: 'fadeUp 0.6s ease 0.12s both' }}>
              <div className="text-4xl mb-4">🏪</div>
              <h3 className="font-display font-semibold text-[22px] md:text-[24px] text-text mb-1.5">For markets &amp; buyers</h3>
              <p className="text-sm text-text-soft mb-5">Restaurants, groceries, food hubs, food banks, schools, and co-ops sourcing truly local food.</p>
              <ul className="list-none p-0 m-0 mb-7 flex flex-col gap-3">
                {MARKET_BENEFITS.map(b => (
                  <li key={b} className="flex items-start gap-2.5 text-sm text-text-soft leading-relaxed">
                    <span className="mt-0.5 w-5 h-5 rounded-full bg-accent-50 flex items-center justify-center shrink-0">
                      <Icon name="check" size={12} className="text-accent-500" />
                    </span>
                    {b}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => router.push('/signup?role=market')}
                className="mt-auto w-full py-3.5 rounded-full font-bold text-[15px] cursor-pointer border-2 border-green-600 bg-transparent text-green-700 hover:bg-green-50 transition-colors"
              >
                Start buying →
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="py-14 md:py-24 px-4 md:px-6 lg:px-10 max-w-[1020px] mx-auto">
        <div className="text-center mb-10 md:mb-12">
          <div className="kicker mb-3">Under the hood</div>
          <h2 className="h-display mb-3" style={{ fontSize: 'clamp(28px, 4vw, 40px)' }}>Powerful, and it stays out of your way</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {FEATURES.map((f, i) => (
            <div key={i} className="bg-white rounded-[20px] p-6 md:p-7 border border-border" style={{ animation: `fadeUp 0.5s ease ${i * 0.08}s both` }}>
              <div className="w-11 h-11 rounded-xl bg-green-50 flex items-center justify-center mb-4">
                <Icon name={f.icon} size={20} className="text-green-600" />
              </div>
              <h3 className="font-display font-semibold text-[17px] text-text mb-1.5">{f.title}</h3>
              <p className="text-[13.5px] leading-relaxed text-text-soft m-0">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── REVENUE NETWORK TEASER ── */}
      <section className="px-4 md:px-6 lg:px-10 pb-14 md:pb-24">
        <div className="max-w-[1020px] mx-auto rounded-[28px] overflow-hidden" style={{ background: '#142E1B' }}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center p-8 md:p-12">
            <div>
              <div className="kicker mb-3" style={{ color: '#7BC487' }}>The Revenue Network</div>
              <h2 className="font-display font-semibold text-white mb-4 tracking-tight" style={{ fontSize: 'clamp(26px, 3.6vw, 38px)', lineHeight: 1.12 }}>
                One harvest,
                <br />
                seven ways to earn.
              </h2>
              <p className="text-[15px] leading-relaxed mb-7" style={{ color: 'rgba(255,255,255,0.72)' }}>
                Most farms rely on one buyer and absorb all the risk. FarmLink growers sell through
                seven channels — from full-retail farmers markets to chef-direct, wholesale, seconds
                processing, and tax-deductible donation. No harvest goes to waste.
              </p>
              <Link
                href="/about"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full no-underline bg-white font-bold text-[14.5px] text-green-800 transition-opacity hover:opacity-90"
              >
                Explore the Revenue Network <Icon name="arrow" size={16} />
              </Link>
            </div>
            <div className="flex flex-col gap-2.5">
              {CHANNEL_PREVIEW.map((c, i) => (
                <div key={c.name} className="flex items-center gap-3">
                  <div className="w-[132px] md:w-[150px] shrink-0 text-right text-[12px] font-semibold" style={{ color: 'rgba(255,255,255,0.78)' }}>{c.name}</div>
                  <div className="flex-1 h-[18px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${c.pct}%`,
                        background: 'linear-gradient(90deg, #3D7A47, #7BC487)',
                        animation: `growBar 1s ease ${0.15 + i * 0.08}s both`,
                      }}
                    />
                  </div>
                  <div className="w-[92px] shrink-0 text-[11px] font-semibold" style={{ color: '#7BC487' }}>{c.note}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── NONPROFIT TRUST BAND ── */}
      <section className="px-4 md:px-6 lg:px-10 pb-14 md:pb-24">
        <div className="max-w-[1020px] mx-auto bg-white rounded-[24px] border border-border p-7 md:p-10 flex flex-col md:flex-row items-start md:items-center gap-6">
          <img src="/SJCA_logo_transparent.png" alt="St. Joseph Center of Arkansas logo" className="h-16 w-auto shrink-0" />
          <div className="flex-1">
            <h3 className="font-display font-semibold text-[20px] md:text-[22px] text-text mb-2">A nonprofit network means more money to the farmer</h3>
            <p className="text-sm leading-relaxed text-text-soft m-0">
              FarmLink is run by the <strong className="font-semibold text-text">St. Joseph Center of Arkansas</strong>, a nonprofit.
              There&apos;s no profit margin to feed — only operating costs to cover — so every channel is engineered
              to send the maximum possible share of each food dollar to the people growing the food.
            </p>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="px-4 md:px-6 lg:px-10 pb-16 md:pb-24">
        <div
          className="max-w-[860px] mx-auto rounded-[28px] px-6 md:px-12 py-12 md:py-16 text-center relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
        >
          <div className="absolute -top-[40px] -right-[40px] w-[220px] h-[220px] rounded-full bg-white/[0.06]" />
          <div className="absolute -bottom-12 -left-6 w-[180px] h-[180px] rounded-full bg-white/[0.05]" />
          <div className="relative">
            <h2 className="font-display font-semibold text-white mb-3 tracking-tight" style={{ fontSize: 'clamp(28px, 4.5vw, 42px)' }}>
              Your next sale is one text away.
            </h2>
            <p className="text-[15px] md:text-base mb-8" style={{ color: 'rgba(255,255,255,0.82)' }}>
              Free during the Little Rock pilot. Setup takes five minutes — most of it is saying hello.
            </p>
            <div className="flex gap-3 justify-center flex-wrap">
              <a
                href={smsHref('Hi FarmLink!')}
                className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-full no-underline bg-white font-bold text-[15px] md:text-base text-green-800"
                style={{ boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}
              >
                <Icon name="msg" size={18} />
                Text {FARMLINK_NUMBER_DISPLAY}
              </a>
              <button
                onClick={() => router.push('/signup')}
                className="px-7 py-3.5 rounded-full font-semibold text-[15px] md:text-base text-white cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.32)' }}
              >
                Sign up on the web
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-border bg-bg-alt">
        <div className="max-w-[1020px] mx-auto px-4 md:px-6 lg:px-10 py-10 md:py-12">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}>
                  <Icon name="leaf" size={14} className="text-white" />
                </div>
                <span className="font-display font-semibold text-[17px] text-text">FarmLink</span>
              </div>
              <p className="text-[13px] text-text-muted leading-relaxed m-0">
                A text-first local food network by the St. Joseph Center of Arkansas, a nonprofit.
              </p>
            </div>
            <div>
              <div className="font-semibold text-[13px] text-text mb-3 uppercase tracking-wide">Explore</div>
              <div className="flex flex-col gap-2">
                <a href="/#how-it-works" className="text-[13.5px] text-text-soft no-underline hover:text-text">How it works</a>
                <Link href="/about" className="text-[13.5px] text-text-soft no-underline hover:text-text">Revenue Network</Link>
                <Link href="/signup" className="text-[13.5px] text-text-soft no-underline hover:text-text">Create an account</Link>
                <Link href="/login" className="text-[13.5px] text-text-soft no-underline hover:text-text">Sign in</Link>
              </div>
            </div>
            <div>
              <div className="font-semibold text-[13px] text-text mb-3 uppercase tracking-wide">Reach us</div>
              <div className="flex flex-col gap-2">
                <a href={smsHref()} className="text-[13.5px] font-semibold text-green-700 no-underline">📱 Text {FARMLINK_NUMBER_DISPLAY}</a>
                <span className="text-[13.5px] text-text-soft">📍 FarmLink Depot · {DEPOT_ADDRESS}</span>
              </div>
            </div>
          </div>
          <div className="pt-6 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-3">
            <div className="text-[12.5px] text-text-muted">&copy; 2026 FarmLink · St. Joseph Center of Arkansas</div>
            <div className="flex gap-5">
              <a href="/privacy.html" className="text-[12.5px] text-text-muted no-underline hover:text-text-soft">Privacy</a>
              <a href="/terms.html" className="text-[12.5px] text-text-muted no-underline hover:text-text-soft">Terms</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
