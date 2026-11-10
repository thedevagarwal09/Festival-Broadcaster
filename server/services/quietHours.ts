import { prisma } from '../db';
import type { QuietHoursSettings } from '../../src/lib/types';

const KEY = 'quietHours';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type StoredQuietHours = Pick<QuietHoursSettings, 'enabled' | 'start' | 'end'>;

const DEFAULTS: StoredQuietHours = { enabled: true, start: '23:00', end: '07:00' };

let cache: StoredQuietHours | null = null;

/** Back to the defaults on the next read (used by Erase all). */
export function resetQuietHoursCache(): void {
  cache = null;
}

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

export async function loadQuietHours(): Promise<StoredQuietHours> {
  if (cache) return cache;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  let value = DEFAULTS;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<StoredQuietHours>;
      value = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        start: typeof parsed.start === 'string' && TIME_RE.test(parsed.start) ? parsed.start : DEFAULTS.start,
        end: typeof parsed.end === 'string' && TIME_RE.test(parsed.end) ? parsed.end : DEFAULTS.end,
      };
    } catch {
      value = DEFAULTS;
    }
  }
  cache = value;
  return value;
}

export async function getQuietHoursSettings(): Promise<QuietHoursSettings> {
  const q = await loadQuietHours();
  return { ...q, timeZone: serverTimeZone(), activeNow: isWithinQuietHours(new Date(), q) };
}

/** Validate and save. Throws an Error with a readable message on bad input. */
export async function saveQuietHours(input: unknown): Promise<QuietHoursSettings> {
  const body = (input ?? {}) as Record<string, unknown>;
  const enabled = body.enabled === true;
  const start = typeof body.start === 'string' ? body.start : '';
  const end = typeof body.end === 'string' ? body.end : '';
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new Error('Use 24-hour times like 23:00 and 07:00.');
  if (enabled && start === end) throw new Error('Start and end must be different.');
  const value: StoredQuietHours = { enabled, start, end };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
  cache = value;
  return getQuietHoursSettings();
}

export async function isQuietNow(): Promise<boolean> {
  return isWithinQuietHours(new Date(), await loadQuietHours());
}

export async function describeQuietHours(): Promise<string> {
  const q = await loadQuietHours();
  return `${q.start}–${q.end}`;
}

/** "07:00" — when sending resumes after the current quiet window. */
export async function quietHoursEnd(): Promise<string> {
  return (await loadQuietHours()).end;
}
