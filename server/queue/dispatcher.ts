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
import { isPacingMode, PACING_PROFILES, randomBetween, type PacingMode } from '../../src/lib/pacing';
import { renderMessage } from '../../src/lib/spintax';
import { describeQuietHours, isQuietNow, quietHoursEnd } from '../services/quietHours';
import { mediaCacheFor } from '../whatsapp/media-cache';
import type { CampaignDTO, LogLevel } from '../../src/lib/types';

/** Longest single sleep, so pause/abort/shutdown are noticed within a few seconds. */
const SLEEP_SLICE_MS = 3_000;
const DISCONNECTED_POLL_MS = 5_000;
/** proto.WebMessageInfo.Status: 3 = DELIVERY_ACK, 4 = READ (5 = PLAYED). */
const RECEIPT_DELIVERED = 3;
const RECEIPT_READ = 4;
const EARLY_RECEIPT_TTL_MS = 2 * 60_000;

const pacingOf = (c: BroadcastCampaign): PacingMode => (isPacingMode(c.pacing) ? c.pacing : 'careful');

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
  /** Burst / long-break progress per WhatsApp account. */
  private readonly paceState = new Map<string, { sinceLongRest: number; burstLeft: number }>();
  private readonly waitingForConnection = new Set<string>();
  /** Receipts that arrived before the sent message's id was saved. */
  private readonly earlyReceipts = new Map<string, { status: number; at: number }>();
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly sessions: SessionManager) {}

  /** Crash recovery: anything mid-flight when the process died goes back in the queue. */
  async recover(): Promise<void> {
    const reset = await prisma.queueItem.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
    if (reset.count > 0) console.log(`[dispatcher] re-queued ${reset.count} interrupted message(s)`);

    // Campaigns created before the scheduler existed used "RUNNING" for "sending".
    await prisma.broadcastCampaign.updateMany({ where: { status: 'RUNNING' }, data: { status: 'PROCESSING' } });

    const running = await prisma.broadcastCampaign.findMany({
      where: { status: 'PROCESSING' },
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

  /** Manual pause. Also stops a quiet-hours pause from auto-resuming. */
  async pause(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, sessionId, status: { in: ['PROCESSING', 'QUIET_HOURS_PAUSED'] } },
      data: { status: 'PAUSED' },
    });
    if (res.count > 0) {
      this.log(sessionId, campaignId, 'warn', 'Campaign paused. The message in flight (if any) will finish.');
    }
    return this.emitProgress(campaignId);
  }

  /** Resume a paused campaign, or start a scheduled one now. Respects quiet hours. */
  async resume(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const quiet = await isQuietNow();
    const current = await prisma.broadcastCampaign.findFirst({
      where: { id: campaignId, sessionId },
      select: { status: true },
    });
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, sessionId, status: { in: ['PAUSED', 'SCHEDULED'] } },
      data: { status: quiet ? 'QUIET_HOURS_PAUSED' : 'PROCESSING' },
    });
    if (res.count > 0) {
      const verb = current?.status === 'SCHEDULED' ? 'Started now instead of at the scheduled time' : 'Campaign resumed';
      this.log(
        sessionId,
        campaignId,
        quiet ? 'warn' : 'info',
        quiet
          ? `${verb}, but it's quiet hours (${await describeQuietHours()}). Sending begins at ${await quietHoursEnd()}.`
          : `${verb}. Pacing rules still apply.`,
      );
      if (!quiet) this.kick(sessionId);
    }
    return this.emitProgress(campaignId);
  }

  /** Called by the scheduler and right before each send when quiet hours begin. */
  async pauseForQuietHours(sessionId: string, campaignId: string): Promise<void> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaignId, status: 'PROCESSING' },
      data: { status: 'QUIET_HOURS_PAUSED' },
    });
    if (res.count === 0) return;
    this.log(
      sessionId,
      campaignId,
      'warn',
      `Quiet hours (${await describeQuietHours()}) — paused automatically. Resumes at ${await quietHoursEnd()}.`,
    );
    await this.emitProgress(campaignId);
  }

  async abort(sessionId: string, campaignId: string): Promise<CampaignDTO | null> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: {
        id: campaignId,
        sessionId,
        status: { in: ['SCHEDULED', 'PROCESSING', 'PAUSED', 'QUIET_HOURS_PAUSED'] },
      },
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
    const active = { in: ['PROCESSING', 'QUIET_HOURS_PAUSED'] };
    const running = await prisma.broadcastCampaign.findMany({
      where: { sessionId, status: active },
      select: { id: true },
    });
    if (running.length === 0) return;
    await prisma.broadcastCampaign.updateMany({
      where: { sessionId, status: active },
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

  // --- Delivery / read receipts ---------------------------------------------

  /**
   * WhatsApp message status updates for messages we sent (from Baileys `messages.update`):
   * 3 = delivered to the phone, 4 = read, 5 = played (voice/video). Read only arrives when the
   * recipient shares read receipts, so "Read" is a lower bound.
   */
  async handleReceipts(updates: Array<{ messageId: string; status: number }>): Promise<void> {
    const touched = new Set<string>();
    for (const u of updates) {
      if (u.status < RECEIPT_DELIVERED) continue;
      const campaignId = await this.applyReceipt(u.messageId, u.status);
      if (campaignId) touched.add(campaignId);
      else this.earlyReceipts.set(u.messageId, { status: u.status, at: Date.now() });
    }
    for (const id of touched) this.scheduleProgressEmit(id);
    // Forget early receipts that never matched one of our messages (e.g. sent from the phone).
    const cutoff = Date.now() - EARLY_RECEIPT_TTL_MS;
    for (const [id, r] of this.earlyReceipts) if (r.at < cutoff) this.earlyReceipts.delete(id);
  }

  private async applyEarlyReceipt(messageId: string): Promise<void> {
    const early = this.earlyReceipts.get(messageId);
    if (!early) return;
    this.earlyReceipts.delete(messageId);
    const campaignId = await this.applyReceipt(messageId, early.status);
    if (campaignId) this.scheduleProgressEmit(campaignId);
  }

  /** Record delivered/read once per message. Returns the campaign id, or null if it isn't ours (yet). */
  private async applyReceipt(messageId: string, status: number): Promise<string | null> {
    const item = await prisma.queueItem.findFirst({
      where: { messageId },
      select: { id: true, campaignId: true, deliveredAt: true, readAt: true },
    });
    if (!item) return null;
    const now = new Date();
    const markDelivered = !item.deliveredAt; // read implies delivered
    const markRead = status >= RECEIPT_READ && !item.readAt;
    if (!markDelivered && !markRead) return item.campaignId;
    await prisma.$transaction([
      prisma.queueItem.update({
        where: { id: item.id },
        data: { ...(markDelivered ? { deliveredAt: now } : {}), ...(markRead ? { readAt: now } : {}) },
      }),
      prisma.broadcastCampaign.update({
        where: { id: item.campaignId },
        data: {
          ...(markDelivered ? { deliveredCount: { increment: 1 } } : {}),
          ...(markRead ? { readCount: { increment: 1 } } : {}),
        },
      }),
    ]);
    return item.campaignId;
  }

  /** Receipts arrive in bursts; push at most one progress update per campaign per second. */
  private scheduleProgressEmit(campaignId: string): void {
    if (this.progressTimers.has(campaignId)) return;
    const timer = setTimeout(() => {
      this.progressTimers.delete(campaignId);
      this.emitProgress(campaignId).catch(() => undefined);
    }, 1_000);
    timer.unref();
    this.progressTimers.set(campaignId, timer);
  }

  // ---------------------------------------------------------------------------

  private async hasRunnableWork(sessionId: string): Promise<boolean> {
    if (this.stopped) return false;
    const count = await prisma.broadcastCampaign.count({ where: { sessionId, status: 'PROCESSING' } });
    return count > 0;
  }

  private async run(sessionId: string): Promise<void> {
    while (!this.stopped) {
      // Oldest running campaign first; campaigns for one account never run in parallel.
      const campaign = await prisma.broadcastCampaign.findFirst({
        where: { sessionId, status: 'PROCESSING' },
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

      // Never send during quiet hours, even between scheduler ticks (e.g. at 23:00:30).
      if (await isQuietNow()) {
        await this.pauseForQuietHours(sessionId, campaign.id);
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
      if (current?.status !== 'PROCESSING') {
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
      const messageId = await this.deliver(sock, item.recipientJid, text, campaign);
      const now = new Date();
      await prisma.$transaction([
        prisma.queueItem.update({
          where: { id: item.id },
          data: { status: 'SENT', processedAt: now, renderedMessage: text, error: null, messageId },
        }),
        prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { sentCount: { increment: 1 }, lastDispatchAt: now },
        }),
        prisma.broadcastCampaign.updateMany({ where: { id: campaign.id, startedAt: null }, data: { startedAt: now } }),
      ]);
      // A delivery receipt can beat our database write; apply any that arrived early.
      if (messageId) await this.applyEarlyReceipt(messageId);
      const delay = this.scheduleNext(sessionId, campaign.id, pacingOf(campaign));
      this.log(sessionId, campaign.id, 'sent', `Sent · next in ${Math.round(delay / 1000)}s`, item);
    } catch (err) {
      const reason = errorMessage(err);
      // If the attachment pointer went stale, the next send uploads it again.
      if (campaign.mediaPath) mediaCacheFor(sessionId).forgetFile(path.resolve(process.cwd(), campaign.mediaPath));
      if (!this.sessions.getConnectedSocket(sessionId)) {
        // The connection dropped mid-send: put it back and retry once we're online again.
        await prisma.queueItem.update({ where: { id: item.id }, data: { status: 'PENDING' } });
        this.scheduleNext(sessionId, campaign.id, pacingOf(campaign));
        this.log(sessionId, campaign.id, 'warn', `Connection lost while sending (${reason}). Will retry.`, item);
        return;
      }
      const now = new Date();
      await prisma.$transaction([
        prisma.queueItem.update({
          where: { id: item.id },
          data: { status: 'FAILED', processedAt: now, renderedMessage: text, error: reason },
        }),
        prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { failedCount: { increment: 1 }, lastDispatchAt: now },
        }),
        prisma.broadcastCampaign.updateMany({ where: { id: campaign.id, startedAt: null }, data: { startedAt: now } }),
      ]);
      const delay = this.scheduleNext(sessionId, campaign.id, pacingOf(campaign));
      this.log(sessionId, campaign.id, 'failed', `${reason} · next in ${Math.round(delay / 1000)}s`, item);
    }

    await this.emitProgress(campaign.id);
  }

  private async deliver(
    sock: WASocket,
    jid: string,
    text: string,
    campaign: BroadcastCampaign,
  ): Promise<string | null> {
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
    const p = PACING_PROFILES[pacingOf(campaign)];
    await sleep(randomBetween(p.typingMinMs, p.typingMaxMs));
    await sock.sendPresenceUpdate('paused', jid);

    let content: AnyMessageContent;
    if (mediaFile && campaign.mediaType === 'video') {
      content = { video: { url: mediaFile }, caption: text || undefined };
    } else if (mediaFile) {
      const ext = path.extname(mediaFile).toLowerCase();
      const mimetype = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      content = { image: { url: mediaFile }, caption: text || undefined, mimetype };
    } else {
      if (!text) throw new Error('Message is empty after rendering the template');
      content = { text };
    }

    const sent = await sock.sendMessage(jid, content);
    if (!sent) throw new Error('WhatsApp did not acknowledge the message');
    return sent.key.id ?? null;
  }

  /** Decide the gap before the next message: random jitter, or a cooldown every N messages. */
  /**
   * Decide the gap before the next message from the campaign's pacing preset:
   * a gap inside a burst, a rest after a burst, or a longer break every N messages.
   */
  private scheduleNext(sessionId: string, campaignId: string, pacing: PacingMode): number {
    const p = PACING_PROFILES[pacing];
    const newBurst = (): number => (p.burstMax > 0 ? randomBetween(p.burstMin, p.burstMax) : 0);
    const state = this.paceState.get(sessionId) ?? { sinceLongRest: 0, burstLeft: newBurst() };
    state.sinceLongRest += 1;

    let delay: number;
    if (state.sinceLongRest >= p.longRestEvery) {
      state.sinceLongRest = 0;
      state.burstLeft = newBurst();
      delay = p.longRestMs;
      this.log(sessionId, campaignId, 'info', `${p.longRestEvery} messages sent — taking a ${p.longRestMs / 1000}s break.`);
    } else if (p.burstMax > 0) {
      state.burstLeft -= 1;
      if (state.burstLeft <= 0) {
        state.burstLeft = newBurst();
        delay = randomBetween(p.restMinMs, p.restMaxMs);
      } else {
        delay = randomBetween(p.gapMinMs, p.gapMaxMs);
      }
    } else {
      delay = randomBetween(p.gapMinMs, p.gapMaxMs);
    }
    this.paceState.set(sessionId, state);
    this.nextAllowedAt.set(sessionId, Date.now() + delay);
    return delay;
  }

  private async complete(campaign: BroadcastCampaign): Promise<void> {
    const res = await prisma.broadcastCampaign.updateMany({
      where: { id: campaign.id, status: 'PROCESSING' },
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
