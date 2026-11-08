import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import type { BroadcastCampaign, QueueItem } from '@prisma/client';
import { prisma } from '../db';
import { emitToSession } from '../realtime';
import { toCampaignDTO } from '../serializers';
import { errorMessage } from '../utils/errors';
import { jidToPhone } from '../utils/jid';
import { sleep } from '../utils/sleep';
import type { SessionManager } from '../whatsapp/session-manager';
import { PACING, randomBetween } from '../../src/lib/pacing';
import { renderMessage } from '../../src/lib/spintax';
import type { CampaignDTO, LogLevel } from '../../src/lib/types';

/** Longest single sleep, so pause/abort/shutdown are noticed within a few seconds. */
const SLEEP_SLICE_MS = 3_000;
const DISCONNECTED_POLL_MS = 5_000;

/**
 * One worker per WhatsApp session, strictly one message at a time.
 * State lives in SQLite, so a crash or restart simply resumes from the next PENDING item.
 *
 * Per message:  composing presence → 2–3.5 s → paused presence → send
 * Between messages: random 8–18 s; every 25 messages: 60 s cooldown.
 */
export class Dispatcher {
  private readonly workers = new Map<string, Promise<void>>();
  /** Earliest timestamp at which the next message for a session may be sent. */
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly sentSinceCooldown = new Map<string, number>();
  private readonly waitingForConnection = new Set<string>();
  private stopped = false;

  constructor(private readonly sessions: SessionManager) {}

  /** Crash recovery: anything mid-flight when the process died goes back in the queue. */
  async recover(): Promise<void> {
    const reset = await prisma.queueItem.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
    if (reset.count > 0) console.log(`[dispatcher] re-queued ${reset.count} interrupted message(s)`);

    const running = await prisma.broadcastCampaign.findMany({
      where: { status: 'RUNNING' },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });
    for (const { sessionId } of running) this.kick(sessionId);
  }

  /** Start the session's worker if it isn't already running. Safe to call any time. */
  kick(sessionId: string): void {
    if (this.stopped || this.workers.has(sessionId)) return;
    const worker = this.run(sessionId)
      .catch(async (err: unknown) => {
        console.error(`[dispatcher:${sessionId}] worker crashed:`, err);
        await sleep(DISCONNECTED_POLL_MS);
      })
      .finally(() => {
        this.workers.delete(sessionId);
        // Close the race where a campaign was resumed just as the worker decided to exit.
        this.hasRunnableWork(sessionId)
          .then((has) => {
            if (has) this.kick(sessionId);
          })
          .catch(() => undefined);
      });
    this.workers.set(sessionId, worker);
  }

  stop(): void {
    this.stopped = true;
  }

  async pause(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, sessionId, status: 'RUNNING' },
      data: { status: 'PAUSED' },
    });
    if (res.count > 0) {
      this.log(sessionId, campaignId, 'warn', 'Campaign paused. The message in flight (if any) will finish.');
    }
    return this.emitProgress(campaignId);
  }

  async resume(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, sessionId, status: 'PAUSED' },
      data: { status: 'RUNNING' },
    });
    if (res.count > 0) {
      this.log(sessionId, campaignId, 'info', 'Campaign resumed. Pacing rules still apply.');
      this.kick(sessionId);
    }
    return this.emitProgress(campaignId);
  }

  async abort(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, sessionId, status: { in: ['RUNNING', 'PAUSED'] } },
      data: { status: 'ABORTED', completedAt: new Date() },
    });
    if (res.count > 0) {
      const cancelled = await prisma.queueItem.updateMany({
        where: { campaignId, status: 'PENDING' },
        data: { status: 'CANCELLED', error: 'Aborted by user' },
      });
      this.log(sessionId, campaignId, 'warn', `Campaign aborted. ${cancelled.count} unsent message(s) cancelled.`);
    }
    return this.emitProgress(campaignId);
  }

  /** Used when a session is unlinked: nothing can be sent until the user pairs again. */
  async pauseAllForSession(sessionId: string, reason: string): Promise<void> {
    const running = await prisma.broadcastCampaign.findMany({
      where: { sessionId, status: 'RUNNING' },
      select: { id: true },
    });
    if (running.length === 0) return;
    await prisma.broadcastCampaign.updateMany({
      where: { sessionId, status: 'RUNNING' },
      data: { status: 'PAUSED' },
    });
    for (const { id } of running) {
      this.log(sessionId, id, 'warn', `Campaign paused: ${reason}.`);
      await this.emitProgress(id);
    }
  }

  async emitProgress(campaignId: string): Promise<CampaignDTO | null> {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
      include: { group: { select: { name: true } } },
    });
    if (!campaign) return null;
    const dto = toCampaignDTO(campaign);
    emitToSession(campaign.sessionId, 'campaign_progress', dto);
    return dto;
  }

  log(
    sessionId: string,
    campaignId: string,
    level: LogLevel,
    message: string,
    item?: Pick<QueueItem, 'recipientName' | 'recipientJid'>,
  ): void {
    emitToSession(sessionId, 'campaign_log', {
      id: randomUUID(),
      campaignId,
      timestamp: new Date().toISOString(),
      level,
      recipientName: item?.recipientName ?? null,
      recipientJid: item?.recipientJid ?? null,
      message,
    });
  }

  // ---------------------------------------------------------------------------

  private async hasRunnableWork(sessionId: string): Promise<boolean> {
    if (this.stopped) return false;
    const count = await prisma.broadcastCampaign.count({ where: { sessionId, status: 'RUNNING' } });
    return count > 0;
  }

  private async run(sessionId: string): Promise<void> {
    while (!this.stopped) {
      // Oldest running campaign first; campaigns for one account never run in parallel.
      const campaign = await prisma.broadcastCampaign.findFirst({
        where: { sessionId, status: 'RUNNING' },
        orderBy: { createdAt: 'asc' },
      });
      if (!campaign) return;

      const sock = this.sessions.getConnectedSocket(sessionId);
      if (!sock) {
        if (!this.waitingForConnection.has(campaign.id)) {
          this.waitingForConnection.add(campaign.id);
          this.log(sessionId, campaign.id, 'warn', 'WhatsApp is not connected — dispatch will resume automatically.');
        }
        await sleep(DISCONNECTED_POLL_MS);
        continue;
      }
      if (this.waitingForConnection.delete(campaign.id)) {
        this.log(sessionId, campaign.id, 'info', 'WhatsApp connection is back — resuming dispatch.');
      }

      const item = await prisma.queueItem.findFirst({
        where: { campaignId: campaign.id, status: 'PENDING' },
        orderBy: { position: 'asc' },
      });
      if (!item) {
        await this.complete(campaign);
        continue;
      }

      // Honour the jitter / cooldown window. Sleep in slices and re-check state afterwards.
      const waitMs = (this.nextAllowedAt.get(sessionId) ?? 0) - Date.now();
      if (waitMs > 0) {
        await sleep(Math.min(waitMs, SLEEP_SLICE_MS));
        continue;
      }

      // Claim the item atomically so it can never be sent twice by this process.
      const claimed = await prisma.queueItem.updateMany({
        where: { id: item.id, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      if (claimed.count === 0) continue;

      const current = await prisma.broadcastCampaign.findUnique({
        where: { id: campaign.id },
        select: { status: true },
      });
      if (current?.status !== 'RUNNING') {
        const aborted = current?.status === 'ABORTED';
        await prisma.queueItem.update({
          where: { id: item.id },
          data: aborted ? { status: 'CANCELLED', error: 'Aborted by user' } : { status: 'PENDING' },
        });
        continue;
      }

      await this.processItem(sessionId, sock, campaign, item);
    }
  }

  private async processItem(
    sessionId: string,
    sock: WASocket,
    campaign: BroadcastCampaign,
    item: QueueItem,
  ): Promise<void> {
    const contact = await prisma.contact.findUnique({
      where: { sessionId_jid: { sessionId, jid: item.recipientJid } },
      select: { name: true, pushName: true },
    });
    const displayName = contact?.name ?? contact?.pushName ?? item.recipientName;
    const text = renderMessage(campaign.messageTemplate, {
      name: displayName,
      phone: jidToPhone(item.recipientJid),
    });

    this.log(sessionId, campaign.id, 'processing', 'Typing…', item);

    try {
      await this.deliver(sock, item.recipientJid, text, campaign);
      await prisma.$transaction([
        prisma.queueItem.update({
          where: { id: item.id },
          data: { status: 'SENT', processedAt: new Date(), renderedMessage: text, error: null },
        }),
        prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { sentCount: { increment: 1 } },
        }),
      ]);
      const delay = this.scheduleNext(sessionId, campaign.id);
      this.log(sessionId, campaign.id, 'sent', `Delivered · next in ${Math.round(delay / 1000)}s`, item);
    } catch (err) {
      const reason = errorMessage(err);
      if (!this.sessions.getConnectedSocket(sessionId)) {
        // The connection dropped mid-send: put it back and retry once we're online again.
        await prisma.queueItem.update({ where: { id: item.id }, data: { status: 'PENDING' } });
        this.scheduleNext(sessionId, campaign.id);
        this.log(sessionId, campaign.id, 'warn', `Connection lost while sending (${reason}). Will retry.`, item);
        return;
      }
      await prisma.$transaction([
        prisma.queueItem.update({
          where: { id: item.id },
          data: { status: 'FAILED', processedAt: new Date(), renderedMessage: text, error: reason },
        }),
        prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { failedCount: { increment: 1 } },
        }),
      ]);
      const delay = this.scheduleNext(sessionId, campaign.id);
      this.log(sessionId, campaign.id, 'failed', `${reason} · next in ${Math.round(delay / 1000)}s`, item);
    }

    await this.emitProgress(campaign.id);
  }

  private async deliver(
    sock: WASocket,
    jid: string,
    text: string,
    campaign: BroadcastCampaign,
  ): Promise<void> {
    let mediaFile: string | null = null;
    if (campaign.mediaPath) {
      mediaFile = path.resolve(process.cwd(), campaign.mediaPath);
      await fs.access(mediaFile).catch(() => {
        throw new Error('Attachment file is missing from ./uploads');
      });
    }

    // Simulated human typing.
    await sock.presenceSubscribe(jid).catch(() => undefined);
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(randomBetween(PACING.typingMinMs, PACING.typingMaxMs));
    await sock.sendPresenceUpdate('paused', jid);

    let content: AnyMessageContent;
    if (mediaFile && campaign.mediaType === 'video') {
      content = { video: { url: mediaFile }, caption: text || undefined };
    } else if (mediaFile) {
      content = { image: { url: mediaFile }, caption: text || undefined };
    } else {
      if (!text) throw new Error('Message is empty after rendering the template');
      content = { text };
    }

    const sent = await sock.sendMessage(jid, content);
    if (!sent) throw new Error('WhatsApp did not acknowledge the message');
  }

  /** Decide the gap before the next message: random jitter, or a cooldown every N messages. */
  private scheduleNext(sessionId: string, campaignId: string): number {
    const count = (this.sentSinceCooldown.get(sessionId) ?? 0) + 1;
    let delay: number;
    if (count >= PACING.cooldownEvery) {
      this.sentSinceCooldown.set(sessionId, 0);
      delay = PACING.cooldownMs;
      this.log(
        sessionId,
        campaignId,
        'info',
        `${PACING.cooldownEvery} messages dispatched — cooling down for ${PACING.cooldownMs / 1000}s.`,
      );
    } else {
      this.sentSinceCooldown.set(sessionId, count);
      delay = randomBetween(PACING.jitterMinMs, PACING.jitterMaxMs);
    }
    this.nextAllowedAt.set(sessionId, Date.now() + delay);
    return delay;
  }

  private async complete(campaign: BroadcastCampaign): Promise<void> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaign.id, status: 'RUNNING' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (res.count === 0) return;
    const dto = await this.emitProgress(campaign.id);
    this.log(
      campaign.sessionId,
      campaign.id,
      'info',
      `Campaign complete — ${dto?.sentCount ?? 0} sent, ${dto?.failedCount ?? 0} failed.`,
    );
  }
}
