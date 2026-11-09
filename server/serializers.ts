import type { BroadcastCampaign, QueueItem } from '@prisma/client';
import { isPacingMode } from '../src/lib/pacing';
import type {
  CampaignDTO,
  CampaignLogEntry,
  CampaignStatus,
  LogLevel,
  MediaType,
} from '../src/lib/types';

type CampaignWithGroup = BroadcastCampaign & { group?: { name: string } | null };

/** Real average time between dispatches so far (includes cooldown breaks), or null if too early to tell. */
function averageInterval(c: BroadcastCampaign): number | null {
  const processed = c.sentCount + c.failedCount;
  if (!c.startedAt || !c.lastDispatchAt || processed < 2) return null;
  return Math.round((c.lastDispatchAt.getTime() - c.startedAt.getTime()) / (processed - 1));
}

export function toCampaignDTO(c: CampaignWithGroup): CampaignDTO {
  return {
    id: c.id,
    sessionId: c.sessionId,
    groupId: c.groupId,
    groupName: c.group?.name ?? null,
    name: c.name,
    messageTemplate: c.messageTemplate,
    mediaPath: c.mediaPath,
    mediaType: c.mediaType === 'image' || c.mediaType === 'video' ? (c.mediaType as MediaType) : null,
    mediaSize: c.mediaSize,
    mediaDuration: c.mediaDuration,
    status: (c.status === 'RUNNING' ? 'PROCESSING' : c.status) as CampaignStatus,
    scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    pacing: isPacingMode(c.pacing) ? c.pacing : 'careful',
    occasion: c.occasion,
    totalRecipients: c.totalRecipients,
    sentCount: c.sentCount,
    failedCount: c.failedCount,
    deliveredCount: c.deliveredCount,
    readCount: c.readCount,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    lastDispatchAt: c.lastDispatchAt ? c.lastDispatchAt.toISOString() : null,
    avgIntervalMs: averageInterval(c),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
  };
}

/** Rebuild terminal log lines from processed queue items (used when a browser (re)opens a campaign). */
export function queueItemToLog(item: QueueItem): CampaignLogEntry {
  let level: LogLevel = 'info';
  let message = 'Queued';
  switch (item.status) {
    case 'SENT':
      level = 'sent';
      message = item.readAt ? 'Sent · read' : item.deliveredAt ? 'Sent · delivered' : 'Sent';
      break;
    case 'FAILED':
      level = 'failed';
      message = item.error ?? 'Failed';
      break;
    case 'CANCELLED':
      level = 'warn';
      message = item.error ?? 'Cancelled';
      break;
    case 'PROCESSING':
      level = 'processing';
      message = 'Sending…';
      break;
    default:
      break;
  }
  return {
    id: item.id,
    campaignId: item.campaignId,
    timestamp: (item.processedAt ?? item.updatedAt).toISOString(),
    level,
    recipientName: item.recipientName,
    recipientJid: item.recipientJid,
    message,
  };
}
