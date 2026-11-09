// Pacing presets. The dispatcher follows these exactly; the UI uses the same numbers for estimates.
//
// Careful   — one message at a time with a long random gap (the original behaviour).
// Balanced  — short bursts of a few messages, then a rest.
// Fast      — quicker bursts, then a rest.
//
// No pacing makes automation invisible to WhatsApp. Restrictions mostly come from recipients
// reporting or blocking unexpected messages, so faster presets finish sooner but raise the risk.

export type PacingMode = 'careful' | 'balanced' | 'fast';

export interface PacingProfile {
  label: string;
  summary: string;
  /** "typing…" shown before each message */
  typingMinMs: number;
  typingMaxMs: number;
  /** gap between messages inside a burst (or between every message when bursts are off) */
  gapMinMs: number;
  gapMaxMs: number;
  /** messages per burst; 0 = no bursts */
  burstMin: number;
  burstMax: number;
  /** rest after each burst */
  restMinMs: number;
  restMaxMs: number;
  /** longer break every N messages */
  longRestEvery: number;
  longRestMs: number;
}

export const PACING_PROFILES: Record<PacingMode, PacingProfile> = {
  careful: {
    label: 'Careful',
    summary: 'One by one, 8–18 s apart, 1-minute break every 25. Lowest risk.',
    typingMinMs: 2_000,
    typingMaxMs: 3_500,
    gapMinMs: 8_000,
    gapMaxMs: 18_000,
    burstMin: 0,
    burstMax: 0,
    restMinMs: 0,
    restMaxMs: 0,
    longRestEvery: 25,
    longRestMs: 60_000,
  },
  balanced: {
    label: 'Balanced',
    summary: 'Bursts of 3–5 messages 3–6 s apart, then a 20–40 s rest; 90 s break every 40.',
    typingMinMs: 1_500,
    typingMaxMs: 3_000,
    gapMinMs: 3_000,
    gapMaxMs: 6_000,
    burstMin: 3,
    burstMax: 5,
    restMinMs: 20_000,
    restMaxMs: 40_000,
    longRestEvery: 40,
    longRestMs: 90_000,
  },
  fast: {
    label: 'Fast',
    summary: 'Bursts of 3–6 messages 2–4 s apart, then a 20–45 s rest; 90 s break every 50. Highest risk.',
    typingMinMs: 1_000,
    typingMaxMs: 2_000,
    gapMinMs: 2_000,
    gapMaxMs: 4_000,
    burstMin: 3,
    burstMax: 6,
    restMinMs: 20_000,
    restMaxMs: 45_000,
    longRestEvery: 50,
    longRestMs: 90_000,
  },
};

export const PACING_MODES = Object.keys(PACING_PROFILES) as PacingMode[];

export function isPacingMode(value: unknown): value is PacingMode {
  return typeof value === 'string' && value in PACING_PROFILES;
}

/** Rough network/encryption overhead per message, for estimates only (attachments upload once). */
const SEND_OVERHEAD_MS = 1_000;

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export type EstimateMode = 'min' | 'avg' | 'max';

/** Estimated wall-clock time to dispatch `count` messages with a pacing preset. */
export function estimateDurationMs(count: number, pacing: PacingMode = 'careful', mode: EstimateMode = 'avg'): number {
  if (count <= 0) return 0;
  const p = PACING_PROFILES[pacing];
  const pick = (min: number, max: number): number => (mode === 'min' ? min : mode === 'max' ? max : (min + max) / 2);

  const perMessage = pick(p.typingMinMs, p.typingMaxMs) + SEND_OVERHEAD_MS;
  const gaps = count - 1;
  const longRests = Math.floor(gaps / p.longRestEvery);
  // Bigger bursts mean fewer rests, so the fastest case uses the largest burst.
  const burst = p.burstMax > 0 ? (mode === 'min' ? p.burstMax : mode === 'max' ? p.burstMin : (p.burstMin + p.burstMax) / 2) : 0;
  const rests = burst > 0 ? Math.max(0, Math.floor(gaps / burst) - longRests) : 0;
  const plainGaps = Math.max(0, gaps - longRests - rests);

  return (
    count * perMessage +
    plainGaps * pick(p.gapMinMs, p.gapMaxMs) +
    rests * pick(p.restMinMs, p.restMaxMs) +
    longRests * p.longRestMs
  );
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
