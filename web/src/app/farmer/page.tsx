'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';
import { Card, SectionTitle } from '@/components/ui';

const EMOJI: Record<string, string> = {
  Vegetables: '🥬', Fruits: '🍎', Herbs: '🌿', Greens: '🥗', Berries: '🫐',
  Roots: '🥕', Dairy: '🧀', Eggs: '🥚', Meat: '🥩', Honey: '🍯',
};

const STATUS_COLORS: Record<string, string> = {
  available: '#2e7d32', partial: '#e65100', reserved: '#1565c0', sold: '#9e9e9e',
  pending: '#e65100', confirmed: '#2e7d32', in_transit: '#1565c0', delivered: '#4a7c28', cancelled: '#d32f2f',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const DELIVERY_STATUS_COLORS: Record<string, string> = {
  scheduled: '#1565c0',
  in_transit: '#e6a700',
  completed: '#2e7d32',
  failed: '#d32f2f',
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  in_transit: 'In Transit',
  completed: 'Completed',
  failed: 'Failed',
};

const CATEGORIES = ['Vegetables', 'Fruits', 'Herbs', 'Greens', 'Berries', 'Roots', 'Dairy', 'Eggs', 'Meat', 'Honey'];
const UNITS = ['lb', 'bunch', 'pint', 'dozen', 'each', 'bag', 'quart', 'gallon', 'oz'];
const INVENTORY_STATUSES = ['available', 'partial', 'reserved', 'sold'];

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

export default function FarmerDashboard() {
  const { user, farm, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('inventory');
  const [inventory, setInventory] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [markets, setMarkets] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Add listing form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({
    product_name: '',
    category: 'Vegetables',
    quantity: '',
    unit: 'lb',
    price: '',
    harvest_date: '',
  });
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [addImageFile, setAddImageFile] = useState<File | null>(null);
  const [addImagePreview, setAddImagePreview] = useState<string | null>(null);

  // Edit state: which item id is being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ remaining: '', price: '', status: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editImageFile, setEditImageFile] = useState<File | null>(null);
  const [editImagePreview, setEditImagePreview] = useState<string | null>(null);

  // Expandable detail state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Market management state
  const [editingMarketId, setEditingMarketId] = useState<string | null>(null);
  const [marketEditForm, setMarketEditForm] = useState({ priority: '', notification_delay_min: '' });
  const [marketEditLoading, setMarketEditLoading] = useState(false);
  const [showAddMarket, setShowAddMarket] = useState(false);
  const [allMarkets, setAllMarkets] = useState<any[]>([]);
  const [allMarketsLoading, setAllMarketsLoading] = useState(false);
  const [addMarketLoading, setAddMarketLoading] = useState<string | null>(null);

  // Products cache for reuse
  const [products, setProducts] = useState<any[]>([]);

  const loadData = useCallback(async () => {
    if (!farm) return;
    setLoading(true);
    try {
      const [inv, ord, mkts, stats, prods, msgs, dlvs] = await Promise.all([
        api.getFarmInventory(farm.id),
        api.getFarmOrders(farm.id),
        api.getFarmMarkets(farm.id),
        api.getFarmAnalytics(farm.id),
        api.getProducts({ farm_id: farm.id }),
        api.getFarmMessages(farm.id),
        api.getDeliveries({ farm_id: farm.id }),
      ]);
      setInventory(inv.inventory || []);
      setOrders(ord.orders || []);
      setMarkets(mkts.markets || []);
      setAnalytics(stats);
      setProducts(prods.products || []);
      setMessages(msgs.messages || []);
      setDeliveries(dlvs.deliveries || []);
    } catch (err) {
      console.error('Failed to load farm data', err);
    } finally {
      setLoading(false);
    }
  }, [farm]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push('/login');
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (farm) loadData();
  }, [farm, loadData]);

  if (isLoading || loading) {
    return (
      <div className="min-h-screen bg-earth-15">
        <Header />
        <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-12 text-center text-earth-400">
          Loading...
        </div>
      </div>
    );
  }

  if (!farm) {
    return (
      <div className="min-h-screen bg-earth-15">
        <Header />
        <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-12 text-center">
          <p className="text-earth-500">No farm associated with this account.</p>
        </div>
      </div>
    );
  }

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
  const activeItems = inventory.filter((i: any) => i.status !== 'sold');
  const todayOrders = orders.filter(
    (o: any) => new Date(o.order_date).toDateString() === new Date().toDateString(),
  );
  const todayRevenue = todayOrders.reduce((s: number, o: any) => s + Number(o.total), 0);

  const handleStatusChange = async (orderId: string, status: string) => {
    try {
      await api.updateOrderStatus(orderId, status);
      loadData();
    } catch (err) {
      console.error('Failed to update order', err);
    }
  };

  // ── Add Listing handlers ──────────────────────────────────────

  const resetAddForm = () => {
    setAddForm({ product_name: '', category: 'Vegetables', quantity: '', unit: 'lb', price: '', harvest_date: '' });
    setAddError('');
  };

  const handleAddListing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!farm) return;
    setAddLoading(true);
    setAddError('');

    try {
      // Check if a product with this name already exists for this farm
      let productId: string | null = null;
      const existing = products.find(
        (p: any) => p.name.toLowerCase() === addForm.product_name.trim().toLowerCase() && p.farm_id === farm.id,
      );

      if (existing) {
        productId = existing.id;
      } else {
        // Create the product first
        const newProduct = await api.createProduct({
          farm_id: farm.id,
          name: addForm.product_name.trim(),
          category: addForm.category,
          unit: addForm.unit,
          default_price: parseFloat(addForm.price) || undefined,
        });
        productId = newProduct.id;
      }

      // Upload image if selected
      let image_url: string | undefined;
      if (addImageFile) {
        const uploaded = await api.uploadImage(addImageFile);
        image_url = uploaded.url;
      }

      // Create inventory listing
      await api.createInventory({
        farm_id: farm.id,
        product_id: productId,
        quantity: parseFloat(addForm.quantity),
        price: parseFloat(addForm.price),
        harvest_date: addForm.harvest_date || undefined,
        image_url,
      });

      resetAddForm();
      setAddImageFile(null);
      setAddImagePreview(null);
      setShowAddForm(false);
      loadData();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add listing');
    } finally {
      setAddLoading(false);
    }
  };

  // ── Edit Inventory handlers ───────────────────────────────────

  const startEdit = (item: any) => {
    setEditingId(item.id);
    setEditForm({
      remaining: String(item.remaining),
      price: String(item.price),
      status: item.status,
    });
    setEditImageFile(null);
    setEditImagePreview(item.image_url || null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ remaining: '', price: '', status: '' });
    setEditImageFile(null);
    setEditImagePreview(null);
  };

  const handleEditSave = async (itemId: string) => {
    setEditLoading(true);
    try {
      let image_url: string | undefined;
      if (editImageFile) {
        const uploaded = await api.uploadImage(editImageFile);
        image_url = uploaded.url;
      }
      await api.updateInventory(itemId, {
        remaining: parseFloat(editForm.remaining),
        price: parseFloat(editForm.price),
        status: editForm.status,
        ...(image_url ? { image_url } : {}),
      });
      cancelEdit();
      loadData();
    } catch (err) {
      console.error('Failed to update inventory', err);
    } finally {
      setEditLoading(false);
    }
  };

  const handleMarkSold = async (itemId: string) => {
    try {
      await api.updateInventory(itemId, { status: 'sold', remaining: 0 });
      loadData();
    } catch (err) {
      console.error('Failed to mark as sold', err);
    }
  };

  const handleDelete = async (itemId: string) => {
    if (!confirm('Remove this listing? This cannot be undone.')) return;
    try {
      await api.deleteInventory(itemId);
      loadData();
    } catch (err) {
      console.error('Failed to delete inventory', err);
    }
  };

  // ── Expand/collapse order detail ─────────────────────────────
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

  // ── Market management ────────────────────────────────────────
  const startMarketEdit = (m: any) => {
    setEditingMarketId(m.id);
    setMarketEditForm({
      priority: String(m.priority),
      notification_delay_min: String(m.notification_delay_min),
    });
  };

  const handleMarketEditSave = async (relId: string) => {
    setMarketEditLoading(true);
    try {
      await api.updateRelationship(relId, {
        priority: parseInt(marketEditForm.priority),
        notification_delay_min: parseInt(marketEditForm.notification_delay_min),
      });
      setEditingMarketId(null);
      loadData();
    } catch (err) {
      console.error('Failed to update market priority', err);
    } finally {
      setMarketEditLoading(false);
    }
  };

  const handleToggleMarketActive = async (relId: string, currentActive: boolean) => {
    try {
      await api.updateRelationship(relId, { active: !currentActive });
      loadData();
    } catch (err) {
      console.error('Failed to toggle market', err);
    }
  };

  const handleDiscoverMarkets = async () => {
    setShowAddMarket(true);
    setAllMarketsLoading(true);
    try {
      const data = await api.getAllMarkets();
      setAllMarkets(data.markets || []);
    } catch (err) {
      console.error('Failed to load markets', err);
    } finally {
      setAllMarketsLoading(false);
    }
  };

  const handleAddMarket = async (marketId: string) => {
    if (!farm) return;
    setAddMarketLoading(marketId);
    try {
      const nextPriority = markets.length > 0
        ? Math.max(...markets.map((m: any) => m.priority)) + 1
        : 1;
      await api.createRelationship({
        farm_id: farm.id,
        market_id: marketId,
        priority: nextPriority,
        notification_delay_min: nextPriority === 1 ? 0 : (nextPriority - 1) * 15,
      });
      loadData();
      // Refresh the all-markets list
      const data = await api.getAllMarkets();
      setAllMarkets(data.markets || []);
    } catch (err) {
      console.error('Failed to add market', err);
    } finally {
      setAddMarketLoading(null);
    }
  };

  // ── Shared input styles ───────────────────────────────────────

  const inputClass =
    'w-full px-3 py-2 text-sm border border-earth-200 rounded-xl bg-white text-earth-900 focus:outline-none focus:ring-2 focus:ring-farm-400 focus:border-farm-400 transition-colors';
  const selectClass =
    'w-full px-3 py-2 text-sm border border-earth-200 rounded-xl bg-white text-earth-900 focus:outline-none focus:ring-2 focus:ring-farm-400 focus:border-farm-400 transition-colors appearance-none';
  const btnPrimary =
    'py-2 px-4 bg-farm-600 text-white rounded-xl text-xs font-semibold cursor-pointer border-none hover:bg-farm-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSecondary =
    'py-2 px-4 bg-earth-100 text-earth-600 rounded-xl text-xs font-semibold cursor-pointer border-none hover:bg-earth-200 transition-colors';

  return (
    <div className="min-h-screen bg-earth-15">
      <Header />
      <ChatWidget />
      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-4 sm:py-5" style={{ animation: 'fadeIn 0.25s ease' }}>
        <h2 className="m-0 font-display font-extrabold text-earth-900 text-lg sm:text-xl mb-3 sm:mb-4">
          🌱 {farm.name}
        </h2>

        {/* Stats row — clickable navigation */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-2.5 mb-4 sm:mb-5">
          {([
            { id: 'analytics', label: "Today's Revenue", value: `$${todayRevenue.toFixed(0)}` },
            { id: 'inventory', label: 'Active Listings', value: activeItems.length },
            { id: 'orders', label: 'Orders', value: orders.filter((o: any) => ['pending', 'confirmed', 'in_transit'].includes(o.status)).length },
            { id: 'deliveries', label: 'Deliveries', value: deliveries.filter((d: any) => d.status !== 'completed' && d.status !== 'failed').length },
            { id: 'messages', label: 'Messages', value: messages.length },
            { id: 'markets', label: 'Markets', value: markets.length },
          ] as const).map((s) => (
            <Card
              key={s.id}
              onClick={() => setTab(s.id)}
              style={{ padding: '12px 16px', cursor: 'pointer', transition: 'all 0.15s' }}
              className={tab === s.id ? '!border-farm-500 !bg-farm-50' : 'hover:border-earth-200'}
            >
              <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-[3px]">
                {s.label}
              </div>
              <div className={`text-xl font-extrabold font-display ${tab === s.id ? 'text-farm-700' : 'text-earth-900'}`}>{s.value}</div>
            </Card>
          ))}
        </div>

        {/* ════════════════ Inventory tab ════════════════ */}
        {tab === 'inventory' && (
          <div>
            {/* Add Listing button */}
            <div className="flex justify-between items-center mb-3">
              <SectionTitle>Inventory Listings</SectionTitle>
              <button
                onClick={() => { setShowAddForm(!showAddForm); resetAddForm(); }}
                className={showAddForm ? btnSecondary : btnPrimary}
              >
                {showAddForm ? 'Cancel' : '+ Add Listing'}
              </button>
            </div>

            {/* Add Listing inline form */}
            {showAddForm && (
              <Card style={{ padding: 20, marginBottom: 12 }}>
                <form onSubmit={handleAddListing}>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Product Name
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Cherokee Purple Tomatoes"
                        className={inputClass}
                        value={addForm.product_name}
                        onChange={(e) => setAddForm({ ...addForm, product_name: e.target.value })}
                        list="product-suggestions"
                      />
                      {/* Suggest existing products */}
                      <datalist id="product-suggestions">
                        {products.map((p: any) => (
                          <option key={p.id} value={p.name} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Category
                      </label>
                      <select
                        className={selectClass}
                        value={addForm.category}
                        onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>{EMOJI[c] || ''} {c}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Unit
                      </label>
                      <select
                        className={selectClass}
                        value={addForm.unit}
                        onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })}
                      >
                        {UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Quantity
                      </label>
                      <input
                        type="number"
                        required
                        min="0.01"
                        step="0.01"
                        placeholder="0"
                        className={inputClass}
                        value={addForm.quantity}
                        onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Price per unit ($)
                      </label>
                      <input
                        type="number"
                        required
                        min="0.01"
                        step="0.01"
                        placeholder="0.00"
                        className={inputClass}
                        value={addForm.price}
                        onChange={(e) => setAddForm({ ...addForm, price: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                        Harvest Date
                      </label>
                      <input
                        type="date"
                        className={inputClass}
                        value={addForm.harvest_date}
                        onChange={(e) => setAddForm({ ...addForm, harvest_date: e.target.value })}
                      />
                    </div>
                  </div>
                  {/* Photo upload */}
                  <div className="mb-3">
                    <label className="block text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                      Photo (optional)
                    </label>
                    {addImagePreview && (
                      <div className="relative mb-2 rounded-lg overflow-hidden" style={{ maxHeight: 140 }}>
                        <img src={addImagePreview} alt="Preview" className="w-full object-cover rounded-lg" style={{ maxHeight: 140 }} />
                        <button
                          type="button"
                          onClick={() => { setAddImageFile(null); setAddImagePreview(null); }}
                          className="absolute top-1 right-1 w-6 h-6 bg-black/50 text-white rounded-full text-xs border-none cursor-pointer flex items-center justify-center"
                        >✕</button>
                      </div>
                    )}
                    <label className="flex items-center justify-center gap-2 py-2.5 px-3 bg-earth-50 rounded-lg cursor-pointer hover:bg-earth-100 transition-colors border border-dashed border-earth-200">
                      <span className="text-xs text-earth-600 font-semibold">📷 {addImagePreview ? 'Change' : 'Add'} Photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setAddImageFile(file);
                            setAddImagePreview(URL.createObjectURL(file));
                          }
                        }}
                      />
                    </label>
                  </div>
                  {addError && (
                    <div className="text-red-600 text-xs mb-2">{addError}</div>
                  )}
                  <button
                    type="submit"
                    disabled={addLoading}
                    className={btnPrimary + ' w-full'}
                  >
                    {addLoading ? 'Adding...' : 'Add Listing'}
                  </button>
                </form>
              </Card>
            )}

            {/* Inventory grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {inventory.length === 0 ? (
                <Card style={{ padding: 20, gridColumn: '1/-1' }}>
                  <p className="text-earth-400 text-sm text-center">
                    No inventory listings yet. Click "Add Listing" above or use the Live Chat!
                  </p>
                </Card>
              ) : (
                inventory.map((item: any) => (
                  <Card key={item.id} style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Item image */}
                    {item.image_url && (
                      <div className="w-full h-32 sm:h-40 bg-earth-50">
                        <img
                          src={item.image_url}
                          alt={item.product_name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <div style={{ padding: 16 }}>
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="mr-1.5">{EMOJI[item.category] || '📦'}</span>
                        <span className="font-bold text-sm text-earth-900">{item.product_name}</span>
                      </div>
                      <span
                        className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase"
                        style={{
                          background: `${STATUS_COLORS[item.status]}15`,
                          color: STATUS_COLORS[item.status],
                        }}
                      >
                        {item.status}
                      </span>
                    </div>
                    <div className="text-xs text-earth-500 mb-2">
                      {item.category} · {item.unit}
                    </div>

                    {/* Show edit form or normal view */}
                    {editingId === item.id ? (
                      <div className="border-t border-earth-100 pt-3 mt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                          <div>
                            <label className="block text-[10px] text-earth-500 font-semibold uppercase mb-0.5">
                              Remaining
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              className={inputClass}
                              value={editForm.remaining}
                              onChange={(e) => setEditForm({ ...editForm, remaining: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-earth-500 font-semibold uppercase mb-0.5">
                              Price ($)
                            </label>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              className={inputClass}
                              value={editForm.price}
                              onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-earth-500 font-semibold uppercase mb-0.5">
                              Status
                            </label>
                            <select
                              className={selectClass}
                              value={editForm.status}
                              onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                            >
                              {INVENTORY_STATUSES.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {/* Image upload */}
                        <div className="mb-2">
                          <label className="block text-[10px] text-earth-500 font-semibold uppercase mb-1">Photo</label>
                          {editImagePreview && (
                            <div className="relative mb-2 rounded-lg overflow-hidden" style={{ maxHeight: 120 }}>
                              <img src={editImagePreview} alt="Preview" className="w-full h-full object-cover rounded-lg" style={{ maxHeight: 120 }} />
                              <button
                                onClick={() => { setEditImageFile(null); setEditImagePreview(null); }}
                                className="absolute top-1 right-1 w-6 h-6 bg-black/50 text-white rounded-full text-xs border-none cursor-pointer flex items-center justify-center"
                              >✕</button>
                            </div>
                          )}
                          <label className="flex items-center gap-2 py-2 px-3 bg-earth-50 rounded-lg cursor-pointer hover:bg-earth-100 transition-colors">
                            <span className="text-xs text-earth-600 font-semibold">📷 {editImagePreview ? 'Change' : 'Add'} Photo</span>
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  setEditImageFile(file);
                                  setEditImagePreview(URL.createObjectURL(file));
                                }
                              }}
                            />
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditSave(item.id)}
                            disabled={editLoading}
                            className={btnPrimary + ' flex-1'}
                          >
                            {editLoading ? 'Saving...' : 'Save'}
                          </button>
                          <button onClick={cancelEdit} className={btnSecondary}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Progress bar */}
                        <div className="mb-2">
                          <div className="flex justify-between text-[11px] mb-1">
                            <span className="text-earth-500">
                              {item.remaining}/{item.quantity} {item.unit} remaining
                            </span>
                            <span className="font-bold text-farm-700">
                              ${Number(item.price).toFixed(2)}/{item.unit}
                            </span>
                          </div>
                          <div className="h-1.5 bg-earth-100 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${(item.remaining / item.quantity) * 100}%`,
                                background:
                                  item.remaining / item.quantity > 0.5
                                    ? '#4a7c28'
                                    : item.remaining / item.quantity > 0.2
                                    ? '#e65100'
                                    : '#d32f2f',
                              }}
                            />
                          </div>
                        </div>
                        {item.harvest_date && (
                          <div className="text-[10px] text-earth-400 mb-2">
                            Harvested {new Date(item.harvest_date).toLocaleDateString()}
                          </div>
                        )}
                        {/* Action buttons */}
                        <div className="flex gap-2 pt-2 border-t border-earth-100">
                          <button
                            onClick={() => startEdit(item)}
                            className="flex-1 py-1.5 bg-farm-50 text-farm-700 rounded-lg text-[11px] font-semibold cursor-pointer border-none hover:bg-farm-100 transition-colors"
                          >
                            Edit
                          </button>
                          {item.status !== 'sold' && (
                            <button
                              onClick={() => handleMarkSold(item.id)}
                              className="py-1.5 px-3 bg-earth-100 text-earth-600 rounded-lg text-[11px] font-semibold cursor-pointer border-none hover:bg-earth-200 transition-colors"
                            >
                              Mark Sold
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="py-1.5 px-3 bg-red-50 text-red-500 rounded-lg text-[11px] font-semibold cursor-pointer border-none hover:bg-red-100 transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                    </div>
                  </Card>
                ))
              )}
            </div>
          </div>
        )}

        {/* ════════════════ Orders tab ════════════════ */}
        {tab === 'orders' && (
          <div>
            <h3 className="font-display font-bold text-earth-900 text-[15px] mb-3">Orders</h3>
            {orders.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">No orders yet.</p>
              </Card>
            ) : (
              ordersByStatus.map((group) => (
                <div key={group.status} className="mb-5">
                  {/* Status section heading */}
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full inline-block"
                      style={{ background: STATUS_COLORS[group.status] }}
                    />
                    <span className="text-xs font-bold text-earth-700 uppercase tracking-wide">
                      {group.label}
                    </span>
                    <span className="text-xs text-earth-400">({group.orders.length})</span>
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
                              🏪 {order.market_name} · {new Date(order.order_date).toLocaleDateString()}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-extrabold text-farm-700 font-display">
                              ${Number(order.total).toFixed(2)}
                            </div>
                          </div>
                        </div>

                        {/* Expanded detail */}
                        {expandedId === order.id && (
                          <div className="mt-3 pt-3 border-t border-earth-100" onClick={(e) => e.stopPropagation()}>
                            {detailLoading ? (
                              <div className="text-xs text-earth-400 py-2">Loading details...</div>
                            ) : expandedDetail ? (
                              <div className="space-y-2.5">
                                {/* Line items */}
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
                                {/* Order meta */}
                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                  {expandedDetail.market_location && (
                                    <div>
                                      <span className="text-earth-400">Location: </span>
                                      <span className="text-earth-700 font-medium">{expandedDetail.market_location}</span>
                                    </div>
                                  )}
                                  {expandedDetail.delivery_pref && (
                                    <div>
                                      <span className="text-earth-400">Delivery: </span>
                                      <span className="text-earth-700 font-medium capitalize">{expandedDetail.delivery_pref}</span>
                                    </div>
                                  )}
                                  <div>
                                    <span className="text-earth-400">Created: </span>
                                    <span className="text-earth-700 font-medium">{new Date(expandedDetail.created_at).toLocaleString()}</span>
                                  </div>
                                  {expandedDetail.updated_at && expandedDetail.updated_at !== expandedDetail.created_at && (
                                    <div>
                                      <span className="text-earth-400">Updated: </span>
                                      <span className="text-earth-700 font-medium">{new Date(expandedDetail.updated_at).toLocaleString()}</span>
                                    </div>
                                  )}
                                </div>
                                {expandedDetail.notes && (
                                  <div className="text-xs text-earth-600 bg-earth-50 rounded-lg px-3 py-2">
                                    <span className="text-earth-400 font-semibold">Notes: </span>{expandedDetail.notes}
                                  </div>
                                )}
                              </div>
                            ) : null}

                            {/* Action buttons for status transitions */}
                            {order.status === 'pending' && (
                              <div className="flex gap-2 mt-3">
                                <button
                                  onClick={() => handleStatusChange(order.id, 'confirmed')}
                                  className="flex-1 py-2 bg-farm-50 text-farm-700 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-farm-100 transition-colors"
                                >
                                  ✅ Confirm
                                </button>
                                <button
                                  onClick={() => handleStatusChange(order.id, 'cancelled')}
                                  className="py-2 px-4 bg-red-50 text-red-600 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-red-100 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                            {order.status === 'confirmed' && (
                              <div className="mt-3">
                                <button
                                  onClick={() => handleStatusChange(order.id, 'in_transit')}
                                  className="w-full py-2 bg-blue-50 text-blue-700 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-blue-100 transition-colors"
                                >
                                  🚚 Mark In Transit
                                </button>
                              </div>
                            )}
                            {order.status === 'in_transit' && (
                              <div className="mt-3">
                                <button
                                  onClick={() => handleStatusChange(order.id, 'delivered')}
                                  className="w-full py-2 bg-farm-50 text-farm-700 rounded-lg text-xs font-semibold cursor-pointer border-none hover:bg-farm-100 transition-colors"
                                >
                                  📦 Mark Delivered
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ════════════════ Messages tab ════════════════ */}
        {tab === 'messages' && (
          <div className="space-y-2">
            <SectionTitle>Activity Feed</SectionTitle>
            {messages.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">
                  No messages yet. Activity from orders and notifications will appear here.
                </p>
              </Card>
            ) : (
              messages.map((msg: any) => (
                <Card
                  key={msg.id}
                  style={{ padding: 14, cursor: msg.type === 'order' ? 'pointer' : 'default' }}
                  onClick={() => msg.type === 'order' && toggleExpand(msg.id)}
                >
                  <div className="flex items-start gap-3">
                    <div className="text-lg mt-0.5">
                      {msg.type === 'order'
                        ? msg.status === 'cancelled' ? '❌'
                        : msg.status === 'confirmed' ? '✅'
                        : msg.status === 'in_transit' ? '🚚'
                        : msg.status === 'delivered' ? '📦'
                        : '🛒'
                        : msg.notification_type === 'new_inventory' ? '🆕'
                        : msg.notification_type === 'price_change' ? '💲'
                        : '🔔'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start gap-2">
                        <div className="font-bold text-sm text-earth-900 leading-tight flex items-center gap-1.5">
                          {msg.title}
                          {msg.type === 'order' && (
                            <span className="text-earth-300 text-xs">{expandedId === msg.id ? '▾' : '▸'}</span>
                          )}
                        </div>
                        {msg.status && (
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
                      <div className="text-xs text-earth-500 mt-0.5">
                        {msg.description}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-[10px] text-earth-400">
                          From: <span className="font-semibold text-earth-600">{msg.from}</span>
                        </span>
                        <span className="text-[10px] text-earth-400">
                          {timeAgo(msg.timestamp)}
                        </span>
                        {msg.amount && (
                          <span className="text-[10px] font-bold text-farm-700">
                            ${Number(msg.amount).toFixed(2)}
                          </span>
                        )}
                      </div>

                      {/* Expanded order detail */}
                      {msg.type === 'order' && expandedId === msg.id && (
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
                                {expandedDetail.market_location && (
                                  <div>
                                    <span className="text-earth-400">Location: </span>
                                    <span className="text-earth-700 font-medium">{expandedDetail.market_location}</span>
                                  </div>
                                )}
                                {expandedDetail.delivery_pref && (
                                  <div>
                                    <span className="text-earth-400">Delivery: </span>
                                    <span className="text-earth-700 font-medium capitalize">{expandedDetail.delivery_pref}</span>
                                  </div>
                                )}
                                <div>
                                  <span className="text-earth-400">Created: </span>
                                  <span className="text-earth-700 font-medium">{new Date(expandedDetail.created_at).toLocaleString()}</span>
                                </div>
                                {expandedDetail.updated_at && expandedDetail.updated_at !== expandedDetail.created_at && (
                                  <div>
                                    <span className="text-earth-400">Updated: </span>
                                    <span className="text-earth-700 font-medium">{new Date(expandedDetail.updated_at).toLocaleString()}</span>
                                  </div>
                                )}
                              </div>
                              {expandedDetail.notes && (
                                <div className="text-xs text-earth-600 bg-earth-50 rounded-lg px-3 py-2">
                                  <span className="text-earth-400 font-semibold">Notes: </span>{expandedDetail.notes}
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {/* ════════════════ Markets tab ════════════════ */}
        {tab === 'markets' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <SectionTitle>Connected Markets</SectionTitle>
              <button
                onClick={showAddMarket ? () => setShowAddMarket(false) : handleDiscoverMarkets}
                className={showAddMarket ? btnSecondary : btnPrimary}
              >
                {showAddMarket ? 'Close' : '+ Add Market'}
              </button>
            </div>

            {/* Discover Markets panel */}
            {showAddMarket && (
              <Card style={{ padding: 20 }}>
                <div className="font-bold text-sm text-earth-900 mb-3">Available Markets</div>
                {allMarketsLoading ? (
                  <div className="text-xs text-earth-400 py-2">Loading markets...</div>
                ) : (
                  <div className="space-y-2">
                    {allMarkets.filter((am: any) => !markets.some((cm: any) => cm.id === am.id)).length === 0 ? (
                      <p className="text-earth-400 text-xs text-center py-2">You're connected to all available markets!</p>
                    ) : (
                      allMarkets
                        .filter((am: any) => !markets.some((cm: any) => cm.id === am.id))
                        .map((am: any) => (
                          <div key={am.id} className="flex justify-between items-center p-3 bg-earth-50 rounded-lg">
                            <div>
                              <div className="font-bold text-sm text-earth-900">🏪 {am.name}</div>
                              <div className="text-[11px] text-earth-500">{am.type} · {am.location}</div>
                            </div>
                            <button
                              onClick={() => handleAddMarket(am.id)}
                              disabled={addMarketLoading === am.id}
                              className={btnPrimary}
                            >
                              {addMarketLoading === am.id ? 'Adding...' : 'Connect'}
                            </button>
                          </div>
                        ))
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* Connected markets with inline editing + stats */}
            {markets.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">No connected markets yet. Click "+ Add Market" to find markets near you.</p>
              </Card>
            ) : (
              markets.map((m: any) => (
                <Card key={m.id} style={{ padding: 16 }}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-sm text-earth-900 flex items-center gap-2">
                        🏪 {m.name}
                        <span
                          className="text-[10px] font-bold px-2 py-0.5 rounded-full cursor-pointer"
                          style={{
                            background: m.active ? '#2e7d3215' : '#9e9e9e15',
                            color: m.active ? '#2e7d32' : '#9e9e9e',
                          }}
                          onClick={() => handleToggleMarketActive(m.rel_id, m.active)}
                          title={m.active ? 'Click to deactivate' : 'Click to activate'}
                        >
                          {m.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <div className="text-xs text-earth-500 mt-0.5">
                        {m.type} · {m.location}
                      </div>
                      {/* Stats row */}
                      <div className="flex gap-4 mt-2.5">
                        {m.pending_orders > 0 && (
                          <div className="text-[11px]">
                            <span className="text-earth-400">Pending: </span>
                            <span className="font-bold text-orange-600">{m.pending_orders} orders (${Number(m.pending_total).toFixed(0)})</span>
                          </div>
                        )}
                        {m.history_orders > 0 && (
                          <div className="text-[11px]">
                            <span className="text-earth-400">History: </span>
                            <span className="font-bold text-earth-700">{m.history_orders} orders (${Number(m.history_total).toFixed(0)})</span>
                          </div>
                        )}
                        {!m.pending_orders && !m.history_orders && (
                          <div className="text-[11px] text-earth-400">No orders yet</div>
                        )}
                      </div>
                    </div>
                    {editingMarketId === m.id ? (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <div>
                          <label className="block text-[10px] text-earth-400 font-semibold uppercase mb-0.5">Priority</label>
                          <input
                            type="number"
                            min="1"
                            className={inputClass + ' !w-16 text-center'}
                            value={marketEditForm.priority}
                            onChange={(e) => setMarketEditForm({ ...marketEditForm, priority: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-earth-400 font-semibold uppercase mb-0.5">Delay (min)</label>
                          <input
                            type="number"
                            min="0"
                            step="5"
                            className={inputClass + ' !w-20 text-center'}
                            value={marketEditForm.notification_delay_min}
                            onChange={(e) => setMarketEditForm({ ...marketEditForm, notification_delay_min: e.target.value })}
                          />
                        </div>
                        <div className="flex flex-col gap-1 mt-3">
                          <button
                            onClick={() => handleMarketEditSave(m.rel_id)}
                            disabled={marketEditLoading}
                            className="py-1 px-3 bg-farm-600 text-white rounded-lg text-[10px] font-semibold cursor-pointer border-none hover:bg-farm-700 transition-colors"
                          >
                            {marketEditLoading ? '...' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingMarketId(null)}
                            className="py-1 px-3 bg-earth-100 text-earth-500 rounded-lg text-[10px] font-semibold cursor-pointer border-none"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-right cursor-pointer" onClick={() => startMarketEdit(m)} title="Click to edit priority">
                        <div className="text-[10px] text-earth-400 uppercase font-semibold">Priority</div>
                        <div className="text-xl font-extrabold text-farm-700 font-display">
                          #{m.priority}
                        </div>
                        <div className="text-[10px] text-earth-400">
                          {m.notification_delay_min === 0
                            ? 'Instant notify'
                            : `${m.notification_delay_min}min delay`}
                        </div>
                        <div className="text-[9px] text-farm-500 mt-0.5">click to edit</div>
                      </div>
                    )}
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {/* ════════════════ Deliveries tab ════════════════ */}
        {tab === 'deliveries' && (
          <div>
            <h3 className="font-display font-bold text-earth-900 text-[15px] mb-3">Deliveries</h3>
            {deliveries.length === 0 ? (
              <Card style={{ padding: 20 }}>
                <p className="text-earth-400 text-sm text-center">No deliveries yet.</p>
              </Card>
            ) : (
              (['scheduled', 'in_transit', 'completed', 'failed'] as const)
                .map((status) => ({
                  status,
                  label: DELIVERY_STATUS_LABELS[status],
                  items: deliveries.filter((d: any) => d.status === status),
                }))
                .filter((g) => g.items.length > 0)
                .map((group) => (
                  <div key={group.status} className="mb-5">
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ background: DELIVERY_STATUS_COLORS[group.status] }}
                      />
                      <span className="text-xs font-bold text-earth-700 uppercase tracking-wide">
                        {group.label}
                      </span>
                      <span className="text-xs text-earth-400">({group.items.length})</span>
                    </div>
                    <div className="space-y-2">
                      {group.items.map((d: any) => (
                        <Card key={d.id} style={{ padding: 16 }}>
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-bold text-sm text-earth-900 mb-0.5 flex items-center gap-2 flex-wrap">
                                {d.order_number}
                                <span
                                  className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
                                  style={{ background: DELIVERY_STATUS_COLORS[d.status] || '#9e9e9e' }}
                                >
                                  {DELIVERY_STATUS_LABELS[d.status] || d.status}
                                </span>
                              </div>
                              <div className="text-xs text-earth-500 mt-1 space-y-0.5">
                                <div>
                                  <span className="inline-block w-4 text-center mr-1">🏪</span>
                                  {d.market_name}
                                </div>
                                <div>
                                  <span className="inline-block w-4 text-center mr-1">📦</span>
                                  {d.type === 'pickup' ? 'Pickup' : 'Delivery'}
                                </div>
                                <div>
                                  <span className="inline-block w-4 text-center mr-1">📅</span>
                                  {d.scheduled_at
                                    ? new Date(d.scheduled_at).toLocaleDateString(undefined, {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                        hour: 'numeric',
                                        minute: '2-digit',
                                      })
                                    : 'Not scheduled'}
                                </div>
                                {d.completed_at && (
                                  <div>
                                    <span className="inline-block w-4 text-center mr-1">✅</span>
                                    Completed {new Date(d.completed_at).toLocaleDateString(undefined, {
                                      weekday: 'short',
                                      month: 'short',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: '2-digit',
                                    })}
                                  </div>
                                )}
                                {d.notes && (
                                  <div className="text-earth-400 italic mt-1">
                                    <span className="inline-block w-4 text-center mr-1">📝</span>
                                    {d.notes}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-extrabold text-farm-700 font-display">
                                ${Number(d.total).toFixed(2)}
                              </div>
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}

        {/* ════════════════ Analytics tab ════════════════ */}
        {tab === 'analytics' && analytics && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card style={{ padding: 20 }}>
              <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                Total Revenue
              </div>
              <div className="text-2xl font-extrabold text-farm-700 font-display">
                ${Number(analytics.revenue).toFixed(2)}
              </div>
            </Card>
            <Card style={{ padding: 20 }}>
              <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                Total Orders
              </div>
              <div className="text-2xl font-extrabold text-earth-900 font-display">
                {analytics.total_orders}
              </div>
            </Card>
            <Card style={{ padding: 20 }}>
              <div className="text-[10px] text-earth-500 font-semibold uppercase tracking-wide mb-1">
                Active Listings
              </div>
              <div className="text-2xl font-extrabold text-earth-900 font-display">
                {analytics.active_listings}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
