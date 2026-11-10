// Shared types used by both the Node server and the Next.js client.

import type { PacingMode } from './pacing';

export type SessionStatus =
  | 'idle' // no socket open (e.g. QR expired with nobody watching)
  | 'connecting' // opening the WhatsApp Web socket
  | 'qr' // waiting for the user to scan the QR code
  | 'connected' // paired and online
  | 'reconnecting' // transient drop, retrying with backoff
  | 'conflict' // the same account was opened by another client
  | 'logged_out'; // unlinked from the phone or by the user

export interface SessionUser {
  jid: string;
  phoneNumber: string;
  name: string | null;
}

export interface SessionSnapshot {
  sessionId: string;
  status: SessionStatus;
  user: SessionUser | null;
  qr: string | null;
  qrAttempt: number;
}

export type CampaignStatus =
  | 'SCHEDULED' // waiting for its start time
  | 'PROCESSING' // sending
  | 'PAUSED' // paused by you (or because WhatsApp was unlinked)
  | 'QUIET_HOURS_PAUSED' // paused automatically during quiet hours; resumes by itself
  | 'COMPLETED'
  | 'ABORTED';
export type QueueStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
export type MediaType = 'image' | 'video';

export interface ContactDTO {
  id: string;
  jid: string;
  name: string | null;
  pushName: string | null;
  phone: string;
  groupIds: string[];
}

export interface ContactSyncState {
  sessionId: string;
  /** True while the address book is being pulled from WhatsApp. */
  syncing: boolean;
  /** When the address book was last fully pulled (null = never). */
  syncedAt: string | null;
  /** Contacts saved in the database. */
  count: number;
}

export interface GroupDTO {
  id: string;
  name: string;
  contactIds: string[];
  /** New address-book contacts are added to this group automatically. */
  autoAddNew: boolean;
  createdAt: string;
}

export interface CampaignDTO {
  id: string;
  sessionId: string;
  groupId: string | null;
  groupName: string | null;
  name: string;
  messageTemplate: string;
  mediaPath: string | null;
  mediaType: MediaType | null;
  mediaSize: number | null;
  mediaDuration: number | null;
  status: CampaignStatus;
  /** Start time for scheduled campaigns. */
  scheduledAt: string | null;
  pacing: PacingMode;
  /** Occasion id (see occasions.ts), if one was chosen. */
  occasion: string | null;
  totalRecipients: number;
  /** Accepted by WhatsApp's server ("dispatched"). */
  sentCount: number;
  failedCount: number;
  /** Reached the recipient's phone (from delivery receipts). */
  deliveredCount: number;
  /** Opened — only counted when the recipient shares read receipts. */
  readCount: number;
  startedAt: string | null;
  lastDispatchAt: string | null;
  /** Real average time between messages so far, including pauses for cooldowns (null until 2 sent). */
  avgIntervalMs: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** A compressed attachment ready to broadcast. */
export interface MediaInfo {
  /** File name inside the uploads folder. */
  file: string;
  mediaType: MediaType;
  mimeType: string;
  /** Bytes after compression, and before. */
  size: number;
  originalSize: number;
  originalName: string;
  width: number | null;
  height: number | null;
  /** Seconds (videos only). */
  durationSec: number | null;
  /** false = sent exactly as uploaded ("Keep original"). Older files without the flag were compressed. */
  compressed?: boolean;
  /** Something worth showing the user about this file (e.g. metadata kept, codec compatibility). */
  note?: string | null;
}

export interface MediaJob {
  id: string;
  sessionId: string;
  status: 'processing' | 'ready' | 'failed';
  /** 0–100 */
  progress: number;
  stage: string;
  result: MediaInfo | null;
  error: string | null;
}

export interface DraftDTO {
  groupId: string | null;
  name: string;
  messageTemplate: string;
  media: MediaInfo | null;
  scheduledAt: string | null;
  occasion: string | null;
  language: string;
  pacing: string;
  updatedAt: string | null;
}

export interface QuietHoursSettings {
  enabled: boolean;
  /** "HH:MM", 24-hour, in the server's time zone */
  start: string;
  end: string;
  /** IANA time zone the server runs in, e.g. Asia/Kolkata (read-only) */
  timeZone: string;
  /** Whether quiet hours are in effect right now (read-only) */
  activeNow: boolean;
}

export type LogLevel = 'info' | 'warn' | 'processing' | 'sent' | 'failed';

export interface CampaignLogEntry {
  id: string;
  campaignId: string;
  timestamp: string;
  level: LogLevel;
  recipientName: string | null;
  recipientJid: string | null;
  message: string;
}

export interface CampaignDetailResponse {
  campaign: CampaignDTO;
  logs: CampaignLogEntry[];
}

export interface ServerToClientEvents {
  qr_code: (payload: { sessionId: string; qr: string; attempt: number }) => void;
  session_status: (payload: SessionSnapshot) => void;
  session_connected: (payload: SessionUser & { sessionId: string }) => void;
  session_logged_out: (payload: { sessionId: string; reason: string }) => void;
  session_error: (payload: { message: string }) => void;
  contacts_synced: (payload: { sessionId: string; count: number; received: number }) => void;
  contacts_sync_state: (payload: ContactSyncState) => void;
  campaign_progress: (payload: CampaignDTO) => void;
  campaign_log: (payload: CampaignLogEntry) => void;
  media_job: (payload: MediaJob) => void;
  /** Everything on the server was erased; every open tab starts over. */
  server_erased: (payload: EraseResult) => void;
}

export interface EraseResult {
  /** Accounts WhatsApp confirmed as unlinked. */
  unlinked: number;
  /** Paired accounts whose unlink WhatsApp didn't confirm (offline); remove them on the phone. */
  notConfirmed: number;
  erasedAt: string;
}

export interface ClientToServerEvents {
  init_session: (payload: { sessionId: string }) => void;
  refresh_qr: (payload: { sessionId: string }) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session IDs become folder names on disk, so they must be strict UUIDs. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
