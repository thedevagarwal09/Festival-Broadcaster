import type { QuietHoursSettings } from './types';

type Window = Pick<QuietHoursSettings, 'enabled' | 'start' | 'end' | 'timeZone'>;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Minutes past midnight of `date` in the given IANA time zone (the server's). */
function minutesInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** Same rule as the server: windows may cross midnight (23:00 → 07:00). */
export function isQuietAt(date: Date, q: Window): boolean {
  if (!q.enabled) return false;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  const now = minutesInZone(date, q.timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Whether a run starting at `start` and lasting `durationMs` would touch quiet hours. */
export function runTouchesQuietHours(start: Date, durationMs: number, q: Window): boolean {
  if (!q.enabled) return false;
  const step = 5 * 60_000;
  for (let t = start.getTime(); t <= start.getTime() + durationMs; t += step) {
    if (isQuietAt(new Date(t), q)) return true;
  }
  return false;
}

/** "23:00–07:00 (Asia/Kolkata)" */
export function describeWindow(q: Window): string {
  return `${q.start}–${q.end} (${q.timeZone})`;
}

/** Value for <input type="datetime-local"> in the browser's own time zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
