/**
 * Links privacy-id chats (…@lid) to saved contacts.
 *
 * Chat activity is often keyed by privacy id, while the address book is keyed by phone number.
 * When a chat's privacy id isn't linked to any contact, look up the privacy ids of contacts that
 * don't have one yet using WhatsApp's normal contact lookup (`onWhatsApp`), in small batches.
 * Contacts are only looked up once (`lidCheckedAt`), and the run stops as soon as every unmatched
 * chat is resolved or the time budget runs out.
 */
import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';
import { prisma } from '../db';
import { errorMessage } from '../utils/errors';
import { sleep } from '../utils/sleep';

const BATCH = 50;
const PAUSE_MS = 1_500;

const running = new Map<string, Promise<LidResolveResult>>();

export interface LidResolveResult {
  /** Privacy-id chats with no matching contact before and after this run. */
  unmatchedBefore: number;
  unmatchedAfter: number;
  /** Contacts looked up in this run. */
  checked: number;
}

/** Privacy ids that have chat activity but no contact linked to them yet. */
export async function unmatchedLids(sessionId: string): Promise<Set<string>> {
  const rows = await prisma.chatActivity.findMany({
    where: { sessionId, jid: { endsWith: '@lid' } },
    select: { jid: true },
  });
  if (rows.length === 0) return new Set();
  const known = await prisma.contact.findMany({
    where: { sessionId, lid: { in: rows.map((r) => r.jid) } },
    select: { lid: true },
  });
  const knownSet = new Set(known.map((k) => k.lid));
  return new Set(rows.map((r) => r.jid).filter((jid) => !knownSet.has(jid)));
}

export function resolveLids(sessionId: string, sock: WASocket, budgetMs: number): Promise<LidResolveResult> {
  const existing = running.get(sessionId);
  if (existing) return existing;
  const run = (async (): Promise<LidResolveResult> => {
    const unmatched = await unmatchedLids(sessionId);
    const result: LidResolveResult = { unmatchedBefore: unmatched.size, unmatchedAfter: unmatched.size, checked: 0 };
    if (unmatched.size === 0) return result;

    const deadline = Date.now() + budgetMs;
    // Saved (named) contacts first: they're the ones that matter for categories.
    const candidates = await prisma.contact.findMany({
      where: { sessionId, lid: null, lidCheckedAt: null },
      select: { id: true, jid: true },
      orderBy: [{ name: { sort: 'asc', nulls: 'last' } }],
    });

    for (let i = 0; i < candidates.length && unmatched.size > 0 && Date.now() < deadline; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      let found: Array<{ jid: string; lid?: unknown }> = [];
      try {
        found = (await sock.onWhatsApp(...batch.map((c) => c.jid))) ?? [];
      } catch (err) {
        console.warn(`[lid:${sessionId}] lookup failed:`, errorMessage(err));
        break; // likely disconnected; try again on the next connect
      }
      const lidByJid = new Map<string, string>();
      for (const f of found) {
        if (typeof f.lid !== 'string' || !f.lid.endsWith('@lid')) continue;
        try {
          lidByJid.set(jidNormalizedUser(f.jid), jidNormalizedUser(f.lid));
        } catch {
          // ignore malformed ids
        }
      }
      const now = new Date();
      await prisma.$transaction(
        batch.map((c) =>
          prisma.contact.update({
            where: { id: c.id },
            data: { lidCheckedAt: now, ...(lidByJid.has(c.jid) ? { lid: lidByJid.get(c.jid) } : {}) },
          }),
        ),
      );
      for (const lid of lidByJid.values()) unmatched.delete(lid);
      result.checked += batch.length;
      if (unmatched.size > 0) await sleep(PAUSE_MS);
    }

    result.unmatchedAfter = unmatched.size;
    console.log(
      `[lid:${sessionId}] looked up ${result.checked} contacts; unmatched privacy-id chats ${result.unmatchedBefore} → ${result.unmatchedAfter}`,
    );
    return result;
  })().finally(() => running.delete(sessionId));
  running.set(sessionId, run);
  return run;
}
