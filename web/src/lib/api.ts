import type {
  Application,
  ApplicationInput,
  AuditEntry,
  Checkin,
  CheckinFormValues,
  CheckinSubmitInput,
  CheckinTokenView,
  CloseResult,
  CreateMarketInput,
  CreateProducerInput,
  DashboardCard,
  FeePlan,
  GenerateResult,
  Market,
  MarketDate,
  MarketDateStatusView,
  Membership,
  MembershipStatus,
  MembershipWithProducer,
  Producer,
  ProducerListItem,
  Providers,
  PublicMarket,
  ScheduleVersionInput,
  SkippedDate,
  SmsOutcome,
  SpecialDate,
  StaffUser,
  UpdateMarketDateInput,
  UpdateMarketInput,
  UpdateProducerInput,
} from './types';

const API_BASE = '/api';

/** Query string from an object; '' when nothing is defined. */
function qs(params?: Record<string, string | number | boolean | undefined | null>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    (e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== null && e[1] !== '',
  );
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('farmlink_token');
}

/** Contract §6.2: `request<T>` throws `ApiError` so callers can branch on `.status` (404 / 410 / …). */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
    throw new ApiError(body.error || body.message || `API error ${res.status}`, res.status);
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

  // Admin (broadcast)
  getUtilization: () => request<any>('/admin/utilization'),
  sendBroadcast: (data: { audience: 'farmers' | 'markets' | 'all'; message: string }) =>
    request<any>('/admin/broadcast', { method: 'POST', body: JSON.stringify(data) }),
  getBroadcasts: () => request<any>('/admin/broadcasts'),

  // ── Phase 2 (contract §8.2) ──

  // Markets
  getPublicMarkets: () => request<{ markets: PublicMarket[] }>('/markets/public'),
  getMarkets: () => request<{ markets: Market[] }>('/markets'),
  getMarket: (id: string) => request<{ market: Market }>(`/markets/${id}`),
  createMarket: (data: CreateMarketInput) =>
    request<{ market: Market; generation: GenerateResult }>('/markets', { method: 'POST', body: JSON.stringify(data) }),
  updateMarket: (id: string, data: Partial<UpdateMarketInput>) =>
    request<{ market: Market; generation?: GenerateResult }>(`/markets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addScheduleVersion: (id: string, data: ScheduleVersionInput) =>
    request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/versions`, { method: 'POST', body: JSON.stringify(data) }),
  deleteScheduleVersion: (id: string, versionId: string) =>
    request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/versions/${versionId}`, { method: 'DELETE' }),
  setSkippedDates: (id: string, skipped_dates: SkippedDate[]) =>
    request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/skipped`, { method: 'PUT', body: JSON.stringify({ skipped_dates }) }),
  setSpecialDates: (id: string, special_dates: SpecialDate[]) =>
    request<{ market: Market; generation: GenerateResult }>(`/markets/${id}/schedule/special`, { method: 'PUT', body: JSON.stringify({ special_dates }) }),
  generateDates: (id: string, scope: 'window' | 'season' = 'window') =>
    request<{ generation: GenerateResult }>(`/markets/${id}/dates/generate`, { method: 'POST', body: JSON.stringify({ scope }) }),
  getMarketDates: (id: string, params?: { from?: string; to?: string; status?: string }) =>
    request<{ dates: MarketDate[] }>(`/markets/${id}/dates${qs(params)}`),
  updateMarketDate: (id: string, dateId: string, data: UpdateMarketDateInput) =>
    request<{ date: MarketDate }>(`/markets/${id}/dates/${dateId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Producers / memberships / check-ins
  getProducers: (params?: { market_id?: string; status?: string; q?: string; include_inactive?: 'true' }) =>
    request<{ producers: ProducerListItem[] }>(`/producers${qs(params)}`),
  getProducer: (id: string) =>
    request<{ producer: Producer; memberships: Membership[]; checkins_summary: { count: number; last_submitted_at: string | null } }>(`/producers/${id}`),
  createProducer: (data: CreateProducerInput) =>
    request<{ producer: Producer; memberships: Membership[] }>('/producers', { method: 'POST', body: JSON.stringify(data) }),
  updateProducer: (id: string, data: Partial<UpdateProducerInput>) =>
    request<{ producer: Producer }>(`/producers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getMemberships: (params: { market_id: string } | { producer_id: string }) =>
    request<{ memberships: MembershipWithProducer[] }>(`/memberships${qs(params)}`),
  createMembership: (data: { producer_id: string; market_id: string; status?: MembershipStatus; fee_plan?: FeePlan }) =>
    request<{ membership: Membership }>('/memberships', { method: 'POST', body: JSON.stringify(data) }),
  updateMembership: (id: string, data: { status?: MembershipStatus; fee_plan?: FeePlan; usual_booth_id?: string | null; note?: string }) =>
    request<{ membership: Membership }>(`/memberships/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCheckins: (params: { market_date_id: string } | { producer_id: string }) =>
    request<{ checkins: Checkin[] }>(`/checkins${qs(params)}`),

  // Applications
  submitApplication: (data: ApplicationInput) =>
    request<{ id: string; status: 'new' }>('/applications', { method: 'POST', body: JSON.stringify(data) }),
  getApplications: (params?: { status?: string }) =>
    request<{ applications: Application[] }>(`/applications${qs(params)}`),
  getApplication: (id: string) => request<{ application: Application }>(`/applications/${id}`),
  reviewApplication: (
    id: string,
    data: { action: 'review' } | { action: 'decline'; note?: string } | { action: 'approve'; market_ids: string[]; note?: string },
  ) =>
    request<{ application: Application; producer?: Producer; memberships?: Membership[] }>(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Staff users, audit, dashboard, providers
  getStaffUsers: () => request<{ users: StaffUser[] }>('/admin/users'),
  inviteStaffUser: (data: { phone: string; name: string; role: 'admin' | 'market_manager'; assigned_market_ids: string[]; email?: string }) =>
    request<{ user: StaffUser; sms: SmsOutcome }>('/admin/users/invite', { method: 'POST', body: JSON.stringify(data) }),
  resendStaffInvite: (id: string) =>
    request<{ sms: SmsOutcome }>(`/admin/users/${id}/resend-invite`, { method: 'POST' }),
  updateStaffUser: (
    id: string,
    data: Partial<{ name: string; email: string | null; role: 'admin' | 'market_manager'; assigned_market_ids: string[]; active: boolean }>,
  ) => request<{ user: StaffUser }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getAuditLog: (params?: { limit?: number; collection?: string; actor_id?: string; action_prefix?: string }) =>
    request<{ entries: AuditEntry[] }>(`/audit-log${qs(params)}`),
  getDashboard: () => request<{ generated_at: string; markets: DashboardCard[] }>('/dashboard'),
  getProviders: () => request<Providers>('/admin/providers'),

  // ── Phase 3 (contract §6.2) ──
  getCheckinByToken: (t: string) => request<CheckinTokenView>(`/checkin/${encodeURIComponent(t)}`),
  submitCheckin: (t: string, data: CheckinSubmitInput) =>
    request<{ ok: true; checkin: CheckinFormValues & { submitted_at: string; submissions: number } }>(
      `/checkin/${encodeURIComponent(t)}`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
  getMarketDateStatus: (id: string) => request<MarketDateStatusView>(`/market-dates/${encodeURIComponent(id)}/status`),
  resendCheckin: (id: string, producer_id: string) =>
    request<{ sms: SmsOutcome; token_expires_at: string; message_id: string | null }>(
      `/market-dates/${encodeURIComponent(id)}/resend-checkin${qs({ producer_id })}`,
      { method: 'POST' },
    ),
  closeMarketDate: (id: string, data: { notify: boolean }) =>
    request<{ result: CloseResult; date: MarketDate }>(`/market-dates/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
