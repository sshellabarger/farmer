'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { PhoneSMS } from '@/components/phone-sms';

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
  { from: 'app', text: 'Order confirmed! ✅\n\n🚜 Green Acres Farm will have it ready.\nPickup: Today by 4pm\n\nOrder #1247' },
  { from: 'user', text: 'do they have any herbs?' },
  { from: 'app', text: 'Yes! Green Acres has:\n\n🌿 Fresh Basil — 20 bunches · $2.50/bunch\n🌿 Cilantro — 15 bunches · $1.75/bunch\n🌿 Rosemary — 10 bunches · $3.00/bunch\n\nWant to add any to your order?' },
  { from: 'user', text: '10 basil' },
  { from: 'app', text: 'Added! Updated order #1247:\n\n🍅 40lb Cherokee Tomatoes — $119.60\n🌿 10 Fresh Basil — $25.00\n\nNew total: $144.60 ✅' },
];

const STATS = [
  { val: '2,400+', label: 'Orders this month' },
  { val: '< 30s', label: 'Average response time' },
  { val: '$89K', label: 'Weekly transaction volume' },
  { val: '98%', label: 'Farmer satisfaction' },
];

const STEPS = [
  { step: '01', emoji: '📱', title: 'Text Your Harvest', desc: "Send a text about what you've got. FarmLink understands natural language — just talk like you would to a friend.", example: '"Hey, 100lb Cherokee Tomatoes, picked today"' },
  { step: '02', emoji: '🔔', title: 'Markets Get Notified', desc: 'Priority markets see your listing first. Set delays so your best buyers always get first pick.', example: 'ABC Market gets 30 min head start' },
  { step: '03', emoji: '✅', title: 'Orders Roll In', desc: 'Markets text back their orders. Confirmation, totals, and pickup details — all handled automatically.', example: '"Order #1247 confirmed: 40lb @ $2.99"' },
];

const FEATURES = [
  { icon: 'msg', title: 'Natural Conversations', desc: "No commands to memorize. Text naturally and FarmLink's AI understands what you need — pricing, inventory, orders, and more.", color: '#2E6B34' },
  { icon: 'market', title: 'Priority Markets', desc: 'Rank your best buyers. They see your listings first, with configurable notification delays before inventory goes wide.', color: '#D4763C' },
  { icon: 'chart', title: 'Smart Dashboard', desc: 'When you need more than text, the web dashboard shows everything — inventory, orders, analytics, and full message history.', color: '#3B7DD8' },
  { icon: 'order', title: 'Standing Orders', desc: "Markets can set up recurring orders. Same items, same schedule, zero effort. Just text 'standing order' to manage them.", color: '#8B7355' },
  { icon: 'users', title: 'Multi-Market Reach', desc: 'List once, reach every market in your network. Or target specific buyers first. You control who sees what and when.', color: '#2E6B34' },
  { icon: 'zap', title: 'Instant Confirmations', desc: 'Both sides get immediate confirmation of orders, changes, and pickups. No phone tag, no missed messages, no confusion.', color: '#D4763C' },
];

const TESTIMONIALS = [
  { quote: 'I listed 200lb of peppers from my tractor seat. Had three orders before I got back to the barn.', name: 'James Whitfield', farm: 'Whitfield Family Farm', emoji: '🧑‍🌾' },
  { quote: 'We used to spend two hours a day on the phone with markets. Now it takes five minutes of texting.', name: 'Maria Santos', farm: 'Santos Organic Gardens', emoji: '👩‍🌾' },
  { quote: 'The priority market feature alone doubled our revenue from our top buyer. They love getting first pick.', name: 'Robert Chen', farm: 'Morning Dew Farms', emoji: '👨‍🌾' },
];

export default function LandingPage() {
  const router = useRouter();
  const [activeDemo, setActiveDemo] = useState<'farmer' | 'market'>('farmer');
  const [menuOpen, setMenuOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);

  const onEnterApp = () => router.push('/login');

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
          style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease' }}
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
            <video
              src="/farmlink-overview.mp4"
              controls
              autoPlay
              playsInline
              className="w-full h-full object-contain bg-black"
            />
          </div>
        </div>
      )}

      {/* ── NAV ── */}
      <nav className="sticky top-0 z-50 px-4 md:px-6 lg:px-10 py-3.5 flex items-center justify-between border-b border-border-light" style={{ background: 'rgba(250,248,245,0.92)', backdropFilter: 'blur(16px)' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
            <Icon name="leaf" size={18} className="text-white" />
          </div>
          <span className="font-display font-bold text-xl text-text tracking-tight">FarmLink</span>
        </div>
        <div className="flex items-center gap-4 md:gap-8">
          <div className="hidden md:flex items-center gap-8">
            {['Features', 'How It Works', 'Pricing'].map(item => (
              <a key={item} href="#" className="font-sans font-medium text-sm text-text-soft no-underline hover:text-text transition-colors">{item}</a>
            ))}
          </div>
          <button onClick={onEnterApp} className="hidden sm:block px-6 py-2.5 rounded-[10px] text-white border-none font-sans font-semibold text-sm cursor-pointer" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)', boxShadow: '0 2px 8px rgba(46,107,52,0.3)' }}>
            Login
          </button>
          {/* Mobile hamburger */}
          <button onClick={() => setMenuOpen(!menuOpen)} className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg border border-border bg-white cursor-pointer text-text-soft">
            <span className="text-lg">{menuOpen ? '✕' : '☰'}</span>
          </button>
        </div>
      </nav>
      {/* Mobile menu dropdown */}
      {menuOpen && (
        <div className="md:hidden border-b border-border-light bg-white px-4 py-3 flex flex-col gap-2 sticky top-[58px] z-40" style={{ animation: 'fadeIn 0.15s ease' }}>
          {['Features', 'How It Works', 'Pricing'].map(item => (
            <a key={item} href="#" className="font-sans font-medium text-sm text-text-soft no-underline py-2 px-3 rounded-lg hover:bg-bg transition-colors">{item}</a>
          ))}
          <button onClick={() => { onEnterApp(); setMenuOpen(false); }} className="mt-1 px-6 py-2.5 rounded-[10px] text-white border-none font-sans font-semibold text-sm cursor-pointer w-full" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
            Login
          </button>
        </div>
      )}

      {/* ── HERO ── */}
      <section className="px-4 md:px-6 lg:px-10 pt-10 md:pt-20 pb-10 md:pb-16 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* Left: Copy */}
          <div style={{ animation: 'fadeUp 0.8s ease' }}>
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-green-50 mb-4 md:mb-6">
              <Icon name="zap" size={14} className="text-green-600" />
              <span className="font-sans font-semibold text-xs text-green-600">Text-first farm sales</span>
            </div>
            <h1 className="font-display font-extrabold text-[32px] md:text-[44px] lg:text-[52px] leading-[1.1] text-text mb-4 md:mb-5 tracking-tight">
              Sell your harvest<br />
              <span className="text-green-600">with a text.</span>
            </h1>
            <p className="font-sans text-base md:text-lg leading-relaxed text-text-soft mb-7 md:mb-9 max-w-[440px]">
              FarmLink connects farmers and markets through natural text conversations. List inventory, take orders, and manage sales — all from your phone. No apps to download, no dashboards to learn.
            </p>
            <div className="flex gap-3 md:gap-3.5 flex-wrap">
              <button onClick={onEnterApp} className="px-6 md:px-8 py-3 md:py-3.5 rounded-xl text-white border-none font-sans font-bold text-sm md:text-base cursor-pointer flex items-center gap-2" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)', boxShadow: '0 4px 16px rgba(46,107,52,0.3)' }}>
                Try the Demo <Icon name="arrow" size={18} className="text-white" />
              </button>
              <button onClick={() => setVideoOpen(true)} className="px-5 md:px-7 py-3 md:py-3.5 rounded-xl bg-transparent text-text border-2 border-border font-sans font-semibold text-sm md:text-base cursor-pointer hover:bg-earth-25 transition-colors">
                Watch Video
              </button>
            </div>
            {/* Social proof */}
            <div className="flex items-center gap-4 mt-8 md:mt-10" style={{ animation: 'fadeUp 0.8s ease 0.3s both' }}>
              <div className="flex">
                {['🧑‍🌾', '👩‍🌾', '👨‍🌾', '🌻'].map((e, i) => (
                  <div key={i} className="w-9 h-9 rounded-full bg-green-50 flex items-center justify-center text-base border-2 border-bg relative" style={{ marginLeft: i > 0 ? -8 : 0, zIndex: 4 - i }}>
                    {e}
                  </div>
                ))}
              </div>
              <div>
                <div className="font-sans font-bold text-sm text-text">Trusted by 120+ farms</div>
                <div className="font-sans text-xs text-text-muted">across central Arkansas</div>
              </div>
            </div>
          </div>

          {/* Right: Phone Demo */}
          <div className="flex justify-center" style={{ animation: 'fadeUp 0.8s ease 0.2s both' }}>
            <div className="relative">
              {/* Glow */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] md:w-[360px] h-[300px] md:h-[360px] rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(46,107,52,0.08) 0%, transparent 70%)' }} />
              <div className="block md:hidden">
                <PhoneSMS
                  script={activeDemo === 'farmer' ? FARMER_SCRIPT : MARKET_SCRIPT}
                  title={activeDemo === 'farmer' ? 'Green Acres Farm' : 'ABC Market'}
                  autoPlay={true}
                  compact={true}
                  key={`m-${activeDemo}`}
                />
              </div>
              <div className="hidden md:block">
                <PhoneSMS
                  script={activeDemo === 'farmer' ? FARMER_SCRIPT : MARKET_SCRIPT}
                  title={activeDemo === 'farmer' ? 'Green Acres Farm' : 'ABC Market'}
                  autoPlay={true}
                  key={`d-${activeDemo}`}
                />
              </div>
              {/* Toggle */}
              <div className="flex gap-2 justify-center mt-4 md:mt-5">
                {[{ id: 'farmer' as const, label: 'Farmer View' }, { id: 'market' as const, label: 'Market View' }].map(v => (
                  <button key={v.id} onClick={() => setActiveDemo(v.id)} className="px-4 py-2 rounded-full font-sans font-semibold text-xs cursor-pointer transition-all"
                    style={{
                      background: activeDemo === v.id ? '#2E6B34' : '#fff',
                      color: activeDemo === v.id ? '#fff' : '#5C5C5C',
                      border: `1px solid ${activeDemo === v.id ? '#2E6B34' : '#E8E4DE'}`,
                    }}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── STATS BAR ── */}
      <section className="py-8 md:py-10" style={{ background: '#2E6B34' }}>
        <div className="max-w-[1000px] mx-auto grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8 text-center px-4 md:px-6">
          {STATS.map((s, i) => (
            <div key={i} style={{ animation: `fadeUp 0.6s ease ${i * 0.1}s both` }}>
              <div className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white">{s.val}</div>
              <div className="font-sans text-[11px] md:text-[13px] text-white/70 mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="py-12 md:py-20 px-4 md:px-6 lg:px-10 max-w-[1000px] mx-auto">
        <div className="text-center mb-8 md:mb-14">
          <h2 className="font-display font-extrabold text-[26px] md:text-[32px] lg:text-[38px] text-text mb-3 tracking-tight">How FarmLink Works</h2>
          <p className="font-sans text-sm md:text-base text-text-soft max-w-[500px] mx-auto">From field to market in three texts. No complicated apps or training required.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-7">
          {STEPS.map((item, i) => (
            <div key={i} className="bg-white rounded-[16px] md:rounded-[20px] p-6 md:p-8 border border-border relative overflow-hidden" style={{ animation: `fadeUp 0.6s ease ${i * 0.15}s both` }}>
              <div className="absolute top-4 right-5 font-display font-extrabold text-[48px] md:text-[64px] text-green-50 leading-none">{item.step}</div>
              <div className="text-3xl md:text-4xl mb-3 md:mb-4">{item.emoji}</div>
              <h3 className="font-display font-bold text-lg md:text-xl text-text mb-2">{item.title}</h3>
              <p className="font-sans text-sm leading-relaxed text-text-soft mb-4">{item.desc}</p>
              <div className="px-3 py-2 md:px-3.5 md:py-2.5 rounded-lg font-mono text-[11px] md:text-xs leading-relaxed" style={{ background: '#F5F0E8', color: '#8B7355' }}>{item.example}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES GRID ── */}
      <section className="py-12 md:py-16 px-4 md:px-6 lg:px-10 bg-bg-alt">
        <div className="max-w-[1000px] mx-auto">
          <div className="text-center mb-8 md:mb-12">
            <h2 className="font-display font-extrabold text-[26px] md:text-[32px] lg:text-[38px] text-text mb-3 tracking-tight">Everything You Need</h2>
            <p className="font-sans text-sm md:text-base text-text-soft">Powerful features that stay out of your way.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
            {FEATURES.map((f, i) => (
              <div key={i} className="bg-white rounded-[16px] md:rounded-[20px] p-5 md:p-7 border border-border flex gap-3.5 md:gap-4.5 items-start" style={{ animation: `fadeUp 0.5s ease ${i * 0.08}s both` }}>
                <div className="w-10 md:w-11 h-10 md:h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${f.color}10` }}>
                  <Icon name={f.icon} size={20} style={{ color: f.color }} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-[15px] md:text-[17px] text-text mb-1">{f.title}</h3>
                  <p className="font-sans text-[13px] leading-relaxed text-text-soft m-0">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section className="py-12 md:py-20 px-4 md:px-6 lg:px-10 max-w-[1000px] mx-auto">
        <h2 className="font-display font-extrabold text-[26px] md:text-[32px] lg:text-[38px] text-text text-center mb-8 md:mb-12 tracking-tight">What Farmers Say</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
          {TESTIMONIALS.map((t, i) => (
            <div key={i} className="bg-white rounded-[20px] p-7 border border-border" style={{ animation: `fadeUp 0.6s ease ${i * 0.1}s both` }}>
              <div className="flex gap-1 mb-3.5">
                {[0, 1, 2, 3, 4].map(s => <span key={s}><Icon name="star" size={16} className="text-[#E8B931]" /></span>)}
              </div>
              <p className="font-sans text-sm leading-relaxed text-text-soft mb-5 italic">&ldquo;{t.quote}&rdquo;</p>
              <div className="flex items-center gap-2.5 border-t border-border-light pt-4">
                <div className="w-[38px] h-[38px] rounded-full bg-green-50 flex items-center justify-center text-lg">{t.emoji}</div>
                <div>
                  <div className="font-sans font-bold text-[13px] text-text">{t.name}</div>
                  <div className="font-sans text-xs text-text-muted">{t.farm}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-10 md:py-16 px-4 md:px-6 lg:px-10">
        <div className="max-w-[800px] mx-auto rounded-2xl md:rounded-3xl px-6 md:px-8 lg:px-12 py-10 md:py-14 text-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
          <div className="absolute -top-[30px] -right-[30px] w-[200px] h-[200px] rounded-full bg-white/[0.06]" />
          <div className="absolute -bottom-10 -left-5 w-[160px] h-[160px] rounded-full bg-white/[0.04]" />
          <h2 className="font-display font-extrabold text-2xl md:text-3xl lg:text-4xl text-white mb-3 relative">Ready to simplify your sales?</h2>
          <p className="font-sans text-sm md:text-base text-white/85 mb-6 md:mb-8 relative">Start selling with a text. Setup takes 5 minutes.</p>
          <div className="flex gap-3 md:gap-3.5 justify-center relative flex-wrap">
            <button onClick={onEnterApp} className="px-7 md:px-9 py-3 md:py-3.5 rounded-xl bg-white border-none font-sans font-bold text-sm md:text-base cursor-pointer" style={{ color: '#2E6B34', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
              Get Started Free
            </button>
            <button className="px-5 md:px-7 py-3 md:py-3.5 rounded-xl font-sans font-semibold text-sm md:text-base text-white cursor-pointer" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)' }}>
              Contact Sales
            </button>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="py-8 md:py-10 px-4 md:px-6 lg:px-10 border-t border-border max-w-[1000px] mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
              <Icon name="leaf" size={14} className="text-white" />
            </div>
            <span className="font-display font-bold text-base text-text">FarmLink</span>
          </div>
          <div className="font-sans text-[13px] text-text-muted">&copy; 2026 FarmLink. Connecting farms and markets.</div>
        </div>
      </footer>
    </div>
  );
}
