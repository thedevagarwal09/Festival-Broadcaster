import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const AUTH_COOKIE = 'fb_auth';

/** Server-side idle expiry. The browser locks itself sooner (15 min) and pings while you're active. */
export const IDLE_TIMEOUT_MS = 20 * 60_000;
/** Hard cap on how long one unlock lasts, even with constant activity. */
export const MAX_SESSION_MS = 12 * 60 * 60_000;

/** Wrong PINs allowed before the first lockout. */
const FREE_ATTEMPTS = 5;
const FIRST_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

interface TokenEntry {
  createdAt: number;
  lastSeen: number;
}

export interface FailureResult {
  /** > 0 when this failure triggered a lockout. */
  lockMs: number;
  /** Wrong PINs left before the next lockout. */
  attemptsLeft: number;
}

/**
 * Unlocked browser sessions, kept in memory only: restarting the server locks everyone out.
 * Tokens are 256-bit random values sent as an HttpOnly, SameSite=Strict cookie.
 */
export class AuthStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly revokeListeners: Array<(token: string | null) => void> = [];
  private failures = 0;
  private lockedUntil = 0;

  issue(): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.tokens.set(token, { createdAt: now, lastSeen: now });
    return token;
  }

  /** True when the token is live. `touch` slides the idle timer forward. */
  validate(token: string | undefined | null, touch = true): boolean {
    if (!token) return false;
    const entry = this.tokens.get(token);
    if (!entry) return false;
    const now = Date.now();
    if (now - entry.lastSeen > IDLE_TIMEOUT_MS || now - entry.createdAt > MAX_SESSION_MS) {
      this.tokens.delete(token);
      return false;
    }
    if (touch) entry.lastSeen = now;
    return true;
  }

  revoke(token: string | undefined | null): void {
    if (!token || !this.tokens.delete(token)) return;
    for (const fn of this.revokeListeners) fn(token);
  }

  /** Revoke every session, optionally keeping one (used after a PIN change). */
  revokeAll(except?: string): void {
    for (const token of [...this.tokens.keys()]) {
      if (token !== except) this.tokens.delete(token);
    }
    for (const fn of this.revokeListeners) fn(null);
  }

  onRevoke(fn: (token: string | null) => void): void {
    this.revokeListeners.push(fn);
  }

  /** Drop expired tokens; returns true if any were removed. */
  sweep(): boolean {
    let removed = false;
    for (const token of [...this.tokens.keys()]) {
      if (!this.validate(token, false)) removed = true;
    }
    return removed;
  }

  lockoutRemainingMs(): number {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  recordFailure(): FailureResult {
    this.failures += 1;
    if (this.failures < FREE_ATTEMPTS) {
      return { lockMs: 0, attemptsLeft: FREE_ATTEMPTS - this.failures };
    }
    // 5th wrong PIN → 30 s, then 60 s, 2 min, 4 min … up to 15 min per further mistake.
    const lockMs = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (this.failures - FREE_ATTEMPTS));
    this.lockedUntil = Date.now() + lockMs;
    return { lockMs, attemptsLeft: 0 };
  }

  recordSuccess(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function tokenFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[AUTH_COOKIE];
}

/** Set COOKIE_SECURE=true when the app is served over HTTPS (e.g. behind a reverse proxy). */
const SECURE = /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE ?? '') ? '; Secure' : '';

export function authCookie(token: string): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${SECURE}; Max-Age=${Math.floor(MAX_SESSION_MS / 1000)}`;
}

export function clearedAuthCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${SECURE}; Max-Age=0`;
}

/**
 * Reject cross-site requests. Browsers always send Origin on cross-origin fetches/form posts
 * and WebSocket handshakes; a request with no Origin is a same-origin GET or a non-browser tool.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
