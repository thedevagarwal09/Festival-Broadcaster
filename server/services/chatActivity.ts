/**
 * Chat engagement tracking for smart groups.
 *
 * Sources:
 *   1. History sync — WhatsApp sends recent chats once, right after a phone is linked.
 *   2. Live messages — every message sent or received afterwards.
 *
 * Only per-chat counters and timestamps are stored; message text is never saved.
 * Messages sent by this app's broadcasts are excluded, so a campaign can never turn a
 * cold contact into a "chatted before" one.
 */
import { jidNormalizedUser, type Chat, type WAMessage } from '@whiskeysockets/baileys';
import { prisma } from '../db';
import { errorMessage } from '../utils/errors';

const CHUNK = 300;
/** Broadcast message ids we generated, remembered long enough for their echo events to arrive. */
const APP_ID_TTL_MS = 30 * 60_000;
/** Older broadcasts (before ids were recorded) are matched by recipient + send time within this window. */
const LEGACY_MATCH_MS = 2 * 60_000;
const SEEN_LIMIT = 200_000;

const appMessageIds = new Map<string, number>();
const seenBySession = new Map<string, Set<string>>();
const chains = new Map<string, Promise<void>>();

/** Call before sending a broadcast message with this id. */
export function registerAppMessageId(id: string): void {
  const now = Date.now();
  appMessageIds.set(id, now + APP_ID_TTL_MS);
  if (appMessageIds.size > 10_000) {
    for (const [k, exp] of appMessageIds) if (exp < now) appMessageIds.delete(k);
  }
}

function isAppMessageId(id: string | null | undefined): boolean {
  const exp = id ? appMessageIds.get(id) : undefined;
  return exp !== undefined && exp > Date.now();
}

/** Individual chats only (phone JID or privacy id), never groups, broadcasts, status or newsletters. */
function chatJid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let jid: string;
  try {
    jid = jidNormalizedUser(raw);
  } catch {
    return null;
  }
  return /^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
}

function toSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A real chat message (text, media, sticker, location…), not a reaction, receipt or protocol event. */
function isConversational(msg: WAMessage): boolean {
  const m = msg.message;
  if (!m || m.protocolMessage || m.reactionMessage || m.pollUpdateMessage) return false;
  return Object.keys(m).some((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
}

interface Delta {
  in: number;
  out: number;
  lastIn: number | null;
  lastOut: number | null;
  hasThread: boolean;
  threadAt: number | null;
}

const maxTs = (a: number | null, b: number | null): number | null => (a == null ? b : b == null ? a : Math.max(a, b));

function seenSet(sessionId: string): Set<string> {
  let set = seenBySession.get(sessionId);
  if (!set || set.size > SEEN_LIMIT) {
    set = new Set();
    seenBySession.set(sessionId, set);
  }
  return set;
}

/** Recipient → send times of this account's past broadcasts, to exclude them from history counts. */
async function loadBroadcastFingerprints(sessionId: string): Promise<{ ids: Set<string>; times: Map<string, number[]> }> {
  const items = await prisma.queueItem.findMany({
    where: { status: 'SENT', campaign: { sessionId } },
    select: { messageId: true, recipientJid: true, processedAt: true },
  });
  const ids = new Set<string>();
  const times = new Map<string, number[]>();
  for (const it of items) {
    if (it.messageId) ids.add(it.messageId);
    if (it.processedAt) {
      const list = times.get(it.recipientJid) ?? [];
      list.push(it.processedAt.getTime());
      times.set(it.recipientJid, list);
    }
  }
  return { ids, times };
}

function aggregate(
  messages: WAMessage[],
  ownJid: string | null,
  seen: Set<string>,
  broadcasts: { ids: Set<string>; times: Map<string, number[]> } | null,
): Map<string, Delta> {
  const deltas = new Map<string, Delta>();
  const get = (jid: string): Delta => {
    let d = deltas.get(jid);
    if (!d) {
      d = { in: 0, out: 0, lastIn: null, lastOut: null, hasThread: false, threadAt: null };
      deltas.set(jid, d);
    }
    return d;
  };
  for (const msg of messages) {
    const jid = chatJid(msg.key.remoteJid);
    if (!jid || jid === ownJid || !isConversational(msg)) continue;
    const id = msg.key.id ?? '';
    if (id) {
      const key = `${jid}|${id}`;
      if (seen.has(key)) continue; // history chunks and live events can overlap
      seen.add(key);
    }
    const ts = toSeconds(msg.messageTimestamp);
    if (msg.key.fromMe) {
      if (isAppMessageId(id) || broadcasts?.ids.has(id)) continue;
      const sentTimes = broadcasts?.times.get(jid);
      if (ts && sentTimes?.some((t) => Math.abs(t - ts * 1000) < LEGACY_MATCH_MS)) continue;
      const d = get(jid);
      d.out += 1;
      d.lastOut = maxTs(d.lastOut, ts);
    } else {
      const d = get(jid);
      d.in += 1;
      d.lastIn = maxTs(d.lastIn, ts);
    }
  }
  return deltas;
}

async function apply(sessionId: string, deltas: Map<string, Delta>): Promise<number> {
  const entries = [...deltas.entries()];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const existing = new Map(
      (
        await prisma.chatActivity.findMany({
          where: { sessionId, jid: { in: chunk.map(([jid]) => jid) } },
        })
      ).map((a) => [a.jid, a]),
    );
    const date = (s: number | null): Date | null => (s ? new Date(s * 1000) : null);
    const later = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a > b ? a : b);
    await prisma.$transaction(
      chunk.map(([jid, d]) => {
        const cur = existing.get(jid);
        const data = {
          messagesIn: (cur?.messagesIn ?? 0) + d.in,
          messagesOut: (cur?.messagesOut ?? 0) + d.out,
          lastInAt: later(cur?.lastInAt ?? null, date(d.lastIn)),
          lastOutAt: later(cur?.lastOutAt ?? null, date(d.lastOut)),
          hasThread: (cur?.hasThread ?? false) || d.hasThread,
          threadAt: later(cur?.threadAt ?? null, date(d.threadAt)),
        };
        return prisma.chatActivity.upsert({
          where: { sessionId_jid: { sessionId, jid } },
          create: { sessionId, jid, ...data },
          update: data,
        });
      }),
    );
  }
  return entries.length;
}

function enqueue(sessionId: string, work: () => Promise<void>): void {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  chains.set(
    sessionId,
    prev.then(work).catch((err: unknown) => console.error(`[activity:${sessionId}] failed:`, errorMessage(err))),
  );
}

/** One chunk of the post-link history sync: chat list + recent messages. */
export function recordHistory(sessionId: string, chats: Chat[], messages: WAMessage[], ownJid: string | null): void {
  enqueue(sessionId, async () => {
    const broadcasts = await loadBroadcastFingerprints(sessionId);
    const deltas = aggregate(messages, ownJid, seenSet(sessionId), broadcasts);
    for (const chat of chats) {
      const jid = chatJid(chat.id);
      if (!jid || jid === ownJid) continue;
      const d = deltas.get(jid) ?? { in: 0, out: 0, lastIn: null, lastOut: null, hasThread: false, threadAt: null };
      d.hasThread = true;
      d.threadAt = maxTs(d.threadAt, toSeconds(chat.conversationTimestamp));
      deltas.set(jid, d);
    }
    if (deltas.size === 0) return;
    const chatsTouched = await apply(sessionId, deltas);
    await prisma.userSession.update({ where: { id: sessionId }, data: { historyImportedAt: new Date() } });
    console.log(`[activity:${sessionId}] history: ${chats.length} chats, ${messages.length} messages → ${chatsTouched} contacts updated`);
  });
}

/** Messages sent or received while connected (broadcasts excluded). */
export function recordLive(sessionId: string, messages: WAMessage[], ownJid: string | null): void {
  enqueue(sessionId, async () => {
    const deltas = aggregate(messages, ownJid, seenSet(sessionId), null);
    for (const d of deltas.values()) d.hasThread = true;
    if (deltas.size > 0) await apply(sessionId, deltas);
  });
}
