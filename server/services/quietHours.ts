import { prisma } from '../db';
import type { QuietHoursSettings } from '../../src/lib/types';

/** Server-wide value from before quiet hours were per-person; now only the default. */
const LEGACY_KEY = 'quietHours';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type StoredQuietHours = Pick<QuietHoursSettings, 'enabled' | 'start' | 'end'>;

const DEFAULTS: StoredQuietHours = { enabled: true, start: '23:00', end: '07:00' };

let defaultCache: StoredQuietHours | null = null;

/** The server's time zone (Docker: the TZ variable). All quiet-hour times are in this zone. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `date` falls inside the window. Handles windows that cross midnight (23:00 → 07:00). */
export function isWithinQuietHours(date: Date, q: StoredQuietHours): boolean {
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function parseStored(raw: string | null | undefined): StoredQuietHours | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredQuietHours>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
      start: typeof parsed.start === 'string' && TIME_RE.test(parsed.start) ? parsed.start : DEFAULTS.start,
      end: typeof parsed.end === 'string' && TIME_RE.test(parsed.end) ? parsed.end : DEFAULTS.end,
    };
  } catch {
    return null;
  }
}

/**
 * Default for people who haven't set their own: 23:00–07:00, or the server-wide value saved
 * before quiet hours became per-person (kept so existing setups don't change).
 */
async function serverDefault(): Promise<StoredQuietHours> {
  if (defaultCache) return defaultCache;
  const row = await prisma.appSetting.findUnique({ where: { key: LEGACY_KEY } });
  defaultCache = parseStored(row?.value) ?? DEFAULTS;
  return defaultCache;
}

/** This person's quiet hours. Each WhatsApp session has its own; nobody can change anyone else's. */
export async function loadQuietHours(sessionId: string): Promise<StoredQuietHours> {
  const row = await prisma.userSession.findUnique({ where: { id: sessionId }, select: { quietHours: true } });
  return parseStored(row?.quietHours) ?? serverDefault();
}

export async function getQuietHoursSettings(sessionId: string): Promise<QuietHoursSettings> {
  const q = await loadQuietHours(sessionId);
  return { ...q, timeZone: serverTimeZone(), activeNow: isWithinQuietHours(new Date(), q) };
}

/** Validate and save for this person only. Throws an Error with a readable message on bad input. */
export async function saveQuietHours(sessionId: string, input: unknown): Promise<QuietHoursSettings> {
  const body = (input ?? {}) as Record<string, unknown>;
  const enabled = body.enabled === true;
  const start = typeof body.start === 'string' ? body.start : '';
  const end = typeof body.end === 'string' ? body.end : '';
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new Error('Use 24-hour times like 23:00 and 07:00.');
  if (enabled && start === end) throw new Error('Start and end must be different.');
  const value = JSON.stringify({ enabled, start, end } satisfies StoredQuietHours);
  await prisma.userSession.upsert({
    where: { id: sessionId },
    create: { id: sessionId, quietHours: value },
    update: { quietHours: value },
  });
  return getQuietHoursSettings(sessionId);
}

export async function isQuietNow(sessionId: string): Promise<boolean> {
  return isWithinQuietHours(new Date(), await loadQuietHours(sessionId));
}

export async function describeQuietHours(sessionId: string): Promise<string> {
  const q = await loadQuietHours(sessionId);
  return `${q.start}–${q.end}`;
}

/** "07:00" — when sending resumes after the current quiet window. */
export async function quietHoursEnd(sessionId: string): Promise<string> {
  return (await loadQuietHours(sessionId)).end;
}
