import { prisma } from '../db';

const CHUNK = 500;

export interface MergeResult {
  mergedSessions: number;
  movedContacts: number;
  movedGroups: number;
  movedCampaigns: number;
}

/**
 * Data is keyed by the browser's session id, but a new id is issued every time an account is
 * unlinked and linked again. When a session connects, fold every *inactive* earlier session that
 * belongs to the same WhatsApp number into it, so groups, contacts and campaign history follow
 * the phone number instead of being orphaned.
 *
 * - Contacts are matched by JID. Duplicates keep the current row (filling in any missing name).
 * - Groups move across with their memberships remapped; clashing names get a " (2)" suffix.
 * - Campaigns (and their queue items) move across unchanged.
 */
export async function mergePreviousSessions(
  sessionId: string,
  phoneNumber: string,
  isActive: (id: string) => boolean,
): Promise<MergeResult> {
  const result: MergeResult = { mergedSessions: 0, movedContacts: 0, movedGroups: 0, movedCampaigns: 0 };

  const previous = await prisma.userSession.findMany({
    where: { phoneNumber, id: { not: sessionId } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  for (const { id: oldId } of previous) {
    // Two browsers can be linked as separate devices of the same phone — never steal from a live one.
    if (isActive(oldId)) continue;

    await prisma.$transaction(
      async (tx) => {
        const current = await tx.contact.findMany({
          where: { sessionId },
          select: { id: true, jid: true, name: true, pushName: true },
        });
        const currentByJid = new Map(current.map((c) => [c.jid, c]));
        const oldContacts = await tx.contact.findMany({
          where: { sessionId: oldId },
          select: { id: true, jid: true, name: true, pushName: true },
        });

        /** old contact id → id of the row that survives in the current session */
        const survivorId = new Map<string, string>();
        const toMove: string[] = [];
        for (const oc of oldContacts) {
          const existing = currentByJid.get(oc.jid);
          if (!existing) {
            toMove.push(oc.id);
            survivorId.set(oc.id, oc.id);
            continue;
          }
          survivorId.set(oc.id, existing.id);
          const fill = {
            ...(!existing.name && oc.name ? { name: oc.name } : {}),
            ...(!existing.pushName && oc.pushName ? { pushName: oc.pushName } : {}),
          };
          if (Object.keys(fill).length > 0) {
            await tx.contact.update({ where: { id: existing.id }, data: fill });
          }
        }
        for (let i = 0; i < toMove.length; i += CHUNK) {
          await tx.contact.updateMany({
            where: { id: { in: toMove.slice(i, i + CHUNK) } },
            data: { sessionId },
          });
        }

        const oldGroups = await tx.contactGroup.findMany({
          where: { sessionId: oldId },
          include: { contacts: { select: { id: true } } },
        });
        for (const group of oldGroups) {
          let name = group.name;
          for (let n = 2; await tx.contactGroup.findFirst({ where: { sessionId, name } }); n += 1) {
            name = `${group.name} (${n})`;
          }
          const memberIds = [...new Set(group.contacts.map((c) => survivorId.get(c.id) ?? c.id))];
          await tx.contactGroup.update({
            where: { id: group.id },
            data: { sessionId, name, contacts: { set: memberIds.map((id) => ({ id })) } },
          });
        }

        const campaigns = await tx.broadcastCampaign.updateMany({
          where: { sessionId: oldId },
          data: { sessionId },
        });

        // Remaining rows are duplicates of contacts the current session already has.
        await tx.userSession.delete({ where: { id: oldId } });

        result.mergedSessions += 1;
        result.movedContacts += toMove.length;
        result.movedGroups += oldGroups.length;
        result.movedCampaigns += campaigns.count;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }

  return result;
}
