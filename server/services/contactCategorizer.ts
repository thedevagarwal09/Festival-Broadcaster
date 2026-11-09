/**
 * Intelligent contact categorisation → three smart groups.
 *
 *   ⚡ Frequent Chats    two-way conversation within the last N days (default 45), or the top P%
 *                        (default 15%) of contacts by activity score (message count × recency).
 *   💬 Chatted Before    any existing 1-on-1 chat thread or message, but not frequent.
 *   📇 Never Chatted     address-book contacts with no chat at all. Kept apart on purpose:
 *                        messaging cold contacts in bulk is the fastest way to get banned.
 *
 * Inputs are the counters in ChatActivity (see chatActivity.ts) — no message content.
 */
import { prisma } from '../db';
import type { SmartCategory, SmartGroupsAnalysis, SmartGroupSettings } from '../../src/lib/types';

export const SMART_GROUP_NAMES: Record<SmartCategory, string> = {
  frequent: '⚡ Frequent Chats',
  chatted: '💬 Chatted Before',
  cold: '📇 Never Chatted / Cold Contacts',
};

export const DEFAULT_SMART_SETTINGS: SmartGroupSettings = { recentDays: 45, topPercent: 15 };

const DAY = 24 * 3600_000;

export function readSmartSettings(input: unknown): SmartGroupSettings {
  const body = (input ?? {}) as Record<string, unknown>;
  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    recentDays: clamp(body.recentDays, 7, 180, DEFAULT_SMART_SETTINGS.recentDays),
    topPercent: clamp(body.topPercent, 1, 50, DEFAULT_SMART_SETTINGS.topPercent),
  };
}

interface Engagement {
  contactId: string;
  name: string;
  messagesIn: number;
  messagesOut: number;
  hasThread: boolean;
  lastAt: Date | null;
}

const latest = (...dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((acc, d) => (d && (!acc || d > acc) ? d : acc), null);

/** Recency weight: recent conversations count fully, old ones fade. */
function recencyWeight(lastAt: Date | null, now: number, recentDays: number): number {
  if (!lastAt) return 0.05;
  const age = now - lastAt.getTime();
  if (age <= recentDays * DAY) return 1;
  if (age <= 90 * DAY) return 0.5;
  if (age <= 365 * DAY) return 0.2;
  return 0.05;
}

export async function analyzeContacts(
  sessionId: string,
  settings: SmartGroupSettings = DEFAULT_SMART_SETTINGS,
): Promise<SmartGroupsAnalysis & { members: Record<SmartCategory, Array<{ id: string; lastAt: Date | null }>> }> {
  const now = Date.now();
  const [contacts, activity, session] = await Promise.all([
    prisma.contact.findMany({
      where: { sessionId },
      select: { id: true, jid: true, lid: true, name: true, pushName: true, phone: true },
    }),
    prisma.chatActivity.findMany({ where: { sessionId } }),
    prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { historyImportedAt: true, categorizedAt: true },
    }),
  ]);

  // Chats may be keyed by phone JID or by privacy id (LID); map both to the contact.
  const byJid = new Map(contacts.map((c) => [c.jid, c]));
  const byLid = new Map(contacts.filter((c) => c.lid).map((c) => [c.lid as string, c]));
  const engagement = new Map<string, Engagement>(
    contacts.map((c) => [
      c.id,
      { contactId: c.id, name: c.name ?? c.pushName ?? c.phone, messagesIn: 0, messagesOut: 0, hasThread: false, lastAt: null },
    ]),
  );

  let matchedChats = 0;
  let unmatchedLidChats = 0;
  for (const a of activity) {
    const contact = byJid.get(a.jid) ?? byLid.get(a.jid);
    if (!contact) {
      // Either someone not in your contacts, or a privacy-id chat not linked to a contact yet.
      if (a.jid.endsWith('@lid')) unmatchedLidChats += 1;
      continue;
    }
    matchedChats += 1;
    const e = engagement.get(contact.id)!;
    e.messagesIn += a.messagesIn;
    e.messagesOut += a.messagesOut;
    e.hasThread = e.hasThread || a.hasThread;
    e.lastAt = latest(e.lastAt, a.lastInAt, a.lastOutAt, a.threadAt);
  }

  const all = [...engagement.values()];
  const withChat = all.filter((e) => e.hasThread || e.messagesIn + e.messagesOut > 0);
  const recentCutoff = now - settings.recentDays * DAY;

  const frequent = new Set<string>();
  // Rule 1: a real two-way conversation recently.
  for (const e of withChat) {
    if (e.messagesIn > 0 && e.messagesOut > 0 && e.lastAt && e.lastAt.getTime() >= recentCutoff) frequent.add(e.contactId);
  }
  // Rule 2: the most active slice of everyone you've messaged with.
  const scored = withChat
    .filter((e) => e.messagesIn + e.messagesOut > 0)
    .map((e) => ({ e, score: (e.messagesIn + e.messagesOut) * recencyWeight(e.lastAt, now, settings.recentDays) }))
    .sort((a, b) => b.score - a.score);
  const topCount = scored.length > 0 ? Math.max(1, Math.ceil((withChat.length * settings.topPercent) / 100)) : 0;
  for (const { e } of scored.slice(0, topCount)) frequent.add(e.contactId);

  const members: Record<SmartCategory, Array<{ id: string; lastAt: Date | null }>> = { frequent: [], chatted: [], cold: [] };
  for (const e of all) {
    const key: SmartCategory = frequent.has(e.contactId)
      ? 'frequent'
      : e.hasThread || e.messagesIn + e.messagesOut > 0
        ? 'chatted'
        : 'cold';
    members[key].push({ id: e.contactId, lastAt: e.lastAt });
  }

  const topFrequent = scored
    .filter(({ e }) => frequent.has(e.contactId))
    .slice(0, 5)
    .map(({ e }) => e.name);

  return {
    settings,
    counts: { frequent: members.frequent.length, chatted: members.chatted.length, cold: members.cold.length },
    total: all.length,
    coverage: {
      historyImportedAt: session?.historyImportedAt ? session.historyImportedAt.toISOString() : null,
      chatsKnown: activity.length,
      chatsMatched: matchedChats,
      unmatchedPrivacyIdChats: unmatchedLidChats,
    },
    categorizedAt: session?.categorizedAt ? session.categorizedAt.toISOString() : null,
    sampleFrequent: topFrequent,
    members,
  };
}

/** One click: compute categories, then create/refresh the three smart groups and tag each contact. */
export async function applySmartGroups(sessionId: string, settings: SmartGroupSettings): Promise<SmartGroupsAnalysis> {
  const analysis = await analyzeContacts(sessionId, settings);
  const { members, ...summary } = analysis;

  for (const key of Object.keys(SMART_GROUP_NAMES) as SmartCategory[]) {
    let group = await prisma.contactGroup.findFirst({ where: { sessionId, smartKey: key } });
    if (!group) {
      // Avoid clashing with a hand-made group of the same name.
      const taken = await prisma.contactGroup.findFirst({ where: { sessionId, name: SMART_GROUP_NAMES[key] } });
      group = await prisma.contactGroup.create({
        data: { sessionId, smartKey: key, name: taken ? `${SMART_GROUP_NAMES[key]} (smart)` : SMART_GROUP_NAMES[key] },
      });
    }
    await prisma.contactGroup.update({
      where: { id: group.id },
      data: { contacts: { set: members[key].map((m) => ({ id: m.id })) } },
    });

    // Tag contacts so any group (not just smart ones) can warn about cold recipients.
    const ids = members[key].map((m) => m.id);
    for (let i = 0; i < ids.length; i += 500) {
      await prisma.contact.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { chatCategory: key } });
    }
    const dated = members[key].filter((m) => m.lastAt);
    for (let i = 0; i < dated.length; i += 300) {
      await prisma.$transaction(
        dated.slice(i, i + 300).map((m) => prisma.contact.update({ where: { id: m.id }, data: { lastChatAt: m.lastAt } })),
      );
    }
  }

  const categorizedAt = new Date();
  await prisma.userSession.update({ where: { id: sessionId }, data: { categorizedAt } });
  console.log(
    `[smart-groups:${sessionId}] frequent=${summary.counts.frequent} chatted=${summary.counts.chatted} cold=${summary.counts.cold}`,
  );
  return { ...summary, categorizedAt: categorizedAt.toISOString() };
}
