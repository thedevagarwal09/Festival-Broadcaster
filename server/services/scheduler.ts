/**
 * Unattended campaign scheduler and quiet-hours enforcer.
 *
 * Runs on the server every minute (node-cron), so nothing depends on a browser being open:
 *
 *   SCHEDULED ──(start time reached)──▶ PROCESSING ──▶ COMPLETED
 *       │                                 │   ▲
 *       │ (start time in quiet hours)     │   │ (quiet hours over, e.g. 07:00)
 *       └──────────────▶ QUIET_HOURS_PAUSED ◀─┘ (quiet hours start, e.g. 23:00)
 *
 *   PAUSED is only ever set by a person (or when WhatsApp is unlinked) and is never auto-resumed.
 *
 * The dispatcher also checks quiet hours right before each message, so nothing is sent between
 * cron ticks (e.g. at 23:00:30).
 */
import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../db';
import type { Dispatcher } from '../queue/dispatcher';
import { errorMessage } from '../utils/errors';
import { describeQuietHours, isQuietNow, quietHoursEnd } from './quietHours';

export class Scheduler {
  private task: ScheduledTask | null = null;
  private ticking = false;

  constructor(private readonly dispatcher: Dispatcher) {}

  start(): void {
    void this.tick();
    this.task = cron.schedule('* * * * *', () => this.tick(), { name: 'campaign-scheduler', noOverlap: true });
  }

  async stop(): Promise<void> {
    await this.task?.stop();
    this.task = null;
  }

  /** One pass: start due campaigns, and pause/resume for quiet hours. Safe to call any time. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Each person has their own quiet hours: check them once per session per tick.
      const quietBySession = new Map<string, boolean>();
      const isQuiet = async (sessionId: string): Promise<boolean> => {
        let quiet = quietBySession.get(sessionId);
        if (quiet === undefined) {
          quiet = await isQuietNow(sessionId);
          quietBySession.set(sessionId, quiet);
        }
        return quiet;
      };

      // 1. Scheduled campaigns whose start time has arrived.
      const due = await prisma.broadcastCampaign.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        select: { id: true, sessionId: true },
      });
      for (const c of due) {
        const quiet = await isQuiet(c.sessionId);
        const next = quiet ? 'QUIET_HOURS_PAUSED' : 'PROCESSING';
        const res = await prisma.broadcastCampaign.updateMany({
          where: { id: c.id, status: 'SCHEDULED' },
          data: { status: next },
        });
        if (res.count === 0) continue;
        this.dispatcher.log(
          c.sessionId,
          c.id,
          quiet ? 'warn' : 'info',
          quiet
            ? `Start time reached during quiet hours (${await describeQuietHours(c.sessionId)}). Sending will begin at ${await quietHoursEnd(c.sessionId)}.`
            : 'Scheduled start time reached — sending now.',
        );
        await this.dispatcher.emitProgress(c.id);
        if (!quiet) this.dispatcher.kick(c.sessionId);
      }

      // 2. Quiet hours: pause what's sending, or resume what was paused for quiet hours.
      const sending = await prisma.broadcastCampaign.findMany({
        where: { status: 'PROCESSING' },
        select: { id: true, sessionId: true },
      });
      for (const c of sending) {
        if (await isQuiet(c.sessionId)) await this.dispatcher.pauseForQuietHours(c.sessionId, c.id);
      }
      {
        const waiting = await prisma.broadcastCampaign.findMany({
          where: { status: 'QUIET_HOURS_PAUSED' },
          select: { id: true, sessionId: true },
        });
        for (const c of waiting) {
          if (await isQuiet(c.sessionId)) continue;
          const res = await prisma.broadcastCampaign.updateMany({
            where: { id: c.id, status: 'QUIET_HOURS_PAUSED' },
            data: { status: 'PROCESSING' },
          });
          if (res.count === 0) continue;
          this.dispatcher.log(c.sessionId, c.id, 'info', `Quiet hours are over — resuming automatically.`);
          await this.dispatcher.emitProgress(c.id);
          this.dispatcher.kick(c.sessionId);
        }
      }
    } catch (err) {
      console.error('[scheduler] tick failed:', errorMessage(err));
    } finally {
      this.ticking = false;
    }
  }
}
