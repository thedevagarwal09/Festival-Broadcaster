import type { ContactDTO } from './types';

export function contactDisplayName(contact: Pick<ContactDTO, 'name' | 'pushName' | 'phone'>): string {
  return contact.name ?? contact.pushName ?? contact.phone;
}

export function initials(label: string): string {
  const parts = label.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '#';
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function jidToPhone(jid: string | null): string {
  if (!jid) return '';
  return `+${jid.split('@')[0] ?? ''}`;
}
