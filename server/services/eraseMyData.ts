import fs from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { Dispatcher } from '../queue/dispatcher';
import { emitToSession } from '../realtime';
import { HttpError } from '../utils/errors';
import { clearMediaCachesFor } from '../whatsapp/media-cache';
import type { SessionManager } from '../whatsapp/session-manager';
import { clearMediaJobsFor, deleteMediaFile, isMediaFileName, readMediaOwner } from './mediaJobs';
import { UPLOAD_DIR } from '../upload';
import type { EraseResult } from '../../src/lib/types';

/** A browser keeps a short history of its session ids; this caps one request. */
export const MAX_ERASE_SESSIONS = 25;

/** Sessions with an erase in progress, so two requests can't run over the same data. */
const inProgress = new Set<string>();

/** File names referenced by these campaigns' and drafts' attachments. */
async function referencedFiles(where: { in: string[] } | { notIn: string[] }): Promise<Set<string>> {
  const files = new Set<string>();
  const campaigns = await prisma.broadcastCampaign.findMany({
    where: { sessionId: where, mediaPath: { not: null } },
    select: { mediaPath: true },
  });
  for (const c of campaigns) if (c.mediaPath) files.add(path.basename(c.mediaPath));
  const drafts = await prisma.draft.findMany({ where: { sessionId: where, media: { not: null } }, select: { media: true } });
  for (const d of drafts) {
    try {
      const file = (JSON.parse(d.media ?? '') as { file?: unknown }).file;
      if (typeof file === 'string') files.add(file);
    } catch {
      // unreadable draft media: nothing to delete
    }
  }
  return files;
}

/**
 * "Unlink & erase my data": deletes everything belonging to one person and nothing else.
 *
 * "One person" is the session ids their browser has used, widened to every session of the
 * WhatsApp number(s) linked to those ids (the same phone linked earlier or from another browser).
 *
 *  1. stop their sending (the message in flight finishes first)
 *  2. unlink their WhatsApp account(s) and delete the login keys
 *  3. delete their attachments and e-cards (files another person also uses are kept)
 *  4. delete their contacts, groups, campaigns, logs and draft
 *  5. compact the database so deleted rows don't linger in free pages or the WAL
 *
 * Server-wide settings (quiet hours) belong to whoever runs the server and are left alone.
 */
export async function eraseMyData(
  requestedIds: string[],
  sessions: SessionManager,
  dispatcher: Dispatcher,
): Promise<EraseResult> {
  const phones = (
    await prisma.userSession.findMany({
      where: { id: { in: requestedIds }, phoneNumber: { not: null } },
      select: { phoneNumber: true },
    })
  )
    .map((s) => s.phoneNumber)
    .filter((p): p is string => Boolean(p));
  const ids = [...new Set([...requestedIds, ...(await sessions.sessionIdsForPhones(phones))])];
  if (ids.some((id) => inProgress.has(id))) throw new HttpError(409, 'Your data is already being erased.');
  const targets: ReadonlySet<string> = new Set(ids);
  for (const id of ids) inProgress.add(id);

  console.log(`[erase] erasing data for ${ids.length} session(s)…`);
  try {
    await dispatcher.haltSessions(targets);
    const { unlinked, notConfirmed } = await sessions.unlinkForErase(targets);

    // Files: those this person uploaded or created, plus those their campaigns and draft use,
    // minus any that someone else's campaign or draft still uses (older files have no owner).
    const files = await referencedFiles({ in: ids });
    for (const name of await fs.readdir(UPLOAD_DIR).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const file = name.slice(0, -'.json'.length);
      const owner = await readMediaOwner(file);
      if (owner && targets.has(owner)) files.add(file);
    }
    for (const file of await referencedFiles({ notIn: ids })) files.delete(file);

    const idList = Prisma.join(ids);
    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM "_ContactToContactGroup"
        WHERE "A" IN (SELECT "id" FROM "Contact" WHERE "sessionId" IN (${idList}))
           OR "B" IN (SELECT "id" FROM "ContactGroup" WHERE "sessionId" IN (${idList}))`,
      prisma.queueItem.deleteMany({ where: { campaign: { sessionId: { in: ids } } } }),
      prisma.broadcastCampaign.deleteMany({ where: { sessionId: { in: ids } } }),
      prisma.draft.deleteMany({ where: { sessionId: { in: ids } } }),
      prisma.contactGroup.deleteMany({ where: { sessionId: { in: ids } } }),
      prisma.contact.deleteMany({ where: { sessionId: { in: ids } } }),
      prisma.userSession.deleteMany({ where: { id: { in: ids } } }),
    ]);

    for (const file of files) if (isMediaFileName(file)) await deleteMediaFile(file);

    // Deleted rows stay readable in the file until it is rewritten.
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
    await prisma.$executeRawUnsafe('VACUUM;');
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');

    clearMediaJobsFor(targets);
    clearMediaCachesFor(targets);

    const result: EraseResult = { unlinked, notConfirmed, erasedAt: new Date().toISOString() };
    console.log(
      `[erase] done: ${ids.length} session(s), ${files.size} file(s); ${unlinked} unlinked, ${notConfirmed} not confirmed by WhatsApp`,
    );
    for (const id of ids) emitToSession(id, 'data_erased', result);
    return result;
  } finally {
    sessions.finishErase(targets);
    dispatcher.releaseSessions(targets);
    for (const id of ids) inProgress.delete(id);
  }
}
