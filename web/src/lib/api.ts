const API_BASE = '/api';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('farmlink_token');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  // Only set a JSON content type when there is actually a body. Fastify
  // rejects bodyless requests (e.g. DELETE) that claim application/json
  // with a 400 FST_ERR_CTP_EMPTY_JSON_BODY, which broke all web deletes.
  if (options?.body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `API error ${res.status}`);
  }
  // Handle empty bodies (e.g. 204 No Content from DELETE) — res.json() would
  // throw on an empty body, which previously made successful deletes look failed.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  // Auth
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
    request<{ success: boolean; token: string; user: any }>(
      '/auth/otp/verify',
      { method: 'POST', body: JSON.stringify({ phone, code }) },
    ),
  getMe: () => request<{ user: any }>('/auth/me'),

  // Invite (by text)
  invite: (data: { phone: string; name?: string }) =>
    request<{ success: boolean; message: string }>('/invite', { method: 'POST', body: JSON.stringify(data) }),

  // Push
  registerPush: (token: string) =>
    request<{ success: boolean }>('/push/register', { method: 'POST', body: JSON.stringify({ token }) }),

  // Reminders
  getReminders: () => request<any>('/reminders'),
  createReminder: (data: { title: string; frequency: 'daily' | 'weekly'; schedule_days?: string; time: string }) =>
    request<any>('/reminders', { method: 'POST', body: JSON.stringify(data) }),
  updateReminder: (id: string, data: any) =>
    request<any>(`/reminders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteReminder: (id: string) =>
    request<any>(`/reminders/${id}`, { method: 'DELETE' }),

  // Profile
  getProfile: () => request<any>('/profile'),
  updateUser: (data: any) =>
    request<any>('/profile/user', { method: 'PUT', body: JSON.stringify(data) }),

  // Feedback
  getFeedback: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/feedback${qs}`);
  },
  getFeedbackItem: (id: string) => request<any>(`/feedback/${id}`),
  createFeedback: (data: { type: string; title: string; description: string }) =>
    request<any>('/feedback', { method: 'POST', body: JSON.stringify(data) }),
  updateFeedback: (id: string, data: any) =>
    request<any>(`/feedback/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFeedback: (id: string) =>
    request<any>(`/feedback/${id}`, { method: 'DELETE' }),

  // Admin
  getUtilization: () => request<any>('/admin/utilization'),
  getAdminUsers: () => request<any>('/admin/users'),
  sendBroadcast: (data: { audience: 'farmers' | 'markets' | 'all'; message: string }) =>
    request<any>('/admin/broadcast', { method: 'POST', body: JSON.stringify(data) }),
  getBroadcasts: () => request<any>('/admin/broadcasts'),
};
