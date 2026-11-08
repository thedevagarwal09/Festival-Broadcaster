import type {
  CampaignDTO,
  CampaignDetailResponse,
  ContactDTO,
  ContactSyncState,
  DraftDTO,
  GroupDTO,
  MediaJob,
  QuietHoursSettings,
  SessionSnapshot,
} from './types';

export interface CreateCampaignInput {
  groupId: string;
  messageTemplate: string;
  name?: string;
  /** File name of a compressed attachment (MediaInfo.file). */
  mediaFile?: string | null;
  /** ISO time to start; omit or null to send now. */
  scheduledAt?: string | null;
}

export interface DraftInput {
  groupId: string | null;
  name: string;
  messageTemplate: string;
  mediaFile: string | null;
  scheduledAt: string | null;
}

/**
 * Upload an original for compression, reporting upload progress (0–100). Resolves with the
 * compression job once the server has the whole file. Uses XHR because fetch can't report
 * upload progress.
 */
export function uploadMedia(
  sessionId: string,
  file: File,
  onUploadProgress: (percent: number) => void,
): { promise: Promise<MediaJob>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<MediaJob>((resolve, reject) => {
    xhr.open('POST', `/api/sessions/${encodeURIComponent(sessionId)}/media`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error page (e.g. a proxy's "413 Request Entity Too Large")
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as MediaJob);
      else if (xhr.status === 413) reject(new Error('The server or proxy refused a file this large. Raise its upload limit, or use a smaller file.'));
      else reject(new Error((body as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    const form = new FormData();
    form.append('media', file);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}

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
  contactSyncState: (sessionId: string) => request<ContactSyncState>(`${base(sessionId)}/contacts/sync`),
  syncContactsNow: (sessionId: string) =>
    request<ContactSyncState>(`${base(sessionId)}/contacts/sync`, { method: 'POST' }),

  /** Add contacts to a group, or remove them from it. */
  groupMembers: (sessionId: string, groupId: string, action: 'add' | 'remove', contactIds: string[]) =>
    request<GroupDTO>(`${base(sessionId)}/groups/${groupId}/members`, json('POST', { action, contactIds })),
  /** Move contacts from one group to another (only those actually in the source group move). */
  moveContacts: (sessionId: string, fromGroupId: string, toGroupId: string, contactIds: string[]) =>
    request<{ moved: number; from: GroupDTO; to: GroupDTO }>(
      `${base(sessionId)}/groups/move`,
      json('POST', { fromGroupId, toGroupId, contactIds }),
    ),

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
  createCampaign: (sessionId: string, input: CreateCampaignInput) =>
    request<CampaignDTO>(`${base(sessionId)}/campaigns`, json('POST', input)),

  mediaJob: (sessionId: string, jobId: string) => request<MediaJob>(`${base(sessionId)}/media/jobs/${jobId}`),
  deleteMedia: (sessionId: string, file: string) =>
    fetch(`${base(sessionId)}/media/${encodeURIComponent(file)}`, { method: 'DELETE' }).then(() => undefined),

  draft: (sessionId: string) => request<DraftDTO>(`${base(sessionId)}/draft`),
  saveDraft: (sessionId: string, draft: DraftInput) =>
    request<{ updatedAt: string }>(`${base(sessionId)}/draft`, json('PUT', draft)),

  quietHours: () => request<QuietHoursSettings>('/api/settings/quiet-hours'),
  saveQuietHours: (q: Pick<QuietHoursSettings, 'enabled' | 'start' | 'end'>) =>
    request<QuietHoursSettings>('/api/settings/quiet-hours', json('PUT', q)),
  controlCampaign: (sessionId: string, campaignId: string, action: 'pause' | 'resume' | 'abort') =>
    request<CampaignDTO>(`${base(sessionId)}/campaigns/${campaignId}/${action}`, { method: 'POST' }),
};
