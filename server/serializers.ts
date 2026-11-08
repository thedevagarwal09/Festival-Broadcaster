import type { BroadcastCampaign, QueueItem } from '@prisma/client';
import type {
  CampaignDTO,
  CampaignLogEntry,
  CampaignStatus,
  LogLevel,
  MediaType,
} from '../src/lib/types';

type CampaignWithGroup = BroadcastCampaign & { group?: { name: string } | null };

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
    status: c.status as CampaignStatus,
    totalRecipients: c.totalRecipients,
    sentCount: c.sentCount,
    failedCount: c.failedCount,
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
      message = 'Delivered';
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
