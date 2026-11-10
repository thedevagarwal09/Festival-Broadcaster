import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db';
import type { Dispatcher } from '../queue/dispatcher';
import { emitToAll } from '../realtime';
import { INCOMING_DIR, UPLOAD_DIR } from '../upload';
import { HttpError } from '../utils/errors';
import { clearAllMediaCaches } from '../whatsapp/media-cache';
import type { SessionManager } from '../whatsapp/session-manager';
import { clearMediaJobs } from './mediaJobs';
import { resetQuietHoursCache } from './quietHours';
import type { EraseResult } from '../../src/lib/types';

let running = false;

/**
 * "Unlink & erase all data": leaves the server as if it had just been installed.
 *
 *  1. stop sending (each worker finishes the message in flight)
 *  2. unlink every WhatsApp account and delete its login keys
 *  3. delete every database row: contacts, groups, campaigns, logs, drafts, settings
 *  4. compact the database file so deleted rows don't linger in free pages or the WAL
 *  5. delete every uploaded / compressed / e-card file
 */
export async function eraseEverything(sessions: SessionManager, dispatcher: Dispatcher): Promise<EraseResult> {
  if (running) throw new HttpError(409, 'An erase is already running.');
  running = true;
  console.log('[erase] erasing all data on this server…');
  try {
    await dispatcher.halt();
    const { unlinked, notConfirmed } = await sessions.unlinkAllForErase();

    const hasJoinTable =
      (await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_ContactToContactGroup'`,
      )).length > 0;
    await prisma.$transaction([
      ...(hasJoinTable ? [prisma.$executeRawUnsafe('DELETE FROM "_ContactToContactGroup"')] : []),
      prisma.queueItem.deleteMany(),
      prisma.broadcastCampaign.deleteMany(),
      prisma.draft.deleteMany(),
      prisma.contactGroup.deleteMany(),
      prisma.contact.deleteMany(),
      prisma.userSession.deleteMany(),
      prisma.appSetting.deleteMany(),
    ]);
    // Deleted rows stay readable in the file until it is rewritten.
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
    await prisma.$executeRawUnsafe('VACUUM;');
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
    resetQuietHoursCache();

    const files = await fs.readdir(UPLOAD_DIR).catch(() => [] as string[]);
    for (const file of files) {
      if (file === '.gitkeep') continue;
      await fs.rm(path.join(UPLOAD_DIR, file), { recursive: true, force: true });
    }
    await fs.mkdir(INCOMING_DIR, { recursive: true });
    clearMediaJobs();
    clearAllMediaCaches();

    const result: EraseResult = { unlinked, notConfirmed, erasedAt: new Date().toISOString() };
    console.log(`[erase] done: ${unlinked} account(s) unlinked, ${notConfirmed} not confirmed by WhatsApp`);
    emitToAll('server_erased', result);
    return result;
  } finally {
    sessions.finishErase();
    dispatcher.release();
    running = false;
  }
}
