'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';
import { Header } from './header';
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
  initialTab?: string;
}

type View = 'chat' | 'orders' | 'inventory' | 'markets';

function resolveInitialView(tab: string | undefined): View {
  if (tab === 'inventory') return 'inventory';
  if (tab === 'markets' || tab === 'directory') return 'markets';
  if (tab === 'orders' || tab === 'deliveries' || tab === 'recurring') return 'orders';
  return 'chat';
}

export function Dashboard({ viewAs, initialTab }: DashboardProps) {
  const router = useRouter();
  const { user, farm, market, isAuthenticated, isLoading: authLoading } = useAuth();
  const [conversations, setConversations] = useState<Convo[]>([]);
  const [activeConvo, setActiveConvo] = useState<Convo | null>(null);
  const [activeView, setActiveView] = useState<View>(resolveInitialView(initialTab));
  const [directorySearch, setDirectorySearch] = useState('');
  const [directoryResults, setDirectoryResults] = useState<any[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<DisplayMessage[]>([]);
  const [chatSearch, setChatSearch] = useState('');
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

  // Auto-open the user's FarmLink conversation whenever the Chat view is active.
  useEffect(() => {
    if (activeView === 'chat' && !activeConvo && user && !authLoading) {
      startNewConvo();
    }
  }, [activeView, activeConvo, user, authLoading, startNewConvo]);

  // Search filters the visible message history.
  const visibleMessages = chatSearch.trim()
    ? chatMessages.filter(m => m.text.toLowerCase().includes(chatSearch.trim().toLowerCase()))
    : chatMessages;

  return (
    <div className="h-screen flex flex-col bg-bg font-sans">
      {/* ── Shared Header ── */}
      <Header />

      {/* ── Primary View Tabs + Stats ── */}
      <div className="flex items-center justify-between px-3 md:px-5 py-2 bg-white border-b border-border shrink-0">
        <div className="flex gap-1.5 overflow-x-auto">
        {([
          { id: 'chat' as View, icon: 'msg', label: 'Chat' },
          { id: 'orders' as View, icon: 'order', label: 'Orders' },
          { id: 'inventory' as View, icon: 'package', label: isFarmer ? 'Inventory' : 'Available' },
          { id: 'markets' as View, icon: 'market', label: isFarmer ? 'Markets' : 'Farms' },
        ]).map(tab => (
          <button key={tab.id} onClick={() => setActiveView(tab.id)}
            className="h-10 px-4 rounded-full border-none cursor-pointer flex items-center gap-2 shrink-0 transition-all active:scale-95"
            style={{ background: activeView === tab.id ? '#2E6B34' : '#F3EFE9' }}>
            <Icon name={tab.icon} size={16} className={activeView === tab.id ? 'text-white' : 'text-text-muted'} />
            <span className={`font-sans text-[14px] font-semibold ${activeView === tab.id ? 'text-white' : 'text-text-soft'}`}>{tab.label}</span>
          </button>
        ))}
        </div>
        <div className="hidden sm:flex gap-4 ml-4 shrink-0">
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
      </div>

      {/* ── Main Area (one view at a time) ── */}
      <div className="flex-1 overflow-hidden">
        {/* CHAT VIEW: single conversation with FarmLink — search + history + input */}
        {activeView === 'chat' && (
          <div className="h-full flex flex-col bg-[#F7F5F1]">
            {/* Search bar */}
            <div className="px-4 py-3 bg-white border-b border-border shrink-0">
              <div className="max-w-[680px] mx-auto flex items-center gap-2 px-3.5 h-11 rounded-xl bg-bg-alt">
                <Icon name="search" size={16} className="text-text-muted" />
                <input
                  value={chatSearch}
                  onChange={e => setChatSearch(e.target.value)}
                  placeholder="Search your messages"
                  className="border-none bg-transparent font-sans text-[15px] text-text outline-none w-full"
                />
                {chatSearch && (
                  <button onClick={() => setChatSearch('')} className="bg-transparent border-none cursor-pointer text-text-muted text-sm">✕</button>
                )}
              </div>
            </div>

            {/* History */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="max-w-[680px] mx-auto w-full px-4 py-4 flex flex-col gap-1">
                {loadingMessages ? (
                  <div className="flex items-center justify-center py-10 text-text-muted text-sm">Loading messages...</div>
                ) : visibleMessages.length === 0 ? (
                  <div className="py-16 text-center text-text-muted text-[14px] px-6">
                    {chatSearch ? `No messages match “${chatSearch}”` : 'Send a message to start — try “What can you help me with?”'}
                  </div>
                ) : visibleMessages.map((msg, idx) => {
                  const isUser = msg.from === 'user';
                  const prev = visibleMessages[idx - 1];
                  const next = visibleMessages[idx + 1];
                  const firstOfGroup = !prev || prev.from !== msg.from;
                  const lastOfGroup = !next || next.from !== msg.from;
                  return (
                    <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${firstOfGroup ? 'mt-2' : ''}`} style={{ animation: 'msgIn 0.25s ease' }}>
                      <div className="max-w-[78%] flex flex-col">
                        <div className="px-3.5 py-2 text-[15px] leading-[1.35] whitespace-pre-line font-sans"
                          style={{
                            borderRadius: 18,
                            borderBottomRightRadius: isUser && lastOfGroup ? 5 : 18,
                            borderBottomLeftRadius: !isUser && lastOfGroup ? 5 : 18,
                            background: isUser ? '#2E6B34' : '#FFFFFF',
                            color: isUser ? '#fff' : '#1A1A1A',
                            boxShadow: isUser ? 'none' : '0 1px 1.5px rgba(0,0,0,0.07)',
                          }}>
                          {msg.text}
                        </div>
                        {lastOfGroup && (
                          <div className={`font-sans text-[11px] text-text-muted mt-1 px-1 ${isUser ? 'text-right' : 'text-left'}`}>{msg.time}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {sending && !chatSearch && (
                  <div className="flex justify-start mt-2" style={{ animation: 'msgIn 0.25s ease' }}>
                    <div className="px-4 py-3 bg-white shadow-sm" style={{ borderRadius: 18, borderBottomLeftRadius: 5 }}>
                      <div className="flex gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease infinite' }} />
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease 0.2s infinite' }} />
                        <span className="w-2 h-2 rounded-full bg-text-muted" style={{ animation: 'typingDot 1.4s ease 0.4s infinite' }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Suggestions + input (hidden while searching) */}
            {!chatSearch && (
              <div className="max-w-[680px] mx-auto w-full">
                <div className="flex gap-2 px-4 pt-2 overflow-x-auto shrink-0">
                  {['📦 Check inventory', '💰 Today\'s sales', '📋 Pending orders'].map(q => (
                    <button key={q} onClick={() => setChatInput(q.slice(2).trim())} className="px-3 h-8 rounded-full bg-white border border-border font-sans text-[13px] text-text-soft cursor-pointer whitespace-nowrap hover:bg-bg transition-colors shrink-0">
                      {q}
                    </button>
                  ))}
                </div>
                <div className="px-4 py-3 shrink-0">
                  <div className="flex gap-2 items-end">
                    <div className="flex-1 flex items-end rounded-[22px] border border-border bg-white min-h-[44px]">
                      <textarea
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                        placeholder="Message FarmLink"
                        rows={1}
                        className="w-full px-4 py-2.5 border-none bg-transparent font-sans text-[15px] text-text outline-none resize-none leading-relaxed max-h-32"
                      />
                    </div>
                    <button onClick={handleSend} disabled={sending || !chatInput.trim()} className="w-11 h-11 rounded-full border-none flex items-center justify-center shrink-0 transition-all duration-200 active:scale-95"
                      style={{
                        background: chatInput.trim() && !sending ? 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' : '#E2DDD5',
                        cursor: chatInput.trim() && !sending ? 'pointer' : 'default',
                      }}>
                      <Icon name="send" size={18} className={chatInput.trim() && !sending ? 'text-white' : 'text-text-muted'} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ORDERS VIEW */}
        {activeView === 'orders' && (
          <div className="h-full overflow-y-auto">
            <OrdersPanel
              farmId={isFarmer ? farm?.id : undefined}
              marketId={isMarket && !isFarmer ? market?.id : undefined}
              initialSubTab={initialTab === 'recurring' ? 'recurring' : 'recent'}
            />
          </div>
        )}

        {/* INVENTORY VIEW */}
        {activeView === 'inventory' && (
          <div className="h-full overflow-y-auto">
            <InventoryPanel farmId={isFarmer ? farm?.id : undefined} marketId={isMarket && !isFarmer ? market?.id : undefined} isFarmer={!!isFarmer} />
          </div>
        )}

        {/* MARKETS / FARMS VIEW (with Find New + Invite) */}
        {activeView === 'markets' && (
          <div className="h-full overflow-y-auto">
            <ConnectionsView isFarmer={!!isFarmer} farmId={farm?.id} marketId={market?.id} />
          </div>
        )}
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

/* ─── Order Detail Bottom Sheet ─── */
function OrderDetailSheet({ orderId, onClose, onStatusChange }: { orderId: string; onClose: () => void; onStatusChange: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getOrder(orderId)
      .then(setDetail)
      .catch(err => console.error('Failed to load order detail:', err))
      .finally(() => setLoading(false));
  }, [orderId]);

  const handleStatusUpdate = async (newStatus: string) => {
    setUpdating(true);
    try {
      await api.updateOrderStatus(orderId, newStatus);
      onStatusChange();
      // Refresh the detail
      const updated = await api.getOrder(orderId);
      setDetail(updated);
    } catch (err) {
      console.error('Failed to update order:', err);
    } finally {
      setUpdating(false);
    }
  };

  const sc = detail ? (STATUS_COLORS[detail.status] || '#9A9A9A') : '#9A9A9A';
  const nextStatuses = detail ? (ORDER_TRANSITIONS[detail.status] || []) : [];

  return (
    <div ref={backdropRef} onClick={e => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)', animation: 'fadeIn 0.2s ease' }}>
      <div className="bg-white w-full sm:max-w-[480px] sm:rounded-2xl rounded-t-2xl max-h-[85vh] flex flex-col"
        style={{ animation: 'slideUp 0.3s ease', boxShadow: '0 -4px 30px rgba(0,0,0,0.12)' }}>
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-border-light">
          <div>
            <div className="font-mono text-[13px] font-semibold text-text-soft">{detail?.order_number || `#${orderId.slice(0, 8)}`}</div>
            <div className="font-display font-bold text-[18px] text-text">{detail?.market_name || detail?.farm_name || 'Order'}</div>
          </div>
          <div className="flex items-center gap-2.5">
            {detail && <span className="font-sans text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize" style={{ color: sc, background: `${sc}18` }}>{String(detail.status).replace('_', ' ')}</span>}
            <button onClick={onClose} className="w-8 h-8 rounded-full bg-bg border border-border flex items-center justify-center cursor-pointer text-text-muted text-sm hover:bg-gray-100 transition-colors">✕</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="text-center text-text-muted text-sm py-10">Loading details...</div>
          ) : !detail ? (
            <div className="text-center text-text-muted text-sm py-10">Could not load order</div>
          ) : (
            <>
              {/* Summary row */}
              <div className="flex items-center justify-between">
                <div>
                  {detail.order_date && <div className="font-sans text-[13px] text-text-muted">{new Date(detail.order_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>}
                  {detail.delivery_pref && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Icon name={detail.delivery_pref === 'delivery' ? 'truck' : 'store'} size={12} className="text-text-muted" />
                      <span className="font-sans text-[12px] text-text-soft capitalize">{detail.delivery_pref}</span>
                    </div>
                  )}
                </div>
                <div className="font-mono text-[24px] font-bold" style={{ color: '#2E6B34' }}>${Number(detail.total || 0).toFixed(2)}</div>
              </div>

              {/* Line items */}
              {detail.items && detail.items.length > 0 && (
                <div>
                  <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-2">Items</div>
                  <div className="bg-bg rounded-xl border border-border-light overflow-hidden">
                    {detail.items.map((item: any, idx: number) => (
                      <div key={item.id || idx} className="flex items-center justify-between px-4 py-3" style={{ borderTop: idx > 0 ? '1px solid var(--border-light, #f0f0f0)' : 'none' }}>
                        <div>
                          <div className="font-sans text-[14px] text-text font-medium">{item.product_name || item.product || 'Item'}</div>
                          <div className="font-sans text-[12px] text-text-muted">
                            {item.quantity || item.qty} {item.unit || 'units'} × ${Number(item.unit_price || item.price || 0).toFixed(2)}
                          </div>
                        </div>
                        <div className="font-mono text-[14px] font-semibold text-text">${Number((item.quantity || item.qty || 0) * (item.unit_price || item.price || 0)).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Parties */}
              <div className="grid grid-cols-2 gap-3">
                {detail.farm_name && (
                  <div className="bg-bg rounded-xl p-3 border border-border-light">
                    <div className="font-sans text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-1">Farm</div>
                    <div className="font-sans text-[14px] text-text font-medium">{detail.farm_name}</div>
                    {detail.farm_location && <div className="font-sans text-[12px] text-text-muted mt-0.5">{detail.farm_location}</div>}
                  </div>
                )}
                {detail.market_name && (
                  <div className="bg-bg rounded-xl p-3 border border-border-light">
                    <div className="font-sans text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-1">Market</div>
                    <div className="font-sans text-[14px] text-text font-medium">{detail.market_name}</div>
                    {detail.market_location && <div className="font-sans text-[12px] text-text-muted mt-0.5">{detail.market_location}</div>}
                  </div>
                )}
              </div>

              {/* Notes */}
              {detail.notes && (
                <div>
                  <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-2">Notes</div>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 font-sans text-[13px] text-amber-900 leading-relaxed">{detail.notes}</div>
                </div>
              )}

              {/* Timestamps */}
              <div className="flex gap-4 text-[11px] font-sans text-text-muted pt-1">
                {detail.created_at && <span>Created {new Date(detail.created_at).toLocaleString()}</span>}
                {detail.updated_at && <span>Updated {new Date(detail.updated_at).toLocaleString()}</span>}
              </div>
            </>
          )}
        </div>

        {/* Footer: status actions */}
        {nextStatuses.length > 0 && (
          <div className="px-5 py-4 border-t border-border-light flex gap-2">
            {nextStatuses.map(ns => (
              <button key={ns} onClick={() => handleStatusUpdate(ns)} disabled={updating}
                className="flex-1 h-12 rounded-xl font-sans text-[14px] font-semibold border-none cursor-pointer transition-colors active:scale-[0.98]"
                style={{
                  background: ns === 'cancelled' ? '#FDECEB' : '#E8F5E3',
                  color: ns === 'cancelled' ? '#C44B3F' : '#2E6B34',
                  opacity: updating ? 0.5 : 1,
                }}>
                {updating ? '...' : ns === 'cancelled' ? 'Cancel Order' : ns.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Side Panel: Orders ─── */
function OrdersPanel({ farmId, marketId, initialSubTab }: { farmId?: string; marketId?: string; initialSubTab?: 'recent' | 'recurring' }) {
  const [subTab, setSubTab] = useState<'recent' | 'recurring'>(initialSubTab || 'recent');
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

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
    <div className="p-6 max-w-[1100px] mx-auto w-full">
      <div className="flex items-center gap-2 mb-5">
        {(['recent', 'recurring'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`font-sans text-sm px-3.5 py-1.5 rounded-lg cursor-pointer border-none transition-colors ${subTab === t ? 'bg-[#2E6B34] text-white' : 'bg-surface-raised text-text-muted hover:text-text'}`}>
            {t === 'recent' ? 'Recent Orders' : 'Standing Orders'}
          </button>
        ))}
      </div>

      {subTab === 'recurring' ? (
        <RecurringPanel farmId={farmId} marketId={marketId} />
      ) : loading ? (
        <div className="text-center text-text-muted text-sm py-10">Loading...</div>
      ) : orders.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-10">No orders yet</div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {orders.slice(0, 20).map((o: any, i: number) => {
            const sc = STATUS_COLORS[o.status] || '#9A9A9A';
            const nextStatuses = ORDER_TRANSITIONS[o.status] || [];
            return (
              <div key={o.id} onClick={() => setDetailId(o.id)}
                className="bg-white rounded-2xl p-4 border border-border-light flex flex-col cursor-pointer hover:border-green-300 transition-colors"
                style={{ animation: `fadeUp 0.3s ease ${i * 0.04}s both`, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-[13px] font-semibold text-text-soft">{o.order_number || `#${String(o.id).slice(0, 8)}`}</span>
                  <span className="font-sans text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize" style={{ color: sc, background: `${sc}18` }}>{String(o.status).replace('_', ' ')}</span>
                </div>
                <div className="font-sans text-[16px] text-text font-semibold leading-tight">{o.market_name || o.farm_name || 'Order'}</div>
                {o.order_date && <div className="font-sans text-[12px] text-text-muted mt-0.5">{new Date(o.order_date).toLocaleDateString()}</div>}
                <div className="flex items-center justify-between mt-2">
                  <div className="font-mono text-[20px] font-bold" style={{ color: '#2E6B34' }}>${Number(o.total || 0).toFixed(2)}</div>
                  <span className="font-sans text-[11px] text-text-muted">Tap for details</span>
                </div>
                {nextStatuses.length > 0 && (
                  <div className="flex gap-2 mt-3 pt-1">
                    {nextStatuses.map(ns => (
                      <button key={ns} onClick={e => { e.stopPropagation(); updateStatus(o.id, ns); }} disabled={updating === o.id}
                        className="flex-1 h-10 rounded-lg font-sans text-[13px] font-semibold border-none cursor-pointer transition-colors"
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

      {/* Order detail bottom sheet */}
      {detailId && (
        <OrderDetailSheet orderId={detailId} onClose={() => setDetailId(null)} onStatusChange={loadOrders} />
      )}
    </div>
  );
}

/* ─── Standing (Recurring) Orders Panel ─── */
const FREQUENCY_LABELS: Record<string, string> = {
  daily: 'Daily', twice_weekly: 'Twice weekly', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly',
};
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function RecurringPanel({ farmId, marketId }: { farmId?: string; marketId?: string }) {
  const [recurring, setRecurring] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    const params: Record<string, string> = {};
    if (farmId) params.farm_id = farmId;
    else if (marketId) params.market_id = marketId;
    api.getRecurringOrders(Object.keys(params).length ? params : undefined)
      .then((data: any) => setRecurring(data.recurring_orders || []))
      .catch(err => console.error('Failed to load standing orders:', err))
      .finally(() => setLoading(false));
  }, [farmId, marketId]);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (ro: any) => {
    setBusyId(ro.id);
    try {
      await api.updateRecurringOrder(ro.id, { active: !ro.active });
      load();
    } catch (err) {
      console.error('Failed to update standing order:', err);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await api.deleteRecurringOrder(id);
      setPendingDelete(null);
      load();
    } catch (err) {
      console.error('Failed to delete standing order:', err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="font-sans text-[13px] text-text-muted m-0">
          Standing orders are placed automatically on their schedule.
        </p>
        {farmId && (
          <button onClick={() => setShowForm(true)}
            className="font-sans text-[13px] font-semibold bg-[#2E6B34] text-white border-none rounded-lg px-3.5 h-9 cursor-pointer hover:opacity-90 transition-opacity">
            + New Standing Order
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center text-text-muted text-sm py-10">Loading...</div>
      ) : recurring.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-10">
          No standing orders yet{farmId ? ' — create one to automate repeat deliveries' : ''}
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {recurring.map((ro: any, i: number) => (
            <div key={ro.id}
              className="bg-white rounded-2xl p-4 border border-border-light flex flex-col"
              style={{ animation: `fadeUp 0.3s ease ${i * 0.04}s both`, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', opacity: ro.active ? 1 : 0.6 }}>
              <div className="flex justify-between items-center mb-2">
                <span className="font-sans text-[15px] font-semibold text-text">
                  {farmId ? ro.market_name : ro.farm_name}
                </span>
                <span className="font-sans text-[11px] font-semibold px-2.5 py-1 rounded-full"
                  style={{ color: ro.active ? '#2E6B34' : '#9A9A9A', background: ro.active ? '#E8F5E3' : '#F0F0F0' }}>
                  {ro.active ? 'Active' : 'Paused'}
                </span>
              </div>
              <div className="font-sans text-[12px] text-text-muted mb-2">
                {FREQUENCY_LABELS[ro.frequency] || ro.frequency} · {ro.schedule_days}
                {ro.next_delivery && <> · Next: {new Date(ro.next_delivery).toLocaleDateString()}</>}
              </div>
              {ro.items && ro.items.length > 0 && (
                <div className="bg-bg rounded-xl border border-border-light px-3 py-2 mb-3">
                  {ro.items.map((item: any, idx: number) => (
                    <div key={item.id || idx} className="font-sans text-[12.5px] text-text-soft py-0.5">
                      {item.quantity} {item.unit} {item.product_name}
                    </div>
                  ))}
                </div>
              )}
              {farmId && (
                <div className="flex gap-2 mt-auto">
                  <button onClick={() => toggleActive(ro)} disabled={busyId === ro.id}
                    className="flex-1 h-9 rounded-lg font-sans text-[13px] font-semibold border-none cursor-pointer"
                    style={{ background: ro.active ? '#FFF3EB' : '#E8F5E3', color: ro.active ? '#D4763C' : '#2E6B34', opacity: busyId === ro.id ? 0.5 : 1 }}>
                    {busyId === ro.id ? '...' : ro.active ? 'Pause' : 'Resume'}
                  </button>
                  {pendingDelete === ro.id ? (
                    <button onClick={() => remove(ro.id)} disabled={busyId === ro.id}
                      className="flex-1 h-9 rounded-lg font-sans text-[13px] font-semibold border-none cursor-pointer"
                      style={{ background: '#C44B3F', color: 'white', opacity: busyId === ro.id ? 0.5 : 1 }}>
                      Confirm delete
                    </button>
                  ) : (
                    <button onClick={() => setPendingDelete(ro.id)}
                      className="h-9 rounded-lg font-sans text-[13px] font-semibold border-none cursor-pointer px-3"
                      style={{ background: '#FDECEB', color: '#C44B3F' }}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showForm && farmId && (
        <RecurringOrderForm farmId={farmId} onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load(); }} />
      )}
    </div>
  );
}

/* ─── New Standing Order Form (bottom sheet) ─── */
function RecurringOrderForm({ farmId, onClose, onCreated }: { farmId: string; onClose: () => void; onCreated: () => void }) {
  const [markets, setMarkets] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [marketId, setMarketId] = useState('');
  const [frequency, setFrequency] = useState('weekly');
  const [days, setDays] = useState<string[]>([]);
  const [nextDelivery, setNextDelivery] = useState('');
  const [items, setItems] = useState<{ product_id: string; quantity: string; unit: string }[]>([
    { product_id: '', quantity: '', unit: 'lb' },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.directoryMarkets({ farm_id: farmId })
      .then((data: any) => {
        const connected = (data.markets || []).filter((m: any) => m.connection?.status === 'active');
        setMarkets(connected.length > 0 ? connected : data.markets || []);
      })
      .catch(err => console.error('Failed to load markets:', err));
    api.getProducts({ farm_id: farmId })
      .then((data: any) => setProducts(data.products || []))
      .catch(err => console.error('Failed to load products:', err));
  }, [farmId]);

  const setItem = (idx: number, patch: Partial<{ product_id: string; quantity: string; unit: string }>) => {
    setItems(prev => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const toggleDay = (day: string) => {
    setDays(prev => (prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]));
  };

  const submit = async () => {
    setError(null);
    const validItems = items.filter(it => it.product_id && Number(it.quantity) > 0 && it.unit);
    if (!marketId) return setError('Choose a market.');
    if (days.length === 0) return setError('Pick at least one delivery day.');
    if (!nextDelivery) return setError('Set the first delivery date.');
    if (validItems.length === 0) return setError('Add at least one item with a product and quantity.');

    setSaving(true);
    try {
      await api.createRecurringOrder({
        farm_id: farmId,
        market_id: marketId,
        frequency,
        schedule_days: WEEKDAYS.filter(d => days.includes(d)).join(', '),
        next_delivery: nextDelivery,
        items: validItems.map(it => ({ product_id: it.product_id, quantity: Number(it.quantity), unit: it.unit })),
      });
      onCreated();
    } catch (err: any) {
      setError(err?.message || 'Failed to create standing order.');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full h-10 rounded-lg border border-border bg-white px-3 font-sans text-[14px] text-text outline-none focus:border-green-600';

  return (
    <div ref={backdropRef} onClick={e => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)', animation: 'fadeIn 0.2s ease' }}>
      <div className="bg-white w-full sm:max-w-[520px] sm:rounded-2xl rounded-t-2xl max-h-[90vh] flex flex-col"
        style={{ animation: 'slideUp 0.3s ease', boxShadow: '0 -4px 30px rgba(0,0,0,0.12)' }}>
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>
        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-border-light">
          <div className="font-display font-bold text-[18px] text-text">New Standing Order</div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-bg border border-border flex items-center justify-center cursor-pointer text-text-muted text-sm hover:bg-gray-100 transition-colors">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">Market</div>
            <select className={inputCls} value={marketId} onChange={e => setMarketId(e.target.value)}>
              <option value="">Choose a market...</option>
              {markets.map((m: any) => (
                <option key={m.id} value={m.id}>{m.name}{m.location ? ` — ${m.location}` : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">Frequency</div>
            <select className={inputCls} value={frequency} onChange={e => setFrequency(e.target.value)}>
              {Object.entries(FREQUENCY_LABELS).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">Delivery day(s)</div>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map(day => (
                <button key={day} onClick={() => toggleDay(day)}
                  className="font-sans text-[12px] font-semibold rounded-lg px-2.5 h-8 cursor-pointer border transition-colors"
                  style={{
                    background: days.includes(day) ? '#2E6B34' : 'white',
                    color: days.includes(day) ? 'white' : 'var(--text-soft, #555)',
                    borderColor: days.includes(day) ? '#2E6B34' : 'var(--border, #ddd)',
                  }}>
                  {day.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">First delivery</div>
            <input type="date" className={inputCls} value={nextDelivery} min={new Date().toISOString().slice(0, 10)}
              onChange={e => setNextDelivery(e.target.value)} />
          </div>

          <div>
            <div className="font-sans text-[12px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">Items</div>
            <div className="space-y-2">
              {items.map((it, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <select className={inputCls} style={{ flex: 2 }} value={it.product_id}
                    onChange={e => setItem(idx, { product_id: e.target.value })}>
                    <option value="">Product...</option>
                    {products.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <input type="number" min="0" step="any" placeholder="Qty" className={inputCls} style={{ flex: 1 }}
                    value={it.quantity} onChange={e => setItem(idx, { quantity: e.target.value })} />
                  <input type="text" placeholder="Unit" className={inputCls} style={{ flex: 1 }}
                    value={it.unit} onChange={e => setItem(idx, { unit: e.target.value })} />
                  {items.length > 1 && (
                    <button onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                      className="w-8 h-8 shrink-0 rounded-full bg-red-50 border border-red-200 text-red-500 cursor-pointer text-sm">✕</button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={() => setItems(prev => [...prev, { product_id: '', quantity: '', unit: 'lb' }])}
              className="mt-2 font-sans text-[13px] font-semibold text-[#2E6B34] bg-transparent border-none cursor-pointer p-0">
              + Add another item
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 font-sans text-[13px] text-red-700">{error}</div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border-light flex gap-2">
          <button onClick={onClose}
            className="flex-1 h-12 rounded-xl font-sans text-[14px] font-semibold border border-border bg-white text-text-soft cursor-pointer">
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
            className="flex-1 h-12 rounded-xl font-sans text-[14px] font-semibold border-none cursor-pointer text-white"
            style={{ background: '#2E6B34', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Creating...' : 'Create Standing Order'}
          </button>
        </div>
      </div>
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
  const [editHarvest, setEditHarvest] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);

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
    setEditHarvest(item.harvest_date ? new Date(item.harvest_date).toISOString().slice(0, 10) : '');
  };

  const saveEdit = async (id: string) => {
    try {
      await api.updateInventory(id, {
        remaining: Number(editQty),
        price: Number(editPrice),
        harvest_date: editHarvest || null,
      });
      setEditing(null);
      loadInventory();
    } catch (err) {
      console.error('Failed to update inventory:', err);
    }
  };

  const deleteItem = async (id: string) => {
    setDeleteBusy(id);
    try {
      await api.deleteInventory(id);
      setPendingDelete(null);
      loadInventory();
    } catch (err: any) {
      console.error('Failed to delete inventory:', err);
      alert(err?.message || 'Could not delete this item. Please try again.');
    } finally {
      setDeleteBusy(null);
    }
  };

  // Phase B: add/replace/delete a produce photo on an existing item.
  const setPhoto = async (id: string, file: File) => {
    setPhotoBusy(id);
    try {
      const { url } = await api.uploadImage(file);
      await api.updateInventory(id, { image_url: url });
      loadInventory();
    } catch (err) {
      console.error('Failed to set produce photo:', err);
      alert('Failed to upload photo. Please try again.');
    } finally {
      setPhotoBusy(null);
    }
  };

  const removePhoto = async (id: string) => {
    setPhotoBusy(id);
    try {
      await api.updateInventory(id, { image_url: null });
      loadInventory();
    } catch (err) {
      console.error('Failed to remove produce photo:', err);
    } finally {
      setPhotoBusy(null);
    }
  };

  const clearAll = async () => {
    try {
      await Promise.all(
        inventory.map(item =>
          api.updateInventory(item.id, { remaining: 0, status: 'sold' })
        )
      );
      setClearConfirm(false);
      loadInventory();
    } catch (err) {
      console.error('Failed to clear inventory:', err);
    }
  };

  const activeInventory = inventory.filter(i => i.status !== 'sold');

  const statusStyles: Record<string, { bg: string; color: string; label: string }> = {
    available: { bg: '#E8F5E3', color: '#2E6B34', label: 'Available' },
    partial: { bg: '#FFF3EB', color: '#D4763C', label: 'Partial' },
    sold: { bg: '#FDECEB', color: '#C44B3F', label: 'Sold' },
  };

  return (
    <div className="p-6 max-w-[1100px] mx-auto w-full">
      <div className="flex justify-between items-center mb-5">
        <h2 className="font-display font-bold text-[22px] text-text m-0">{isFarmer ? 'Inventory' : 'Available Items'}</h2>
        {isFarmer && activeInventory.length > 0 && !clearConfirm && (
          <button
            onClick={() => setClearConfirm(true)}
            className="text-[13px] font-semibold font-sans text-red-600 border border-red-200 bg-red-50 rounded-lg px-3.5 h-9 cursor-pointer hover:bg-red-100 transition-colors"
          >
            Clear All
          </button>
        )}
      </div>
      {clearConfirm && (
        <div className="mb-5 p-4 rounded-xl border border-red-200 bg-red-50">
          <p className="font-sans text-sm text-red-700 m-0 mb-3">Mark all {activeInventory.length} active items as sold (qty 0)?</p>
          <div className="flex gap-2">
            <button onClick={clearAll} className="flex-1 h-10 rounded-lg bg-red-600 text-white border-none font-sans text-[13px] font-semibold cursor-pointer">Yes, clear all</button>
            <button onClick={() => setClearConfirm(false)} className="flex-1 h-10 rounded-lg bg-white border border-red-200 font-sans text-[13px] font-semibold text-red-600 cursor-pointer">Cancel</button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="text-center text-text-muted text-sm py-10">Loading...</div>
      ) : inventory.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-10">No inventory items</div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {inventory.map((item: any, i: number) => {
            // Derive the badge from quantities so it can't drift out of sync with stock.
            const rem = Number(item.remaining ?? item.quantity ?? 0);
            const qty = Number(item.quantity ?? rem);
            const derivedStatus = rem <= 0 ? 'sold' : rem < qty ? 'partial' : 'available';
            const s = statusStyles[derivedStatus] || statusStyles.available;
            const isEditing = editing === item.id;
            return (
              <div key={item.id || i} className="bg-white rounded-2xl border border-border-light overflow-hidden flex flex-col"
                style={{ animation: `fadeUp 0.3s ease ${i * 0.04}s both`, opacity: derivedStatus === 'sold' ? 0.55 : 1, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                {/* Photo zone */}
                <div className="relative h-36 bg-bg-alt flex items-center justify-center overflow-hidden">
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.product_name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-4xl opacity-50">🌱</div>
                  )}
                  <span className="absolute top-2.5 right-2.5 text-[11px] font-bold font-sans px-2.5 py-1 rounded-full backdrop-blur" style={{ background: `${s.bg}E6`, color: s.color }}>{s.label}</span>
                  {derivedStatus !== 'sold' && (item.freshness === 'aging' || item.freshness === 'past') && (
                    <span className="absolute top-2.5 left-2.5 text-[11px] font-bold font-sans px-2.5 py-1 rounded-full backdrop-blur"
                      style={{
                        background: item.freshness === 'past' ? '#C44B3FE6' : '#D4763CE6',
                        color: 'white',
                      }}
                      title={`${item.age_days} days old — estimated shelf life ${item.shelf_life_days} days`}>
                      {item.freshness === 'past' ? `${item.age_days}d — donate/compost` : `${item.age_days}d — sell soon`}
                    </span>
                  )}
                  {isFarmer && (
                    <div className="absolute bottom-2.5 right-2.5 flex gap-1.5">
                      <label className="h-8 px-3 rounded-full bg-black/55 backdrop-blur text-white text-[12px] font-semibold flex items-center cursor-pointer hover:bg-black/70 transition-colors">
                        {photoBusy === item.id ? '…' : item.image_url ? 'Replace' : '+ Photo'}
                        <input type="file" accept="image/*" capture="environment" className="hidden" disabled={photoBusy === item.id}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhoto(item.id, f); e.target.value = ''; }} />
                      </label>
                      {item.image_url && (
                        <button onClick={() => removePhoto(item.id)} className="w-8 h-8 rounded-full bg-black/55 backdrop-blur text-white text-sm flex items-center justify-center cursor-pointer hover:bg-black/70 border-none" title="Remove photo">✕</button>
                      )}
                    </div>
                  )}
                </div>
                {/* Body */}
                <div className="p-4 flex-1 flex flex-col">
                  <div className="font-sans text-[16px] font-semibold text-text leading-tight">{item.product_name}</div>
                  {!isFarmer && item.farm_name && (
                    <div className="font-sans text-[12px] text-text-muted mt-0.5">from {item.farm_name}</div>
                  )}
                  {isEditing ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <label className="font-sans text-[12px] text-text-muted w-10">Qty</label>
                        <input value={editQty} onChange={e => setEditQty(e.target.value)} className="flex-1 h-9 px-3 rounded-lg border border-border bg-white font-mono text-sm text-text outline-none focus:border-green-500" />
                        <span className="font-sans text-[12px] text-text-muted">{item.unit}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="font-sans text-[12px] text-text-muted w-10">$</label>
                        <input value={editPrice} onChange={e => setEditPrice(e.target.value)} className="flex-1 h-9 px-3 rounded-lg border border-border bg-white font-mono text-sm text-text outline-none focus:border-green-500" />
                        <span className="font-sans text-[12px] text-text-muted">/{item.unit}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="font-sans text-[12px] text-text-muted w-10">Harv.</label>
                        <input type="date" value={editHarvest} onChange={e => setEditHarvest(e.target.value)} className="flex-1 h-9 px-3 rounded-lg border border-border bg-white font-sans text-[13px] text-text outline-none focus:border-green-500" />
                      </div>
                      <div className="flex gap-2 mt-1">
                        <button onClick={() => saveEdit(item.id)} className="flex-1 h-10 rounded-lg bg-green-600 text-white border-none font-sans text-[13px] font-semibold cursor-pointer">Save</button>
                        <button onClick={() => setEditing(null)} className="flex-1 h-10 rounded-lg bg-bg border border-border font-sans text-[13px] font-semibold text-text-muted cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between mt-2">
                        <span className="font-sans text-[15px] text-text-soft">{item.remaining ?? item.quantity ?? 0} <span className="text-text-muted text-[13px]">{item.unit}</span></span>
                        <span className="font-mono text-[16px] font-bold" style={{ color: '#2E6B34' }}>${Number(item.price || 0).toFixed(2)}<span className="text-[11px] font-medium text-text-muted">/{item.unit}</span></span>
                      </div>
                      {item.harvest_date && <div className="font-sans text-[12px] text-text-muted mt-1.5">Harvested {new Date(item.harvest_date).toLocaleDateString()}</div>}
                      {isFarmer && (
                        pendingDelete === item.id ? (
                          <div className="flex flex-col gap-2 mt-auto pt-3">
                            <span className="font-sans text-[13px] text-red-600 font-semibold text-center">Delete this item?</span>
                            <div className="flex gap-2">
                              <button onClick={() => deleteItem(item.id)} disabled={deleteBusy === item.id} className="flex-1 h-10 rounded-lg bg-red-600 text-white border-none font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">{deleteBusy === item.id ? 'Deleting…' : 'Yes, delete'}</button>
                              <button onClick={() => setPendingDelete(null)} className="flex-1 h-10 rounded-lg bg-bg border border-border font-sans text-[13px] font-semibold text-text-muted cursor-pointer">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2 mt-auto pt-3">
                            <button onClick={() => startEdit(item)} className="flex-1 h-10 rounded-lg bg-bg border border-border-light font-sans text-[13px] font-semibold text-text-soft cursor-pointer hover:bg-earth-25 transition-colors flex items-center justify-center gap-1.5">
                              <Icon name="edit" size={13} className="text-text-muted" /> Edit
                            </button>
                            <button onClick={() => setPendingDelete(item.id)} className="flex-1 h-10 rounded-lg bg-bg border border-red-200 font-sans text-[13px] font-semibold text-red-500 cursor-pointer hover:bg-red-50 transition-colors flex items-center justify-center" title="Delete item">
                              Delete
                            </button>
                          </div>
                        )
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {isFarmer && (
        <div className="mt-5 p-4 rounded-xl border border-dashed" style={{ background: '#E8F5E3', borderColor: 'rgba(46,107,52,0.25)' }}>
          <p className="font-sans text-[13px] leading-relaxed m-0" style={{ color: '#2E6B34' }}>
            <strong>Tip:</strong> Add inventory by texting — just send &ldquo;50lb jalapeños at $2.49&rdquo;
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
    <div className="p-6 max-w-[760px] mx-auto w-full">
      <div className="flex justify-between items-center mb-5">
        <h2 className="font-display font-bold text-[22px] text-text m-0">Your Markets</h2>
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
    <div className="p-6 max-w-[760px] mx-auto w-full">
      <h2 className="font-display font-bold text-[22px] text-text mb-5">Your Farms</h2>
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

function DirectoryPanel({ isFarmer, farmId, marketId }: { isFarmer: boolean; farmId?: string; marketId?: string }) {
  const [tab, setTab] = useState<'browse' | 'pending'>('browse');
  const [search, setSearch] = useState('');
  const [entities, setEntities] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  const fetchEntities = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (isFarmer && farmId) params.farm_id = farmId;
      if (!isFarmer && marketId) params.market_id = marketId;
      const res = isFarmer
        ? await api.directoryMarkets(params)
        : await api.directoryFarms(params);
      setEntities(res.markets ?? res.farms ?? []);
    } finally {
      setLoading(false);
    }
  }, [isFarmer, farmId, marketId, search]);

  const fetchPending = useCallback(async () => {
    const params: Record<string, string> = {};
    if (farmId) params.farm_id = farmId;
    if (marketId) params.market_id = marketId;
    const res = await api.pendingConnections(params);
    setPending(res.pending ?? []);
  }, [farmId, marketId]);

  useEffect(() => { fetchEntities(); }, [fetchEntities]);
  useEffect(() => { fetchPending(); }, [fetchPending]);

  const handleConnect = async (entityId: string) => {
    try {
      setActionMsg('');
      await api.connectionRequest({
        farm_id: isFarmer ? farmId! : entityId,
        market_id: isFarmer ? entityId : marketId!,
        initiated_by: isFarmer ? 'farm' : 'market',
      });
      setActionMsg('Connection request sent!');
      fetchEntities();
      fetchPending();
    } catch (e: any) {
      setActionMsg(e.message || 'Error sending request');
    }
  };

  const handleRespond = async (relId: string, accept: boolean) => {
    try {
      setActionMsg('');
      await api.connectionRespond(relId, accept);
      setActionMsg(accept ? 'Connection accepted!' : 'Request declined.');
      fetchPending();
      fetchEntities();
    } catch (e: any) {
      setActionMsg(e.message || 'Error responding');
    }
  };

  const statusBadge = (status: string | undefined) => {
    if (status === 'active') return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-sans" style={{ background: '#e6f4ea', color: '#2E6B34' }}>Connected</span>;
    if (status === 'pending') return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-sans bg-yellow-100 text-yellow-800">Pending</span>;
    if (status === 'declined') return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-sans bg-gray-100 text-gray-500">Declined</span>;
    return null;
  };

  return (
    <div className="h-full flex flex-col gap-4 p-6 max-w-[760px] mx-auto w-full">
      <div className="flex gap-2">
        {(['browse', 'pending'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`font-sans text-sm px-3 py-1.5 rounded-lg capitalize transition-colors ${tab === t ? 'bg-[#2E6B34] text-white' : 'bg-surface-raised text-text-muted hover:text-text'}`}>
            {t}{t === 'pending' && pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
        ))}
      </div>

      {actionMsg && <div className="font-sans text-sm text-[#2E6B34] bg-[#e6f4ea] px-3 py-2 rounded-lg">{actionMsg}</div>}

      {tab === 'browse' && (
        <div className="flex flex-col gap-3 flex-1 overflow-auto">
          <input
            className="font-sans text-sm border border-border-light rounded-lg px-3 py-2 bg-surface-raised text-text placeholder:text-text-muted focus:outline-none focus:border-[#2E6B34]"
            placeholder={`Search ${isFarmer ? 'markets' : 'farms'}…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchEntities()}
          />
          {loading ? (
            <div className="font-sans text-sm text-text-muted">Loading…</div>
          ) : entities.length === 0 ? (
            <div className="font-sans text-sm text-text-muted">No results found.</div>
          ) : (
            entities.map((e: any) => (
              <div key={e.id} className="bg-surface-raised rounded-xl p-3 flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-sans text-sm font-semibold text-text">{e.name}</span>
                    {statusBadge(e.connection_status)}
                  </div>
                  {e.location && <div className="font-sans text-xs text-text-muted mt-0.5">{e.location}</div>}
                  {e.specialty && <div className="font-sans text-xs text-text-muted">{e.specialty}</div>}
                  {e.type && <div className="font-sans text-xs text-text-muted">{e.type}</div>}
                </div>
                {e.connection_status !== 'active' && (
                  <button
                    onClick={() => handleConnect(e.id)}
                    className="font-sans text-xs px-2.5 py-1.5 rounded-lg bg-[#2E6B34] text-white shrink-0 hover:opacity-90 transition-opacity"
                  >
                    {e.connection_status === 'pending' ? 'Pending' : e.connection_status === 'declined' ? 'Re-request' : 'Connect'}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'pending' && (
        <div className="flex flex-col gap-3 flex-1 overflow-auto">
          {pending.length === 0 ? (
            <div className="font-sans text-sm text-text-muted">No pending requests.</div>
          ) : (
            pending.map((r: any) => {
              const myId = isFarmer ? farmId : marketId;
              const initiatorId = isFarmer ? r.farm?.id : r.market?.id;
              const isIncoming = initiatorId !== myId;
              const otherName = isFarmer ? r.market?.name : r.farm?.name;
              return (
                <div key={r.rel_id} className="bg-surface-raised rounded-xl p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-sans text-sm font-semibold text-text">{otherName}</span>
                      <div className="font-sans text-xs text-text-muted mt-0.5">
                        {isIncoming ? 'Wants to connect with you' : 'Waiting for their response'}
                      </div>
                      {r.message && <div className="font-sans text-xs text-text-muted italic mt-1">"{r.message}"</div>}
                    </div>
                    {isIncoming && (
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => handleRespond(r.rel_id, true)}
                          className="font-sans text-xs px-2.5 py-1.5 rounded-lg bg-[#2E6B34] text-white hover:opacity-90 transition-opacity">
                          Accept
                        </button>
                        <button onClick={() => handleRespond(r.rel_id, false)}
                          className="font-sans text-xs px-2.5 py-1.5 rounded-lg bg-surface border border-border-light text-text-muted hover:text-text transition-colors">
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Markets/Farms view: My connections, Find New, and Invite ─── */
function ConnectionsView({ isFarmer, farmId, marketId }: { isFarmer: boolean; farmId?: string; marketId?: string }) {
  const [mode, setMode] = useState<'mine' | 'find'>('mine');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState('');

  const label = isFarmer ? 'Markets' : 'Farms';
  const singular = isFarmer ? 'market' : 'farm';

  const sendInvite = async () => {
    if (!invitePhone.trim()) return;
    setInviteBusy(true);
    setInviteMsg('');
    try {
      const res = await api.invite({ phone: invitePhone.trim(), name: inviteName.trim() || undefined });
      setInviteMsg(res.message || 'Invitation sent!');
      setInvitePhone('');
      setInviteName('');
    } catch (e: any) {
      setInviteMsg(e.message || 'Failed to send invitation');
    } finally {
      setInviteBusy(false);
    }
  };

  const tabBtn = (active: boolean) =>
    ({ background: active ? '#fff' : 'transparent', color: active ? '#2E6B34' : '#9A9A9A', boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' });

  return (
    <div className="w-full">
      {/* Control bar */}
      <div className="max-w-[1100px] mx-auto px-6 pt-6 pb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full bg-bg-alt p-1">
          <button onClick={() => setMode('mine')} className="h-9 px-4 rounded-full border-none cursor-pointer text-[13px] font-semibold font-sans transition-all" style={tabBtn(mode === 'mine')}>My {label}</button>
          <button onClick={() => setMode('find')} className="h-9 px-4 rounded-full border-none cursor-pointer text-[13px] font-semibold font-sans transition-all" style={tabBtn(mode === 'find')}>Find New {label}</button>
        </div>
        <button onClick={() => { setInviteOpen(o => !o); setInviteMsg(''); }} className="h-9 px-4 rounded-full border-none cursor-pointer text-[13px] font-semibold font-sans text-white flex items-center gap-1.5 active:scale-95 transition-transform" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
          <Icon name="msg" size={14} className="text-white" /> Invite
        </button>
      </div>

      {/* Invite form */}
      {inviteOpen && (
        <div className="max-w-[1100px] mx-auto px-6 pt-3">
          <div className="p-4 rounded-2xl border border-green-200 bg-green-50">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-sans font-bold text-[15px] text-green-700 m-0">Invite a farm or market to FarmLink</h3>
              <button onClick={() => setInviteOpen(false)} className="bg-transparent border-none cursor-pointer text-text-muted text-lg leading-none">✕</button>
            </div>
            <p className="font-sans text-[13px] text-text-soft mb-3">We&apos;ll text them an invitation to join — just enter their number.</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="Name (optional)" className="flex-1 h-11 px-3.5 rounded-xl border border-border bg-white font-sans text-[15px] text-text outline-none focus:border-green-500" />
              <input value={invitePhone} onChange={e => setInvitePhone(e.target.value)} type="tel" placeholder="Phone number" className="flex-1 h-11 px-3.5 rounded-xl border border-border bg-white font-sans text-[15px] text-text outline-none focus:border-green-500" />
              <button onClick={sendInvite} disabled={!invitePhone.trim() || inviteBusy} className="h-11 px-5 rounded-xl text-white border-none font-sans font-semibold text-[14px] cursor-pointer disabled:opacity-40" style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
                {inviteBusy ? 'Sending…' : 'Send Invite'}
              </button>
            </div>
            {inviteMsg && (
              <div className="mt-2.5 font-sans text-[13px] font-semibold" style={{ color: /fail|could not|error/i.test(inviteMsg) ? '#C44B3F' : '#2E6B34' }}>{inviteMsg}</div>
            )}
          </div>
        </div>
      )}

      {/* Body */}
      {mode === 'mine'
        ? (isFarmer ? <MarketsPanel farmId={farmId} /> : <FarmsPanel marketId={marketId} />)
        : <DirectoryPanel isFarmer={isFarmer} farmId={farmId} marketId={marketId} />}
    </div>
  );
}
