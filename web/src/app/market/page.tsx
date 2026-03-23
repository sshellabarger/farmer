'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';
import { Card } from '@/components/ui';

const EMOJI: Record<string, string> = {
  Vegetables: '🥬', Fruits: '🍎', Herbs: '🌿', Greens: '🥗', Berries: '🫐',
  Roots: '🥕', Dairy: '🧀', Eggs: '🥚', Meat: '🥩', Honey: '🍯',
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#e65100', confirmed: '#2e7d32', in_transit: '#1565c0',
  delivered: '#4a7c28', cancelled: '#d32f2f',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function MarketDashboard() {
  const { user, market, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('browse');
  const [available, setAvailable] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [connectedFarms, setConnectedFarms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // View mode for browse: 'cards' or 'list'
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards');

  // Expandable detail state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Ordering state
  const [orderingId, setOrderingId] = useState<string | null>(null);
  const [orderQty, setOrderQty] = useState<number>(1);
  const [orderDeliveryType, setOrderDeliveryType] = useState<'pickup' | 'delivery'>('pickup');
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderFeedback, setOrderFeedback] = useState<{ id: string; ok: boolean; msg: string } | null>(null);

  // Farm discovery state
  const [showAddFarm, setShowAddFarm] = useState(false);
  const [allFarms, setAllFarms] = useState<any[]>([]);
  const [allFarmsLoading, setAllFarmsLoading] = useState(false);
  const [addFarmLoading, setAddFarmLoading] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!market) return;
    setLoading(true);
    try {
      const [avail, ord, msgs, farms] = await Promise.all([
        api.getMarketAvailable(market.id),
        api.getMarketOrders(market.id),
        api.getMarketMessages(market.id),
        api.getMarketFarms(market.id),
      ]);
      setAvailable(avail.inventory || []);
      setOrders(ord.orders || []);
      setMessages(msgs.messages || []);
      setConnectedFarms(farms.farms || []);
    } catch (err) {
      console.error('Failed to load market data', err);
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push('/login');
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (market) loadData();
  }, [market, loadData]);

  if (isLoading || loading) {
    return (
      <div className="min-h-screen bg-earth-15">
        <Header />
        <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-12 text-center text-earth-400">Loading...</div>
      </div>
    );
  }

  if (!market) {
    return (
      <div className="min-h-screen bg-earth-15">
        <Header />
        <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-12 text-center">
          <p className="text-earth-500">No market associated with this account.</p>
        </div>
      </div>
    );
  }

  const handlePlaceOrder = async (item: any) => {
    if (!market) return;
    setOrderSubmitting(true);
    setOrderFeedback(null);
    try {
      const result = await api.createOrder({
        farm_id: item.farm_id,
        market_id: market.id,
        items: [{ inventory_id: item.id, quantity: orderQty }],
        delivery_type: orderDeliveryType,
      });
      const deliveryAt = result?.scheduled_delivery_at
        ? new Date(result.scheduled_delivery_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
        : null;
      const msg = deliveryAt
        ? `Order placed! ${orderDeliveryType === 'delivery' ? 'Delivery' : 'Pickup'} scheduled for ${deliveryAt}`
        : 'Order placed!';
      setOrderFeedback({ id: item.id, ok: true, msg });
      setOrderingId(null);
      setOrderQty(1);
      setOrderDeliveryType('pickup');
      await loadData();
    } catch (err: any) {
      setOrderFeedback({ id: item.id, ok: false, msg: err.message || 'Failed to place order' });
    } finally {
      setOrderSubmitting(false);
    }
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(id);
    setExpandedDetail(null);
    setDetailLoading(true);
    try {
      const detail = await api.getOrder(id);
      setExpandedDetail(detail);
    } catch (err) {
      console.error('Failed to load order detail', err);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    try {
      await api.updateOrderStatus(orderId, 'cancelled');
      loadData();
      // If this order was expanded, refresh detail
      if (expandedId === orderId) {
        setExpandedId(null);
        setExpandedDetail(null);
      }
    } catch (err) {
      console.error('Failed to cancel order', err);
    }
  };

  const handleDiscoverFarms = async () => {
    setShowAddFarm(true);
    setAllFarmsLoading(true);
    try {
      const data = await api.getAllFarms();
      setAllFarms(data.farms || []);
    } catch (err) {
      console.error('Failed to load farms', err);
    } finally {
      setAllFarmsLoading(false);
    }
  };

  const handleAddFarm = async (farmId: string) => {
    if (!market) return;
    setAddFarmLoading(farmId);
    try {
      await api.createRelationship({
        farm_id: farmId,
        market_id: market.id,
        priority: 99,
        notification_delay_min: 0,
      });
      loadData();
      const data = await api.getAllFarms();
      setAllFarms(data.farms || []);
    } catch (err) {
      console.error('Failed to add farm', err);
    } finally {
      setAddFarmLoading(null);
    }
  };

  const pendingOrders = orders.filter((o: any) => o.status === 'pending');

  // Group orders by status for the orders tab
  const orderStatuses = ['pending', 'confirmed', 'in_transit', 'delivered', 'cancelled'];
  const ordersByStatus = orderStatuses
    .map((status) => ({
      status,
      label: STATUS_LABELS[status],
      orders: orders.filter((o: any) => o.status === status),
    }))
    .filter((g) => g.orders.length > 0);

  // ── Shared item card (used in both card and list mode) ──────
  const renderItemCard = (item: any) => (
    <Card key={item.id} style={{ padding: 0, overflow: 'hidden' }}>
      {item.image_url && (
        <div className="w-full h-28 sm:h-36 bg-earth-50">
          <img src={item.image_url} alt={item.product_name} className="w-full h-full object-cover" />
        </div>
      )}
      <div style={{ padding: 14 }}>
      <div className="flex justify-between items-start mb-1.5">
        <span className="font-bold text-sm text-earth-900">
          {EMOJI[item.category] || '📦'} {item.product_name}
        </span>
      </div>
      <div className="text-xs text-earth-500 mb-1">
        <span className="font-medium text-earth-600">🌱 {item.farm_name}</span>
      </div>
      <div className="text-xs text-earth-500 mb-2">
        {item.remaining} {item.unit} available
      </div>
      <div className="flex justify-between items-center">
        <span className="font-extrabold text-farm-700 font-display">
          ${Number(item.price).toFixed(2)}/{item.unit}
        </span>
      </div>
      {item.harvest_date && (
        <div className="text-[10px] text-earth-400 mt-1.5">
          Harvested {new Date(item.harvest_date).toLocaleDateString()}
        </div>
      )}

      {/* Order button / inline form */}
      {orderingId === item.id ? (
        <div className="mt-3 pt-3 border-t border-earth-100">
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs text-earth-500 font-semibold whitespace-nowrap">Qty ({item.unit}):</label>
            <input
              type="number"
              min={1}
              max={Number(item.remaining)}
              value={orderQty}
              onChange={(e) => setOrderQty(Math.max(1, Math.min(Number(item.remaining), Number(e.target.value))))}
              className="w-20 px-2 py-1 text-sm border border-earth-200 rounded-lg bg-white text-earth-900 focus:outline-none focus:ring-2 focus:ring-farm-600"
            />
          </div>
          <div className="mb-2">
            <label className="block text-xs text-earth-500 font-semibold mb-1">Fulfillment:</label>
            <div className="flex gap-2">
              <button
                onClick={() => setOrderDeliveryType('pickup')}
                className={`flex-1 px-3 py-1.5 text-xs font-bold rounded-lg border cursor-pointer transition-all ${
                  orderDeliveryType === 'pickup'
                    ? 'bg-farm-600 text-white border-farm-600'
                    : 'bg-white text-earth-600 border-earth-200 hover:border-farm-300'
                }`}
              >
                📍 Pickup
              </button>
              <button
                onClick={() => setOrderDeliveryType('delivery')}
                className={`flex-1 px-3 py-1.5 text-xs font-bold rounded-lg border cursor-pointer transition-all ${
                  orderDeliveryType === 'delivery'
                    ? 'bg-farm-600 text-white border-farm-600'
                    : 'bg-white text-earth-600 border-earth-200 hover:border-farm-300'
                }`}
              >
                🚚 Delivery
              </button>
            </div>
          </div>
          <div className="text-xs text-earth-500 mb-2">
            Subtotal: <span className="font-bold text-earth-900">${(orderQty * Number(item.price)).toFixed(2)}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handlePlaceOrder(item)}
              disabled={orderSubmitting}
              className="flex-1 px-3 py-1.5 text-xs font-bold text-white rounded-xl disabled:opacity-50 cursor-pointer border-none"
              style={{ background: '#2e7d32' }}
            >
              {orderSubmitting ? 'Placing...' : 'Place Order'}
            </button>
            <button
              onClick={() => { setOrderingId(null); setOrderQty(1); setOrderDeliveryType('pickup'); setOrderFeedback(null); }}
              className="px-3 py-1.5 text-xs font-bold text-earth-500 bg-earth-100 rounded-xl cursor-pointer border-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setOrderingId(item.id); setOrderQty(1); setOrderFeedback(null); }}
          className="mt-3 w-full px-3 py-1.5 text-xs font-bold text-white rounded-xl cursor-pointer border-none"
          style={{ background: '#2e7d32' }}
        >
          Order
        </button>
      )}

      {orderFeedback && orderFeedback.id === item.id && (
        <div className={`mt-2 text-xs font-semibold px-2 py-1 rounded-lg ${orderFeedback.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {orderFeedback.msg}
        </div>
      )}
      </div>
    </Card>
  );

  const renderItemRow = (item: any) => (
    <Card key={item.id} style={{ padding: '10px 14px' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {item.image_url ? (
            <img src={item.image_url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
          ) : (
            <span className="text-lg flex-shrink-0">{EMOJI[item.category] || '📦'}</span>
          )}
          <div className="min-w-0">
            <div className="font-bold text-sm text-earth-900 truncate">{item.product_name}</div>
            <div className="text-[11px] text-earth-500">🌱 {item.farm_name} · {item.remaining} {item.unit} avail.</div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="font-extrabold text-farm-700 font-display text-sm">
            ${Number(item.price).toFixed(2)}/{item.unit}
          </span>
          {orderingId === item.id ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={Number(item.remaining)}
                  value={orderQty}
                  onChange={(e) => setOrderQty(Math.max(1, Math.min(Number(item.remaining), Number(e.target.value))))}
                  className="w-16 px-2 py-1 text-xs border border-earth-200 rounded-lg bg-white text-earth-900 focus:outline-none focus:ring-2 focus:ring-farm-600"
                />
                <button
                  onClick={() => handlePlaceOrder(item)}
                  disabled={orderSubmitting}
                  className="px-3 py-1.5 text-[11px] font-bold text-white rounded-lg disabled:opacity-50 cursor-pointer border-none"
                  style={{ background: '#2e7d32' }}
                >
                  {orderSubmitting ? '...' : `$${(orderQty * Number(item.price)).toFixed(0)}`}
                </button>
                <button
                  onClick={() => { setOrderingId(null); setOrderQty(1); setOrderDeliveryType('pickup'); setOrderFeedback(null); }}
                  className="px-2 py-1.5 text-[11px] font-bold text-earth-500 bg-earth-100 rounded-lg cursor-pointer border-none"
                >
                  ✕
                </button>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setOrderDeliveryType('pickup')}
                  className={`px-2 py-1 text-[10px] font-bold rounded-md border cursor-pointer ${
                    orderDeliveryType === 'pickup' ? 'bg-farm-600 text-white border-farm-600' : 'bg-white text-earth-500 border-earth-200'
                  }`}
                >
                  📍 Pickup
                </button>
                <button
                  onClick={() => setOrderDeliveryType('delivery')}
                  className={`px-2 py-1 text-[10px] font-bold rounded-md border cursor-pointer ${
                    orderDeliveryType === 'delivery' ? 'bg-farm-600 text-white border-farm-600' : 'bg-white text-earth-500 border-earth-200'
                  }`}
                >
                  🚚 Delivery
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setOrderingId(item.id); setOrderQty(1); setOrderFeedback(null); }}
              className="px-3 py-1.5 text-[11px] font-bold text-white rounded-lg cursor-pointer border-none"
              style={{ background: '#2e7d32' }}
            >
              Order
            </button>
          )}
        </div>
      </div>
      {orderFeedback && orderFeedback.id === item.id && (
        <div className={`mt-1.5 text-xs font-semibold px-2 py-1 rounded-lg ${orderFeedback.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {orderFeedback.msg}
        </div>
      )}
    </Card>
  );

  // ── Expanded order detail block (reused) ────────────────────
  const renderOrderDetail = (order: any) => (
    expandedId === order.id && (
      <div className="mt-3 pt-3 border-t border-earth-100" onClick={(e) => e.stopPropagation()}>
        {detailLoading ? (
          <div className="text-xs text-earth-400 py-2">Loading details...</div>
        ) : expandedDetail ? (
          <div className="space-y-2.5">
            {expandedDetail.items && expandedDetail.items.length > 0 && (
              <div>
                <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1.5">Items</div>
                <div className="bg-earth-50 rounded-lg overflow-hidden">
                  {expandedDetail.items.map((item: any, i: number) => (
                    <div key={item.id || i} className={`flex justify-between items-center px-3 py-2 text-xs ${i > 0 ? 'border-t border-earth-100' : ''}`}>
                      <div>
                        <span className="font-semibold text-earth-900">{item.product_name}</span>
                        <span className="text-earth-400 ml-1.5">{item.quantity} {item.unit} × ${Number(item.unit_price).toFixed(2)}</span>
                      </div>
                      <span className="font-bold text-earth-900">${Number(item.line_total).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {expandedDetail.farm_location && (
                <div><span className="text-earth-400">Farm: </span><span className="text-earth-700 font-medium">{expandedDetail.farm_location}</span></div>
              )}
              {expandedDetail.delivery_type && (
                <div><span className="text-earth-400">Fulfillment: </span><span className="text-earth-700 font-medium capitalize">{expandedDetail.delivery_type === 'delivery' ? '🚚 Delivery' : '📍 Pickup'}</span></div>
              )}
              {expandedDetail.scheduled_delivery_at && (
                <div><span className="text-earth-400">Scheduled: </span><span className="text-earth-700 font-medium">{new Date(expandedDetail.scheduled_delivery_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>
              )}
              <div><span className="text-earth-400">Created: </span><span className="text-earth-700 font-medium">{new Date(expandedDetail.created_at).toLocaleString()}</span></div>
              {expandedDetail.updated_at && expandedDetail.updated_at !== expandedDetail.created_at && (
                <div><span className="text-earth-400">Updated: </span><span className="text-earth-700 font-medium">{new Date(expandedDetail.updated_at).toLocaleString()}</span></div>
              )}
            </div>
            {expandedDetail.notes && (
              <div className="text-xs text-earth-600 bg-earth-50 rounded-lg px-3 py-2">
                <span className="text-earth-400 font-semibold">Notes: </span>{expandedDetail.notes}
              </div>
            )}
            {/* Cancel button for pending orders */}
            {order.status === 'pending' && (
              <button
                onClick={() => handleCancelOrder(order.id)}
                className="w-full py-2 bg-red-50 text-red-600 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-red-100 transition-colors"
              >
                Cancel Order
              </button>
            )}
          </div>
        ) : null}
      </div>
    )
  );

  return (
    <div className="min-h-screen bg-earth-15">
      <Header />
      <ChatWidget />
      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-4 sm:py-5" style={{ animation: 'fadeIn 0.25s ease' }}>
        <h2 className="m-0 font-display font-extrabold text-earth-900 text-lg sm:text-xl mb-3 sm:mb-4">
          🏪 {market.name}
        </h2>

        {/* Stats row — clickable navigation */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 mb-4 sm:mb-5">
          {([
            { id: 'browse', label: 'Available Items', value: available.length },
            { id: 'farms', label: 'Producers', value: connectedFarms.length },
            { id: 'orders', label: 'Orders', value: orders.filter((o: any) => ['pending', 'confirmed', 'in_transit'].includes(o.status)).length },
            { id: 'messages', label: 'Messages', value: messages.length },
          ] as const).map((s) => (
            <Card
              key={s.id}
              onClick={() => setTab(s.id)}
              style={{ padding: '10px 12px', cursor: 'pointer', transition: 'all 0.15s' }}
              className={tab === s.id ? '!border-farm-500 !bg-farm-50' : 'hover:border-earth-200'}
            >
              <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-[3px]">
                {s.label}
              </div>
              <div className={`text-xl font-extrabold font-display ${tab === s.id ? 'text-farm-700' : 'text-earth-900'}`}>{s.value}</div>
            </Card>
          ))}
        </div>

        {/* ════════════════ Browse tab ════════════════ */}
        {tab === 'browse' && (
          <div>
            {/* View toggle */}
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-display font-bold text-earth-900 text-[15px]">Available Inventory</h3>
              <div className="flex bg-earth-100 rounded-lg p-0.5">
                <button
                  onClick={() => setViewMode('cards')}
                  className={`px-3 py-1 text-[11px] font-semibold rounded-md border-none cursor-pointer transition-colors ${
                    viewMode === 'cards' ? 'bg-white text-earth-900 shadow-sm' : 'text-earth-500 bg-transparent'
                  }`}
                >
                  Cards
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-3 py-1 text-[11px] font-semibold rounded-md border-none cursor-pointer transition-colors ${
                    viewMode === 'list' ? 'bg-white text-earth-900 shadow-sm' : 'text-earth-500 bg-transparent'
                  }`}
                >
                  List
                </button>
              </div>
            </div>

            {available.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">
                  No items available. Connect with producers to see their inventory.
                </p>
              </Card>
            ) : viewMode === 'cards' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {available.map(renderItemCard)}
              </div>
            ) : (
              <div className="space-y-1.5">
                {available.map(renderItemRow)}
              </div>
            )}
          </div>
        )}

        {/* ════════════════ Orders tab ════════════════ */}
        {tab === 'orders' && (
          <div>
            {orders.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">No orders yet.</p>
              </Card>
            ) : (
              <div className="space-y-5">
                {ordersByStatus.map((group) => (
                  <div key={group.status}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: STATUS_COLORS[group.status] }}
                      />
                      <h3 className="font-display font-bold text-earth-900 text-[15px]">
                        {group.label}
                      </h3>
                      <span className="text-[11px] text-earth-400 font-sans">
                        ({group.orders.length})
                      </span>
                    </div>
                    <div className="space-y-2">
                      {group.orders.map((order: any) => (
                        <Card key={order.id} style={{ padding: 16, cursor: 'pointer' }} onClick={() => toggleExpand(order.id)}>
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="font-bold text-sm text-earth-900 mb-0.5 flex items-center gap-1.5">
                                {order.order_number}
                                <span className="text-earth-300 text-xs">{expandedId === order.id ? '▾' : '▸'}</span>
                              </div>
                              <div className="text-xs text-earth-500">
                                🌱 {order.farm_name} · {new Date(order.order_date).toLocaleDateString()}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-extrabold text-farm-700 font-display">
                                ${Number(order.total).toFixed(2)}
                              </div>
                            </div>
                          </div>
                          {renderOrderDetail(order)}
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════════ Messages tab ════════════════ */}
        {tab === 'messages' && (
          <div className="space-y-2">
            <h3 className="font-display font-bold text-earth-900 text-[15px] mb-2.5">Activity Feed</h3>
            {messages.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">
                  No messages yet. Activity from orders and farm notifications will appear here.
                </p>
              </Card>
            ) : (
              messages.map((msg: any) => {
                const isOrder = msg.type === 'order';
                const isNewInventory = msg.notification_type === 'new_inventory';
                const isPriceChange = msg.notification_type === 'price_change';

                return (
                  <Card
                    key={msg.id}
                    style={{ padding: 14, cursor: isOrder ? 'pointer' : 'default' }}
                    onClick={() => isOrder && toggleExpand(msg.id)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-lg mt-0.5">
                        {isOrder
                          ? msg.status === 'cancelled' ? '❌'
                          : msg.status === 'confirmed' ? '✅'
                          : msg.status === 'in_transit' ? '🚚'
                          : msg.status === 'delivered' ? '📦'
                          : '🛒'
                          : isNewInventory ? '🆕'
                          : isPriceChange ? '💲'
                          : '🔔'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start gap-2">
                          <div className="font-bold text-sm text-earth-900 leading-tight flex items-center gap-1.5">
                            {msg.title}
                            {isOrder && (
                              <span className="text-earth-300 text-xs">{expandedId === msg.id ? '▾' : '▸'}</span>
                            )}
                          </div>
                          {/* Only show status badge for orders, not notifications */}
                          {isOrder && msg.status && (
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase whitespace-nowrap flex-shrink-0"
                              style={{
                                background: `${STATUS_COLORS[msg.status] || '#9e9e9e'}15`,
                                color: STATUS_COLORS[msg.status] || '#9e9e9e',
                              }}
                            >
                              {msg.status}
                            </span>
                          )}
                        </div>

                        {/* Description — enriched for new inventory */}
                        <div className="text-xs text-earth-500 mt-0.5">
                          {msg.description}
                        </div>

                        {/* Extra detail for inventory notifications */}
                        {isNewInventory && msg.product_name && (
                          <div className="mt-1.5 px-2.5 py-2 bg-earth-50 rounded-lg text-xs">
                            <span className="font-semibold text-earth-800">{msg.product_name}</span>
                            <span className="text-earth-500"> from </span>
                            <span className="font-semibold text-earth-800">{msg.from}</span>
                          </div>
                        )}

                        <div className="flex items-center gap-3 mt-1.5">
                          <span className="text-[10px] text-earth-400">
                            From: <span className="font-semibold text-earth-600">{msg.from}</span>
                          </span>
                          <span className="text-[10px] text-earth-400">
                            {timeAgo(msg.timestamp)}
                          </span>
                          {isOrder && msg.amount && (
                            <span className="text-[10px] font-bold text-farm-700">
                              ${Number(msg.amount).toFixed(2)}
                            </span>
                          )}
                        </div>

                        {/* Expanded order detail */}
                        {isOrder && expandedId === msg.id && (
                          <div className="mt-3 pt-3 border-t border-earth-100" onClick={(e) => e.stopPropagation()}>
                            {detailLoading ? (
                              <div className="text-xs text-earth-400 py-1">Loading details...</div>
                            ) : expandedDetail ? (
                              <div className="space-y-2">
                                {expandedDetail.items && expandedDetail.items.length > 0 && (
                                  <div className="bg-earth-50 rounded-lg overflow-hidden">
                                    {expandedDetail.items.map((item: any, i: number) => (
                                      <div key={item.id || i} className={`flex justify-between items-center px-3 py-2 text-xs ${i > 0 ? 'border-t border-earth-100' : ''}`}>
                                        <div>
                                          <span className="font-semibold text-earth-900">{item.product_name}</span>
                                          <span className="text-earth-400 ml-1.5">{item.quantity} {item.unit} × ${Number(item.unit_price).toFixed(2)}</span>
                                        </div>
                                        <span className="font-bold text-earth-900">${Number(item.line_total).toFixed(2)}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                  {expandedDetail.farm_location && (
                                    <div><span className="text-earth-400">Farm: </span><span className="text-earth-700 font-medium">{expandedDetail.farm_location}</span></div>
                                  )}
                                  {expandedDetail.delivery_pref && (
                                    <div><span className="text-earth-400">Delivery: </span><span className="text-earth-700 font-medium capitalize">{expandedDetail.delivery_pref}</span></div>
                                  )}
                                </div>
                                {msg.status === 'pending' && (
                                  <button
                                    onClick={() => handleCancelOrder(msg.id)}
                                    className="w-full py-2 bg-red-50 text-red-600 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-red-100 transition-colors"
                                  >
                                    Cancel Order
                                  </button>
                                )}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* ════════════════ Producers tab ════════════════ */}
        {tab === 'farms' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="font-display font-bold text-earth-900 text-[15px]">Connected Producers</h3>
              <button
                onClick={showAddFarm ? () => setShowAddFarm(false) : handleDiscoverFarms}
                className={`py-2 px-4 rounded-xl text-xs font-semibold cursor-pointer border-none transition-colors ${
                  showAddFarm
                    ? 'bg-earth-100 text-earth-600 hover:bg-earth-200'
                    : 'bg-farm-600 text-white hover:bg-farm-700'
                }`}
              >
                {showAddFarm ? 'Close' : '+ Add Producer'}
              </button>
            </div>

            {/* Discover panel */}
            {showAddFarm && (
              <Card style={{ padding: 20 }}>
                <div className="font-bold text-sm text-earth-900 mb-3">Available Producers</div>
                {allFarmsLoading ? (
                  <div className="text-xs text-earth-400 py-2">Loading...</div>
                ) : (
                  <div className="space-y-2">
                    {allFarms.filter((af: any) => !connectedFarms.some((cf: any) => cf.id === af.id)).length === 0 ? (
                      <p className="text-earth-400 text-xs text-center py-2">You're connected to all available producers!</p>
                    ) : (
                      allFarms
                        .filter((af: any) => !connectedFarms.some((cf: any) => cf.id === af.id))
                        .map((af: any) => (
                          <div key={af.id} className="flex justify-between items-center p-3 bg-earth-50 rounded-lg">
                            <div>
                              <div className="font-bold text-sm text-earth-900">🌱 {af.name}</div>
                              <div className="text-[11px] text-earth-500">
                                {af.location}{af.specialty && <> · {af.specialty}</>}
                              </div>
                            </div>
                            <button
                              onClick={() => handleAddFarm(af.id)}
                              disabled={addFarmLoading === af.id}
                              className="py-2 px-4 bg-farm-600 text-white rounded-xl text-xs font-semibold cursor-pointer border-none hover:bg-farm-700 transition-colors disabled:opacity-50"
                            >
                              {addFarmLoading === af.id ? 'Adding...' : 'Connect'}
                            </button>
                          </div>
                        ))
                    )}
                  </div>
                )}
              </Card>
            )}

            {connectedFarms.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">No connected producers yet. Click "+ Add Producer" to discover farms.</p>
              </Card>
            ) : (
              connectedFarms.map((f: any) => (
                <Card key={f.id} style={{ padding: 16 }}>
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="font-bold text-sm text-earth-900 flex items-center gap-2">
                        🌱 {f.name}
                        <span
                          className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{
                            background: f.active ? '#2e7d3215' : '#9e9e9e15',
                            color: f.active ? '#2e7d32' : '#9e9e9e',
                          }}
                        >
                          {f.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <div className="text-xs text-earth-500 mt-0.5">
                        {f.location}{f.specialty && <> · {f.specialty}</>}
                      </div>

                      {/* Stats grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-earth-100">
                        <div>
                          <div className="text-[10px] text-earth-400 font-semibold uppercase">Available</div>
                          <div className="text-lg font-extrabold text-farm-700 font-display">{f.available_items}</div>
                          <div className="text-[10px] text-earth-400">items</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-earth-400 font-semibold uppercase">Pending</div>
                          <div className={`text-lg font-extrabold font-display ${f.pending_orders > 0 ? 'text-orange-600' : 'text-earth-300'}`}>
                            {f.pending_orders}
                          </div>
                          {f.pending_orders > 0 && (
                            <div className="text-[10px] text-earth-500">${Number(f.pending_total).toFixed(0)}</div>
                          )}
                        </div>
                        <div>
                          <div className="text-[10px] text-earth-400 font-semibold uppercase">History</div>
                          <div className="text-lg font-extrabold text-earth-700 font-display">{f.history_orders}</div>
                          {f.history_orders > 0 && (
                            <div className="text-[10px] text-earth-500">${Number(f.history_total).toFixed(0)}</div>
                          )}
                        </div>
                      </div>

                      {/* Recent orders */}
                      {f.recent_orders && f.recent_orders.length > 0 && (
                        <div className="mt-2.5">
                          <div className="text-[10px] text-earth-400 font-semibold uppercase mb-1">Recent Orders</div>
                          <div className="space-y-1">
                            {f.recent_orders.map((o: any) => (
                              <div key={o.id} className="flex justify-between items-center text-[11px] px-2 py-1.5 bg-earth-50 rounded-lg">
                                <div className="flex items-center gap-2">
                                  <span>{o.status === 'cancelled' ? '❌' : o.status === 'delivered' ? '📦' : o.status === 'pending' ? '🛒' : '✅'}</span>
                                  <span className="font-semibold text-earth-900">{o.order_number}</span>
                                  <span className="text-earth-400">{new Date(o.order_date).toLocaleDateString()}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-earth-900">${Number(o.total).toFixed(2)}</span>
                                  <span
                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase"
                                    style={{
                                      background: `${STATUS_COLORS[o.status] || '#9e9e9e'}15`,
                                      color: STATUS_COLORS[o.status] || '#9e9e9e',
                                    }}
                                  >
                                    {o.status}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
