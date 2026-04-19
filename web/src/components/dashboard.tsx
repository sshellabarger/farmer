'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';
import { useAuth } from '@/lib/auth-context';
import { api, type ConversationSummary, type ChatMessage } from '@/lib/api';

/* ─── Types ─── */
interface Convo {
  id: string;
  phone_number: string;
  name: string;
  avatar: string;
  lastMsg: string;
  time: string;
  unread: number;
  role: 'market' | 'farmer' | 'system';
}

interface DisplayMessage {
  id: string;
  from: 'user' | 'app';
  text: string;
  time: string;
}

type MobileView = 'list' | 'chat' | 'panel';

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function avatarForRole(role: string): string {
  if (role === 'market') return '🏪';
  if (role === 'farmer') return '🌾';
  return '🌱';
}

function toConvo(c: ConversationSummary): Convo {
  return {
    id: c.id,
    phone_number: c.phone_number,
    name: c.user_name || c.phone_number,
    avatar: avatarForRole(c.user_role),
    lastMsg: c.last_message || '',
    time: c.last_message_at ? formatTime(c.last_message_at) : '',
    unread: 0,
    role: (c.user_role as Convo['role']) || 'system',
  };
}

function toDisplayMessages(msgs: ChatMessage[]): DisplayMessage[] {
  return msgs.map(m => ({
    id: m.id,
    from: m.direction === 'inbound' ? 'user' as const : 'app' as const,
    text: m.body,
    time: formatMessageTime(m.created_at),
  }));
}

/* ─── Dashboard Component ─── */
interface DashboardProps {
  viewAs?: 'farmer' | 'market';
}

export function Dashboard({ viewAs }: DashboardProps) {
  const router = useRouter();
  const { user, farm, market, isAuthenticated, isLoading: authLoading } = useAuth();
  const [conversations, setConversations] = useState<Convo[]>([]);
  const [activeConvo, setActiveConvo] = useState<Convo | null>(null);
  const [sidePanel, setSidePanel] = useState<'orders' | 'inventory' | 'markets'>('orders');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<DisplayMessage[]>([]);
  const [convoFilter, setConvoFilter] = useState('All');
  const [mobileView, setMobileView] = useState<MobileView>('list');
  const [sending, setSending] = useState(false);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [headerStats, setHeaderStats] = useState({ orders: '—', listings: '—' });

  const scrollRef = useRef<HTMLDivElement>(null);
  // viewAs prop determines which view to show (especially for "both" role users)
  const isFarmer = viewAs === 'farmer' || (!viewAs && (user?.role === 'farmer' || !!farm));
  const isMarket = viewAs === 'market' || (!viewAs && user?.role === 'market');

  // Load conversations on mount
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    // Load conversations for the user AND their farm/market partners
    const convoParams: { farm_id?: string; market_id?: string } = {};
    if (farm?.id) convoParams.farm_id = farm.id;
    if (market?.id) convoParams.market_id = market.id;
    api.getConversations(Object.keys(convoParams).length > 0 ? convoParams : undefined)
      .then(data => {
        setConversations(data.conversations.map(toConvo));
      })
      .catch(err => console.error('Failed to load conversations:', err))
      .finally(() => setLoadingConvos(false));

    // Load header stats — use view-specific endpoints for accurate counts
    const useFarmView = isFarmer && !!farm?.id;
    const useMarketView = isMarket && !useFarmView && !!market?.id;
    const ordersPromise = useFarmView
      ? api.getFarmOrders(farm!.id).catch(() => null)
      : useMarketView
        ? api.getMarketOrders(market!.id).catch(() => null)
        : api.getOrders().catch(() => null);
    const inventoryPromise = useFarmView
      ? api.getFarmInventory(farm!.id).catch(() => null)
      : useMarketView
        ? api.getMarketAvailable(market!.id).catch(() => null)
        : api.getInventory().catch(() => null);

    Promise.all([ordersPromise, inventoryPromise]).then(([ord, inv]) => {
      const allOrders = ord?.orders || [];
      const activeOrders = allOrders.filter((o: any) => o.status !== 'delivered' && o.status !== 'cancelled');
      setHeaderStats({
        orders: String(activeOrders.length),
        listings: String((inv?.inventory || []).length),
      });
    });
  }, [authLoading, isAuthenticated, router, farm?.id, market?.id, isFarmer, isMarket]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chatMessages]);

  const selectConvo = useCallback(async (convo: Convo) => {
    setActiveConvo(convo);
    setMobileView('chat');
    setLoadingMessages(true);
    try {
      const data = await api.getChatHistory(convo.phone_number);
      setChatMessages(toDisplayMessages(data.messages));
    } catch (err) {
      console.error('Failed to load messages:', err);
      setChatMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const handleSend = useCallback(async () => {
    if (!chatInput.trim() || !activeConvo || sending) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { id: `tmp-${Date.now()}`, from: 'user', text: userMsg, time: 'Just now' }]);
    setSending(true);
    try {
      const data = await api.sendChat(activeConvo.phone_number, userMsg);
      setChatMessages(prev => [...prev, { id: `resp-${Date.now()}`, from: 'app', text: data.response, time: 'Just now' }]);
      // Update last message in conversation list
      setConversations(prev => prev.map(c =>
        c.id === activeConvo.id ? { ...c, lastMsg: data.response, time: 'Just now' } : c
      ));
    } catch (err) {
      console.error('Failed to send message:', err);
      setChatMessages(prev => [...prev, { id: `err-${Date.now()}`, from: 'app', text: 'Sorry, something went wrong. Please try again.', time: 'Just now' }]);
    } finally {
      setSending(false);
    }
  }, [chatInput, activeConvo, sending]);

  // Start new conversation with FarmLink (own phone)
  const startNewConvo = useCallback(() => {
    if (!user) return;
    const newConvo: Convo = {
      id: 'farmlink',
      phone_number: user.phone,
      name: 'FarmLink',
      avatar: '🌱',
      lastMsg: '',
      time: '',
      unread: 0,
      role: 'system',
    };
    selectConvo(newConvo);
  }, [user, selectConvo]);

  const filteredConvos = convoFilter === 'All' ? conversations :
    convoFilter === 'Partners' ? conversations.filter(c => (isFarmer ? c.role === 'market' : c.role === 'farmer')) :
    conversations.filter(c => c.role === 'system');

  return (
    <div className="h-screen flex flex-col bg-bg font-sans">
      {/* ── Top Bar ── */}
      <header className="px-3 md:px-5 py-2.5 flex items-center justify-between bg-white border-b border-border shrink-0">
        <div className="flex items-center gap-2 md:gap-3.5">
          <button onClick={() => router.push('/')} className="bg-transparent border-none cursor-pointer flex items-center gap-1.5 text-text-soft font-sans text-[13px] font-medium p-0">
            <Icon name="back" size={16} className="text-text-muted" /> <span className="hidden sm:inline">Overview</span>
          </button>
          <div className="w-px h-5 bg-border" />
          <div className="flex items-center gap-2">
            <div className="w-[30px] h-[30px] rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
              <Icon name="leaf" size={15} className="text-white" />
            </div>
            <div className="font-display font-bold text-sm md:text-[15px] text-text">{isFarmer ? (farm?.name || user?.name) : (market?.name || user?.name)} </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex gap-4 mr-4">
            {[
              { label: 'Active Orders', val: headerStats.orders, color: '#D4763C' },
              { label: isFarmer ? 'Inventory' : 'Available Items', val: headerStats.listings, color: '#3B7DD8' },
            ].map((s, i) => (
              <div key={i} className="text-right">
                <div className="font-sans text-[10px] text-text-muted uppercase tracking-wider">{s.label}</div>
                <div className="font-mono text-[15px] font-bold" style={{ color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>
          <button onClick={() => router.push('/settings')} className="w-[34px] h-[34px] rounded-lg bg-bg border border-border cursor-pointer flex items-center justify-center">
            <Icon name="settings" size={16} className="text-text-muted" />
          </button>
        </div>
      </header>

      {/* ── Mobile Bottom Nav ── */}
      <div className="md:hidden flex border-b border-border bg-white shrink-0">
        {[
          { id: 'list' as MobileView, icon: 'msg', label: 'Messages' },
          { id: 'chat' as MobileView, icon: 'send', label: 'Chat' },
          { id: 'panel' as MobileView, icon: 'order', label: 'Info' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setMobileView(tab.id)} className="flex-1 py-2.5 border-none cursor-pointer flex flex-col items-center gap-0.5 transition-all"
            style={{
              background: mobileView === tab.id ? '#E8F5E3' : 'transparent',
              borderBottom: mobileView === tab.id ? '2px solid #2E6B34' : '2px solid transparent',
            }}>
            <Icon name={tab.icon} size={16} className={mobileView === tab.id ? 'text-green-600' : 'text-text-muted'} />
            <span className={`font-sans text-[10px] font-semibold ${mobileView === tab.id ? 'text-green-600' : 'text-text-muted'}`}>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* ── Main Area ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: Conversation List — visible on md+ or when mobileView=list */}
        <div suppressHydrationWarning className={`w-full md:w-[280px] border-r border-border flex-col bg-white shrink-0 ${mobileView === 'list' ? 'flex' : 'hidden'} md:flex`}>
          {/* Search */}
          <div className="p-3.5 border-b border-border-light">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg border border-border">
              <Icon name="search" size={14} className="text-text-muted" />
              <input placeholder="Search messages..." className="border-none bg-transparent font-sans text-[13px] text-text outline-none w-full" />
            </div>
          </div>
          {/* Filter tabs */}
          <div className="flex px-3.5 py-2 gap-1.5">
            {['All', 'Partners', 'System'].map(tab => (
              <button key={tab} onClick={() => setConvoFilter(tab)} className="px-3 py-1 rounded-md text-xs font-semibold font-sans border-none cursor-pointer"
                style={{
                  background: convoFilter === tab ? '#E8F5E3' : 'transparent',
                  color: convoFilter === tab ? '#2E6B34' : '#9A9A9A',
                }}>
                {tab}
              </button>
            ))}
          </div>
          {/* Conversation items */}
          <div className="flex-1 overflow-y-auto">
            {loadingConvos ? (
              <div className="flex items-center justify-center py-10 text-text-muted text-sm">Loading...</div>
            ) : filteredConvos.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-text-muted text-sm">No conversations yet</div>
            ) : filteredConvos.map((c) => (
              <div key={c.id} onClick={() => selectConvo(c)} className="px-3.5 py-3 cursor-pointer flex gap-2.5 items-start transition-all duration-150"
                style={{
                  background: activeConvo?.id === c.id ? '#E8F5E3' : 'transparent',
                  borderLeft: activeConvo?.id === c.id ? '3px solid #2E6B34' : '3px solid transparent',
                }}>
                <div className="w-10 h-10 rounded-[10px] flex items-center justify-center text-lg shrink-0"
                  style={{ background: c.role === 'system' ? '#E8F5E3' : '#F5F0E8' }}>
                  {c.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="font-sans font-semibold text-[13px] text-text">{c.name}</span>
                    <span className="font-sans text-[10px] text-text-muted">{c.time}</span>
                  </div>
                  <div className="font-sans text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">{c.lastMsg}</div>
                </div>
                {c.unread > 0 && (
                  <div className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-0.5" style={{ background: '#2E6B34' }}>
                    {c.unread}
                  </div>
                )}
              </div>
            ))}
          </div>
          {/* Quick text shortcut */}
          <div className="p-3.5 border-t border-border-light">
            <button onClick={startNewConvo} className="w-full px-3.5 py-2.5 rounded-[10px] text-white border-none font-sans font-semibold text-[13px] cursor-pointer flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)', boxShadow: '0 2px 8px rgba(46,107,52,0.25)' }}>
              <Icon name="msg" size={16} className="text-white" /> New Text to FarmLink
            </button>
          </div>
        </div>

        {/* CENTER: Active Chat — visible on md+ or when mobileView=chat */}
        <div className={`flex-1 flex-col bg-bg ${mobileView === 'chat' ? 'flex' : 'hidden'} md:flex`}>
          {activeConvo ? (
            <>
              {/* Chat header */}
              <div className="px-4 md:px-5 py-3 border-b border-border bg-white flex justify-between items-center">
                <div className="flex items-center gap-2.5">
                  {/* Mobile back button */}
                  <button onClick={() => setMobileView('list')} className="md:hidden bg-transparent border-none cursor-pointer p-0 flex items-center">
                    <Icon name="back" size={18} className="text-text-muted" />
                  </button>
                  <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-base"
                    style={{ background: activeConvo.role === 'system' ? '#E8F5E3' : '#F5F0E8' }}>
                    {activeConvo.avatar}
                  </div>
                  <div>
                    <div className="font-sans font-bold text-[15px] text-text">{activeConvo.name}</div>
                    <div className="font-sans text-[11px] text-text-muted">{activeConvo.role === 'system' ? 'FarmLink Assistant' : activeConvo.role === 'market' ? 'Market Partner' : activeConvo.role === 'farmer' ? 'Farm Partner' : 'Contact'}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {activeConvo.role === 'market' && (
                    <button className="px-3.5 py-1.5 rounded-lg bg-bg border border-border font-sans text-xs font-semibold text-text-soft cursor-pointer hidden sm:block">View Orders</button>
                  )}
                  {/* Mobile panel shortcut */}
                  <button onClick={() => setMobileView('panel')} className="md:hidden w-9 h-9 rounded-lg bg-bg border border-border flex items-center justify-center cursor-pointer">
                    <Icon name="order" size={16} className="text-text-muted" />
                  </button>
                </div>
              </div>
              {/* Messages */}
              <div ref={scrollRef} className="flex-1 px-4 md:px-6 py-4 md:py-5 overflow-y-auto flex flex-col gap-2.5">
                {loadingMessages ? (
                  <div className="flex items-center justify-center py-10 text-text-muted text-sm">Loading messages...</div>
                ) : chatMessages.map((msg) => {
                  const isUser = msg.from === 'user';
                  return (
                    <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`} style={{ animation: 'msgIn 0.3s ease' }}>
                      <div className="max-w-[80%] md:max-w-[65%]">
                        <div className="px-3.5 md:px-4 py-2.5 text-[13px] md:text-sm leading-relaxed whitespace-pre-line font-sans"
                          style={{
                            borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                            background: isUser ? '#2E6B34' : '#fff',
                            color: isUser ? '#fff' : '#1A1A1A',
                            boxShadow: isUser ? '0 2px 8px rgba(46,107,52,0.2)' : '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)',
                            border: isUser ? 'none' : '1px solid #F0EDE8',
                          }}>
                          {msg.text}
                        </div>
                        <div className={`font-sans text-[10px] text-text-muted mt-1 ${isUser ? 'text-right pr-1' : 'text-left pl-1'}`}>{msg.time}</div>
                      </div>
                    </div>
                  );
                })}
                {sending && (
                  <div className="flex justify-start" style={{ animation: 'msgIn 0.3s ease' }}>
                    <div className="px-4 py-3 rounded-2xl bg-white border border-[#F0EDE8] shadow-sm">
                      <div className="flex gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease infinite' }} />
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease 0.2s infinite' }} />
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease 0.4s infinite' }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {/* Input */}
              <div className="px-3 md:px-5 py-3 pb-4 border-t border-border-light bg-white">
                <div className="flex gap-2 md:gap-2.5 items-end">
                  <div className="flex-1 rounded-[14px] border border-border bg-bg overflow-hidden">
                    <textarea
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                      placeholder={activeConvo.role === 'system' ? 'Text FarmLink...' : `Message ${activeConvo.name}...`}
                      rows={1}
                      className="w-full px-3 md:px-4 py-2.5 border-none bg-transparent font-sans text-sm text-text outline-none resize-none leading-relaxed"
                    />
                  </div>
                  <button onClick={handleSend} disabled={sending || !chatInput.trim()} className="w-10 h-10 md:w-[42px] md:h-[42px] rounded-xl border-none flex items-center justify-center shrink-0 transition-all duration-200"
                    style={{
                      background: chatInput.trim() && !sending ? 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' : '#F3EFE9',
                      cursor: chatInput.trim() && !sending ? 'pointer' : 'default',
                      boxShadow: chatInput.trim() && !sending ? '0 2px 8px rgba(46,107,52,0.3)' : 'none',
                    }}>
                    <Icon name="send" size={18} className={chatInput.trim() && !sending ? 'text-white' : 'text-text-muted'} />
                  </button>
                </div>
                <div className="flex gap-1.5 md:gap-2 mt-2 overflow-x-auto">
                  {['📦 Check inventory', '💰 Today\'s sales', '📋 Pending orders'].map(q => (
                    <button key={q} onClick={() => setChatInput(q.slice(2).trim())} className="px-2.5 md:px-3 py-1 rounded-full bg-bg border border-border font-sans text-[11px] text-text-soft cursor-pointer whitespace-nowrap hover:bg-earth-25 transition-colors">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center flex-col gap-4 px-6">
              <div className="w-[72px] h-[72px] rounded-[20px] bg-green-50 flex items-center justify-center">
                <Icon name="msg" size={32} className="text-green-600" />
              </div>
              <h3 className="font-display font-bold text-xl md:text-[22px] text-text m-0">Your Messages</h3>
              <p className="font-sans text-sm text-text-muted text-center max-w-[320px]">Select a conversation to view messages, or text FarmLink to manage your inventory and orders.</p>
              <button onClick={startNewConvo} className="px-6 py-2.5 rounded-[10px] text-white border-none font-sans font-semibold text-sm cursor-pointer flex items-center gap-2"
                style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
                <Icon name="msg" size={16} className="text-white" /> Text FarmLink
              </button>
            </div>
          )}
        </div>

        {/* RIGHT: Context Panel — visible on lg+ or when mobileView=panel */}
        <div className={`w-full lg:w-[300px] border-l border-border flex-col bg-white shrink-0 ${mobileView === 'panel' ? 'flex' : 'hidden'} lg:flex`}>
          {/* Mobile back from panel */}
          <div className="lg:hidden flex items-center gap-2 px-4 py-3 border-b border-border-light">
            <button onClick={() => setMobileView(activeConvo ? 'chat' : 'list')} className="bg-transparent border-none cursor-pointer p-0 flex items-center gap-1.5 text-text-soft font-sans text-[13px] font-medium">
              <Icon name="back" size={16} className="text-text-muted" /> Back
            </button>
          </div>
          {/* Panel tabs */}
          <div className="flex border-b border-border">
            {[
              { id: 'orders' as const, icon: 'order', label: 'Orders' },
              { id: 'inventory' as const, icon: 'package', label: isFarmer ? 'Inventory' : 'Available' },
              { id: 'markets' as const, icon: 'market', label: isFarmer ? 'Markets' : 'Farms' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setSidePanel(tab.id)} className="flex-1 py-3 border-none cursor-pointer flex flex-col items-center gap-0.5 transition-all duration-150"
                style={{
                  background: sidePanel === tab.id ? '#FAF8F5' : 'transparent',
                  borderBottom: sidePanel === tab.id ? '2px solid #2E6B34' : '2px solid transparent',
                }}>
                <Icon name={tab.icon} size={16} className={sidePanel === tab.id ? 'text-green-600' : 'text-text-muted'} />
                <span className={`font-sans text-[10px] font-semibold ${sidePanel === tab.id ? 'text-green-600' : 'text-text-muted'}`}>{tab.label}</span>
              </button>
            ))}
          </div>
          {/* Panel content */}
          <div className="flex-1 overflow-y-auto">
            {sidePanel === 'orders' && <OrdersPanel farmId={isFarmer ? farm?.id : undefined} marketId={isMarket && !isFarmer ? market?.id : undefined} />}
            {sidePanel === 'inventory' && <InventoryPanel farmId={isFarmer ? farm?.id : undefined} marketId={isMarket && !isFarmer ? market?.id : undefined} isFarmer={!!isFarmer} />}
            {sidePanel === 'markets' && (isFarmer ? <MarketsPanel farmId={farm?.id} /> : <FarmsPanel marketId={market?.id} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Status helpers ─── */
const STATUS_COLORS: Record<string, string> = {
  confirmed: '#2E6B34', ready: '#2E6B34',
  pending: '#D4763C', processing: '#D4763C', in_transit: '#3B7DD8',
  delivered: '#9A9A9A', picked_up: '#9A9A9A',
  cancelled: '#C44B3F',
};
const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_transit', 'cancelled'],
  in_transit: ['delivered'],
};

/* ─── Side Panel: Orders ─── */
function OrdersPanel({ farmId, marketId }: { farmId?: string; marketId?: string }) {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const loadOrders = useCallback(() => {
    const fetcher = farmId
      ? api.getFarmOrders(farmId)
      : marketId
        ? api.getMarketOrders(marketId)
        : api.getOrders();
    fetcher
      .then((data: any) => setOrders(data.orders || []))
      .catch(err => console.error('Failed to load orders:', err))
      .finally(() => setLoading(false));
  }, [farmId, marketId]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const updateStatus = async (orderId: string, newStatus: string) => {
    setUpdating(orderId);
    try {
      await api.updateOrderStatus(orderId, newStatus);
      loadOrders();
    } catch (err) {
      console.error('Failed to update order:', err);
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="p-5">
      <h3 className="font-display font-bold text-lg text-text mb-4">Recent Orders</h3>
      {loading ? (
        <div className="text-center text-text-muted text-sm py-6">Loading...</div>
      ) : orders.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-6">No orders yet</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {orders.slice(0, 10).map((o: any, i: number) => {
            const sc = STATUS_COLORS[o.status] || '#9A9A9A';
            const nextStatuses = ORDER_TRANSITIONS[o.status] || [];
            return (
              <div key={o.id} className="bg-bg rounded-lg p-3.5 border border-border-light" style={{ animation: `fadeUp 0.3s ease ${i * 0.05}s both` }}>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="font-mono text-[13px] font-semibold text-text">{o.order_number || `#${String(o.id).slice(0, 8)}`}</span>
                  <span className="font-sans text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ color: sc, background: `${sc}12` }}>{o.status}</span>
                </div>
                <div className="font-sans text-[13px] text-text font-semibold">{o.market_name || o.farm_name || 'Order'}</div>
                {o.order_date && <div className="font-sans text-[11px] text-text-muted mt-0.5">{new Date(o.order_date).toLocaleDateString()}</div>}
                <div className="font-mono text-sm font-bold mt-1.5" style={{ color: '#2E6B34' }}>${Number(o.total || 0).toFixed(2)}</div>
                {nextStatuses.length > 0 && (
                  <div className="flex gap-1.5 mt-2">
                    {nextStatuses.map(ns => (
                      <button key={ns} onClick={() => updateStatus(o.id, ns)} disabled={updating === o.id}
                        className="px-2.5 py-1 rounded-md font-sans text-[11px] font-semibold border-none cursor-pointer transition-colors"
                        style={{
                          background: ns === 'cancelled' ? '#FDECEB' : '#E8F5E3',
                          color: ns === 'cancelled' ? '#C44B3F' : '#2E6B34',
                          opacity: updating === o.id ? 0.5 : 1,
                        }}>
                        {updating === o.id ? '...' : ns === 'cancelled' ? 'Cancel' : ns.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Side Panel: Inventory ─── */
function InventoryPanel({ farmId, marketId, isFarmer }: { farmId?: string; marketId?: string; isFarmer: boolean }) {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editQty, setEditQty] = useState('');
  const [editPrice, setEditPrice] = useState('');

  const loadInventory = useCallback(() => {
    const fetcher = farmId
      ? api.getFarmInventory(farmId)
      : marketId
        ? api.getMarketAvailable(marketId)
        : api.getInventory();
    fetcher
      .then((data: any) => setInventory(data.inventory || []))
      .catch(err => console.error('Failed to load inventory:', err))
      .finally(() => setLoading(false));
  }, [farmId, marketId]);

  useEffect(() => { loadInventory(); }, [loadInventory]);

  const startEdit = (item: any) => {
    setEditing(item.id);
    setEditQty(String(item.remaining ?? item.quantity ?? ''));
    setEditPrice(String(item.price ?? ''));
  };

  const saveEdit = async (id: string) => {
    try {
      await api.updateInventory(id, {
        quantity_available: Number(editQty),
        price_per_unit: Number(editPrice),
      });
      setEditing(null);
      loadInventory();
    } catch (err) {
      console.error('Failed to update inventory:', err);
    }
  };

  const statusStyles: Record<string, { bg: string; color: string; label: string }> = {
    available: { bg: '#E8F5E3', color: '#2E6B34', label: 'Available' },
    partial: { bg: '#FFF3EB', color: '#D4763C', label: 'Partial' },
    sold: { bg: '#FDECEB', color: '#C44B3F', label: 'Sold' },
  };

  return (
    <div className="p-5">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-display font-bold text-lg text-text m-0">{isFarmer ? 'Your Inventory' : 'Available Items'}</h3>
      </div>
      {loading ? (
        <div className="text-center text-text-muted text-sm py-6">Loading...</div>
      ) : inventory.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-6">No inventory items</div>
      ) : (
        <div className="flex flex-col gap-2">
          {inventory.map((item: any, i: number) => {
            const s = statusStyles[item.status] || statusStyles.available;
            const isEditing = editing === item.id;
            return (
              <div key={item.id || i} className="bg-bg rounded-lg p-3.5 border border-border-light" style={{ animation: `fadeUp 0.3s ease ${i * 0.05}s both`, opacity: item.status === 'sold' ? 0.5 : 1 }}>
                <div className="flex justify-between items-center">
                  <span className="font-sans text-sm font-semibold text-text">{item.product_name}</span>
                  <span className="text-[10px] font-bold font-sans px-2 py-0.5 rounded-md" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                </div>
                {!isFarmer && item.farm_name && (
                  <div className="font-sans text-[11px] text-text-muted mt-0.5">from {item.farm_name}</div>
                )}
                {isEditing ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <label className="font-sans text-[11px] text-text-muted w-8">Qty</label>
                      <input value={editQty} onChange={e => setEditQty(e.target.value)} className="flex-1 px-2 py-1 rounded border border-border bg-white font-mono text-xs text-text outline-none" />
                      <span className="font-sans text-[11px] text-text-muted">{item.unit}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="font-sans text-[11px] text-text-muted w-8">$</label>
                      <input value={editPrice} onChange={e => setEditPrice(e.target.value)} className="flex-1 px-2 py-1 rounded border border-border bg-white font-mono text-xs text-text outline-none" />
                      <span className="font-sans text-[11px] text-text-muted">/{item.unit}</span>
                    </div>
                    <div className="flex gap-1.5 mt-1">
                      <button onClick={() => saveEdit(item.id)} className="flex-1 py-1 rounded-md bg-green-600 text-white border-none font-sans text-[11px] font-semibold cursor-pointer">Save</button>
                      <button onClick={() => setEditing(null)} className="flex-1 py-1 rounded-md bg-bg border border-border font-sans text-[11px] font-semibold text-text-muted cursor-pointer">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between mt-1.5">
                      <span className="font-sans text-xs text-text-muted">{item.remaining ?? item.quantity ?? 0} {item.unit}</span>
                      <span className="font-mono text-xs font-semibold" style={{ color: '#2E6B34' }}>${Number(item.price || 0).toFixed(2)}/{item.unit}</span>
                    </div>
                    {item.harvest_date && <div className="font-sans text-[10px] text-text-muted mt-1">Harvested {new Date(item.harvest_date).toLocaleDateString()}</div>}
                    {isFarmer && (
                      <button onClick={() => startEdit(item)} className="mt-2 w-full py-1 rounded-md bg-bg border border-border-light font-sans text-[11px] font-semibold text-text-soft cursor-pointer hover:bg-earth-25 transition-colors">
                        <Icon name="edit" size={11} className="text-text-muted inline-block mr-1" style={{ verticalAlign: '-1px' }} /> Edit
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {isFarmer && (
        <div className="mt-4 p-3.5 rounded-lg border border-dashed" style={{ background: '#E8F5E3', borderColor: 'rgba(46,107,52,0.25)' }}>
          <p className="font-sans text-xs leading-relaxed m-0" style={{ color: '#2E6B34' }}>
            <strong>Tip:</strong> You can add inventory by texting! Just send something like &ldquo;50lb jalapeños at $2.49&rdquo;
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Side Panel: Markets ─── */
function MarketsPanel({ farmId }: { farmId?: string }) {
  const [markets, setMarkets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addLocation, setAddLocation] = useState('');
  const [addPriority, setAddPriority] = useState('1');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editPriority, setEditPriority] = useState('');
  const [editDelay, setEditDelay] = useState('');
  const [editActive, setEditActive] = useState(true);

  const loadMarkets = useCallback(() => {
    const fetcher = farmId ? api.getFarmMarkets(farmId) : api.getAllMarkets();
    fetcher
      .then((data: any) => setMarkets(data.markets || []))
      .catch(err => console.error('Failed to load markets:', err))
      .finally(() => setLoading(false));
  }, [farmId]);

  useEffect(() => { loadMarkets(); }, [loadMarkets]);

  const handleAdd = async () => {
    if (!addName.trim() || !farmId) return;
    setAdding(true);
    setAddError('');
    try {
      await api.addFarmMarket(farmId, {
        name: addName.trim(),
        phone: addPhone.trim() || undefined,
        location: addLocation.trim() || undefined,
        priority: Number(addPriority) || 1,
      });
      setShowAdd(false);
      setAddName(''); setAddPhone(''); setAddLocation(''); setAddPriority('1');
      loadMarkets();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add market');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (m: any) => {
    setEditing(m.rel_id);
    setEditPriority(String(m.priority ?? 1));
    setEditDelay(String(m.notification_delay_min ?? 0));
    setEditActive(m.active !== false);
  };

  const saveEdit = async (relId: string) => {
    if (!farmId) return;
    try {
      await api.updateFarmMarket(farmId, relId, {
        priority: Number(editPriority) || 1,
        notification_delay_min: Number(editDelay) || 0,
        active: editActive,
      });
      setEditing(null);
      loadMarkets();
    } catch (err) {
      console.error('Failed to update market:', err);
    }
  };

  return (
    <div className="p-5">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-display font-bold text-lg text-text m-0">Your Markets</h3>
        {farmId && (
          <button onClick={() => setShowAdd(!showAdd)}
            className="px-2.5 py-1 rounded-md font-sans text-[11px] font-semibold border-none cursor-pointer"
            style={{ background: showAdd ? '#FDECEB' : '#E8F5E3', color: showAdd ? '#C44B3F' : '#2E6B34' }}>
            {showAdd ? 'Cancel' : '+ Add Market'}
          </button>
        )}
      </div>

      {/* Add market form */}
      {showAdd && (
        <div className="mb-4 p-3.5 rounded-lg border border-green-200 bg-green-50">
          <div className="flex flex-col gap-2">
            <div>
              <label className="font-sans text-[11px] text-text-muted font-semibold block mb-0.5">Market Name *</label>
              <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. Downtown Farmers Market"
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-white font-sans text-xs text-text outline-none focus:border-green-500" />
            </div>
            <div>
              <label className="font-sans text-[11px] text-text-muted font-semibold block mb-0.5">Phone Number</label>
              <input value={addPhone} onChange={e => setAddPhone(e.target.value)} placeholder="+15015551234" type="tel"
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-white font-sans text-xs text-text outline-none focus:border-green-500" />
            </div>
            <div>
              <label className="font-sans text-[11px] text-text-muted font-semibold block mb-0.5">Location</label>
              <input value={addLocation} onChange={e => setAddLocation(e.target.value)} placeholder="City, State"
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-white font-sans text-xs text-text outline-none focus:border-green-500" />
            </div>
            <div>
              <label className="font-sans text-[11px] text-text-muted font-semibold block mb-0.5">Priority (1 = highest)</label>
              <input value={addPriority} onChange={e => setAddPriority(e.target.value)} type="number" min="1" max="99"
                className="w-20 px-2.5 py-1.5 rounded-md border border-border bg-white font-mono text-xs text-text outline-none focus:border-green-500" />
            </div>
            {addError && <div className="text-[11px] text-red-600 font-semibold">{addError}</div>}
            <button onClick={handleAdd} disabled={!addName.trim() || adding}
              className="mt-1 w-full py-2 rounded-md text-white border-none font-sans text-xs font-semibold cursor-pointer disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
              {adding ? 'Adding...' : 'Add Market'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-text-muted text-sm py-6">Loading...</div>
      ) : markets.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-6">No markets yet — add one above!</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {markets.map((m: any, i: number) => {
            const isEditing = editing === m.rel_id;
            return (
              <div key={m.id || i} className="bg-bg rounded-lg p-3.5 border border-border-light" style={{ animation: `fadeUp 0.3s ease ${i * 0.05}s both`, opacity: m.active === false ? 0.5 : 1 }}>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="font-sans text-sm font-semibold text-text">{m.name}</span>
                  {m.priority && (
                    <div className="flex items-center gap-0.5">
                      {[...Array(4)].map((_, s) => (
                        <Icon key={s} name="star" size={12} className={s < (5 - m.priority) ? 'text-[#E8B931]' : 'text-border-light'} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-4">
                  {m.location && <span className="font-sans text-xs text-text-muted">{m.location}</span>}
                  {m.type && <span className="font-sans text-xs text-text-muted">{m.type}</span>}
                </div>
                {(m.history_orders != null || m.pending_orders != null) && (
                  <div className="flex gap-4 mt-1.5">
                    {m.pending_orders != null && <span className="font-sans text-xs text-text-muted">{m.pending_orders} pending</span>}
                    {m.history_total != null && <span className="font-mono text-xs font-semibold" style={{ color: '#2E6B34' }}>${Number(m.history_total || 0).toFixed(2)} total</span>}
                  </div>
                )}
                {m.active === false && <span className="font-sans text-[10px] font-semibold text-red-500 mt-1 block">Inactive</span>}

                {isEditing ? (
                  <div className="mt-2.5 pt-2.5 border-t border-border-light flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <label className="font-sans text-[11px] text-text-muted w-16">Priority</label>
                      <input value={editPriority} onChange={e => setEditPriority(e.target.value)} type="number" min="1" max="99"
                        className="w-14 px-2 py-1 rounded border border-border bg-white font-mono text-xs text-text outline-none" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="font-sans text-[11px] text-text-muted w-16">Delay (min)</label>
                      <input value={editDelay} onChange={e => setEditDelay(e.target.value)} type="number" min="0"
                        className="w-14 px-2 py-1 rounded border border-border bg-white font-mono text-xs text-text outline-none" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="font-sans text-[11px] text-text-muted w-16">Active</label>
                      <button onClick={() => setEditActive(!editActive)}
                        className="px-2.5 py-0.5 rounded-md border-none font-sans text-[11px] font-semibold cursor-pointer"
                        style={{ background: editActive ? '#E8F5E3' : '#FDECEB', color: editActive ? '#2E6B34' : '#C44B3F' }}>
                        {editActive ? 'Yes' : 'No'}
                      </button>
                    </div>
                    <div className="flex gap-1.5 mt-1">
                      <button onClick={() => saveEdit(m.rel_id)} className="flex-1 py-1 rounded-md bg-green-600 text-white border-none font-sans text-[11px] font-semibold cursor-pointer">Save</button>
                      <button onClick={() => setEditing(null)} className="flex-1 py-1 rounded-md bg-bg border border-border font-sans text-[11px] font-semibold text-text-muted cursor-pointer">Cancel</button>
                    </div>
                  </div>
                ) : farmId && m.rel_id && (
                  <button onClick={() => startEdit(m)}
                    className="mt-2 w-full py-1 rounded-md bg-bg border border-border-light font-sans text-[11px] font-semibold text-text-soft cursor-pointer hover:bg-earth-25 transition-colors">
                    <Icon name="edit" size={11} className="text-text-muted inline-block mr-1" style={{ verticalAlign: '-1px' }} /> Edit
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Side Panel: Farms (for market users) ─── */
function FarmsPanel({ marketId }: { marketId?: string }) {
  const [farms, setFarms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetcher = marketId ? api.getMarketFarms(marketId) : api.getAllFarms();
    fetcher
      .then((data: any) => setFarms(data.farms || []))
      .catch(err => console.error('Failed to load farms:', err))
      .finally(() => setLoading(false));
  }, [marketId]);

  return (
    <div className="p-5">
      <h3 className="font-display font-bold text-lg text-text mb-4">Your Farms</h3>
      {loading ? (
        <div className="text-center text-text-muted text-sm py-6">Loading...</div>
      ) : farms.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-6">No farm partners yet</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {farms.map((f: any, i: number) => (
            <div key={f.id || i} className="bg-bg rounded-lg p-3.5 border border-border-light" style={{ animation: `fadeUp 0.3s ease ${i * 0.05}s both` }}>
              <div className="flex justify-between items-center mb-1.5">
                <span className="font-sans text-sm font-semibold text-text">{f.name}</span>
                {f.priority != null && (
                  <div className="flex items-center gap-0.5">
                    {[...Array(4)].map((_, s) => (
                      <Icon key={s} name="star" size={12} className={s < (5 - f.priority) ? 'text-[#E8B931]' : 'text-border-light'} />
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-4">
                {f.location && <span className="font-sans text-xs text-text-muted">{f.location}</span>}
                {f.specialty && <span className="font-sans text-xs text-text-muted">{f.specialty}</span>}
              </div>
              {f.available_items != null && (
                <div className="font-sans text-xs text-text-muted mt-1">{f.available_items} items available</div>
              )}
              {(f.history_orders != null || f.pending_orders != null) && (
                <div className="flex gap-4 mt-1.5">
                  {f.pending_orders != null && <span className="font-sans text-xs text-text-muted">{f.pending_orders} pending</span>}
                  {f.history_total != null && <span className="font-mono text-xs font-semibold" style={{ color: '#2E6B34' }}>${Number(f.history_total || 0).toFixed(2)} total</span>}
                </div>
              )}
              {f.active === false && <span className="font-sans text-[10px] text-text-muted mt-1 block">Inactive</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
