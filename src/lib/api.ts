import type { CampaignDTO, CampaignDetailResponse, ContactDTO, GroupDTO, SessionSnapshot } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

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
