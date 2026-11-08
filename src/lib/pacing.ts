// Anti-ban pacing rules. The dispatcher enforces these; the UI uses them for time estimates.

export const PACING = {
  /** Random gap between two recipients. */
  jitterMinMs: 8_000,
  jitterMaxMs: 18_000,
  /** How long the "typing…" indicator is shown before each message. */
  typingMinMs: 2_000,
  typingMaxMs: 3_500,
  /** After this many dispatched messages, take a longer break. */
  cooldownEvery: 25,
  cooldownMs: 60_000,
  /** Rough network/upload overhead per message used only for estimates. */
  sendOverheadMs: 1_000,
} as const;

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export type EstimateMode = 'min' | 'avg' | 'max';

/** Estimated wall-clock time to dispatch `count` messages back to back. */
export function estimateDurationMs(count: number, mode: EstimateMode = 'avg'): number {
  if (count <= 0) return 0;
  const pick = (min: number, max: number): number =>
    mode === 'min' ? min : mode === 'max' ? max : (min + max) / 2;

  const perMessage = pick(PACING.typingMinMs, PACING.typingMaxMs) + PACING.sendOverheadMs;
  const jitter = pick(PACING.jitterMinMs, PACING.jitterMaxMs);
  const gaps = count - 1;
  const cooldowns = Math.floor(gaps / PACING.cooldownEvery);

  return count * perMessage + (gaps - cooldowns) * jitter + cooldowns * PACING.cooldownMs;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
