import type { CampaignDTO, CampaignDetailResponse, ContactDTO, GroupDTO, SessionSnapshot } from './types';

/** Fired on window whenever the server says this browser is locked. */
export const AUTH_REQUIRED_EVENT = 'fb:auth-required';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number };
    // A 401 from any data endpoint means the session expired or was locked elsewhere.
    if (res.status === 401 && !url.startsWith('/api/auth/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.retryAfter ?? null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AuthStatus {
  pinSet: boolean;
  authenticated: boolean;
}

export const authApi = {
  status: () => request<AuthStatus>('/api/auth/status'),
  setup: (pin: string) => request<{ ok: true }>('/api/auth/setup', json('POST', { pin })),
  login: (pin: string) => request<{ ok: true }>('/api/auth/login', json('POST', { pin })),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  ping: () => request<void>('/api/auth/ping', { method: 'POST' }),
  change: (currentPin: string, newPin: string) =>
    request<{ ok: true }>('/api/auth/change', json('POST', { currentPin, newPin })),
};

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const base = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}`;

export const api = {
  status: (sessionId: string) => request<SessionSnapshot>(`${base(sessionId)}/status`),
  logout: (sessionId: string) => request<{ ok: true }>(`${base(sessionId)}/logout`, { method: 'POST' }),

  contacts: (sessionId: string) => request<ContactDTO[]>(`${base(sessionId)}/contacts`),

  groups: (sessionId: string) => request<GroupDTO[]>(`${base(sessionId)}/groups`),
  createGroup: (sessionId: string, name: string, contactIds: string[], autoAddNew: boolean) =>
    request<GroupDTO>(`${base(sessionId)}/groups`, json('POST', { name, contactIds, autoAddNew })),
  updateGroup: (sessionId: string, groupId: string, name: string, contactIds: string[], autoAddNew: boolean) =>
    request<GroupDTO>(`${base(sessionId)}/groups/${groupId}`, json('PUT', { name, contactIds, autoAddNew })),
  deleteGroup: (sessionId: string, groupId: string) =>
    request<{ ok: true }>(`${base(sessionId)}/groups/${groupId}`, { method: 'DELETE' }),

  campaigns: (sessionId: string) => request<CampaignDTO[]>(`${base(sessionId)}/campaigns`),
  campaign: (sessionId: string, campaignId: string) =>
    request<CampaignDetailResponse>(`${base(sessionId)}/campaigns/${campaignId}`),
  createCampaign: (sessionId: string, form: FormData) =>
    request<CampaignDTO>(`${base(sessionId)}/campaigns`, { method: 'POST', body: form }),
  controlCampaign: (sessionId: string, campaignId: string, action: 'pause' | 'resume' | 'abort') =>
    request<CampaignDTO>(`${base(sessionId)}/campaigns/${campaignId}/${action}`, { method: 'POST' }),
};
