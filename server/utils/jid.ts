import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { SessionUser } from '../../src/lib/types';

/** Individual (phone-number) WhatsApp user JIDs only — no groups, broadcasts, newsletters or LIDs. */
const PN_JID = /^\d{6,15}@s\.whatsapp\.net$/;

export function normalizePnJid(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let normalized: string;
  try {
    normalized = jidNormalizedUser(value);
  } catch {
    return null;
  }
  return PN_JID.test(normalized) ? normalized : null;
}

export function jidToPhone(jid: string): string {
  return `+${jid.split('@')[0]?.split(':')[0] ?? ''}`;
}

export function toSessionUser(rawJid: string, name: string | null): SessionUser {
  const jid = jidNormalizedUser(rawJid);
  return { jid, phoneNumber: jidToPhone(jid), name: name?.trim() || null };
}
