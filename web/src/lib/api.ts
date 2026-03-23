export interface ConversationSummary {
  id: string;
  phone_number: string;
  context: string;
  last_message_at: string;
  created_at: string;
  user_name: string;
  user_role: string;
  last_message: string | null;
  last_message_direction: string | null;
  message_count: number;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  source: string;
  ai_metadata: unknown;
  created_at: string;
}

const API_BASE = '/api';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('farmlink_token');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `API error ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  signup: (data: {
    name: string; email: string; phone: string; role: 'farmer' | 'market';
    businessName: string; location: string;
    marketType?: string; deliveryPref?: string; specialty?: string;
  }) =>
    request<{ success: boolean; userId: string; farm: any; market: any }>(
      '/auth/signup',
      { method: 'POST', body: JSON.stringify(data) },
    ),
  checkPhone: (phone: string) =>
    request<{ exists: boolean; user: { name: string; role: string } | null }>(
      '/auth/check-phone',
      { method: 'POST', body: JSON.stringify({ phone }) },
    ),
  requestOtp: (phone: string) =>
    request<{ success: boolean }>('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  verifyOtp: (phone: string, code: string) =>
    request<{ success: boolean; token: string; user: any; farm: any; market: any }>(
      '/auth/otp/verify',
      { method: 'POST', body: JSON.stringify({ phone, code }) },
    ),
  getMe: () => request<{ user: any; farm: any; market: any }>('/auth/me'),

  // Farms
  getAllFarms: () => request<any>('/farms'),
  getFarm: (id: string) => request<any>(`/farms/${id}`),
  getFarmInventory: (id: string) => request<any>(`/farms/${id}/inventory`),
  getFarmOrders: (id: string) => request<any>(`/farms/${id}/orders`),
  getFarmMarkets: (id: string) => request<any>(`/farms/${id}/markets`),
  getFarmAnalytics: (id: string) => request<any>(`/farms/${id}/analytics`),
  getFarmMessages: (id: string) => request<any>(`/farms/${id}/messages`),

  // Markets
  getAllMarkets: () => request<any>('/markets'),
  getMarket: (id: string) => request<any>(`/markets/${id}`),
  getMarketAvailable: (id: string) => request<any>(`/markets/${id}/available`),
  getMarketOrders: (id: string) => request<any>(`/markets/${id}/orders`),
  getMarketMessages: (id: string) => request<any>(`/markets/${id}/messages`),
  getMarketFarms: (id: string) => request<any>(`/markets/${id}/farms`),

  // Inventory
  getInventory: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/inventory${qs}`);
  },
  createInventory: (data: any) =>
    request<any>('/inventory', { method: 'POST', body: JSON.stringify(data) }),
  updateInventory: (id: string, data: any) =>
    request<any>(`/inventory/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInventory: (id: string) =>
    request<any>(`/inventory/${id}`, { method: 'DELETE' }),

  // Products
  getProducts: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/products${qs}`);
  },
  createProduct: (data: any) =>
    request<any>('/products', { method: 'POST', body: JSON.stringify(data) }),

  // Orders
  getOrders: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/orders${qs}`);
  },
  getOrder: (id: string) => request<any>(`/orders/${id}`),
  createOrder: (data: any) =>
    request<any>('/orders', { method: 'POST', body: JSON.stringify(data) }),
  updateOrderStatus: (id: string, status: string) =>
    request<any>(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  // Analytics
  getRevenue: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/analytics/revenue${qs}`);
  },
  getTopProducts: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/analytics/top-products${qs}`);
  },
  getMarketBreakdown: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/analytics/market-breakdown${qs}`);
  },

  // Deliveries
  getDeliveries: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/deliveries${qs}`);
  },

  // Recurring orders
  getRecurringOrders: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/recurring-orders${qs}`);
  },
  createRecurringOrder: (data: any) =>
    request<any>('/recurring-orders', { method: 'POST', body: JSON.stringify(data) }),

  // Relationships
  createRelationship: (data: any) =>
    request<any>('/farm-market-rels', { method: 'POST', body: JSON.stringify(data) }),
  updateRelationship: (id: string, data: any) =>
    request<any>(`/farm-market-rels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // SMS / Chat
  getConversations: (role?: string) => {
    const qs = role ? `?role=${encodeURIComponent(role)}` : '';
    return request<{ conversations: ConversationSummary[] }>(`/sms/conversations${qs}`);
  },
  sendChat: (phone: string, message: string) =>
    request<{ response: string }>('/sms/chat', {
      method: 'POST',
      body: JSON.stringify({ phone, message }),
    }),
  getChatHistory: (phone: string) =>
    request<{ messages: ChatMessage[] }>(`/sms/history/${encodeURIComponent(phone)}`),

  // Profile
  getProfile: () => request<any>('/profile'),
  updateUser: (data: any) =>
    request<any>('/profile/user', { method: 'PUT', body: JSON.stringify(data) }),
  updateFarm: (data: any) =>
    request<any>('/profile/farm', { method: 'PUT', body: JSON.stringify(data) }),
  updateMarket: (data: any) =>
    request<any>('/profile/market', { method: 'PUT', body: JSON.stringify(data) }),

  // Uploads
  uploadImage: async (file: File): Promise<{ url: string; filename: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/uploads`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || `Upload failed ${res.status}`);
    }
    return res.json();
  },
};
