'use client';

import { isValidSessionId } from './types';

const STORAGE_KEY = 'festival-broadcaster.sessionId';
/** Earlier session ids of this browser (a new one is issued after every unlink), for Erase my data. */
const PAST_KEY = 'festival-broadcaster.pastSessionIds';
const MAX_PAST = 20;

function readPast(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PAST_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(isValidSessionId) : [];
  } catch {
    return [];
  }
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts: RFC 4122 v4 from getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function store(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable (private mode) — the id simply won't survive a reload
  }
}

export function getOrCreateSessionId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (isValidSessionId(existing)) return existing;
  } catch {
    // ignore
  }
  const id = generateId();
  store(id);
  return id;
}

/** Every session id this browser has used, current one first (what "Erase my data" erases). */
export function browserSessionIds(current: string): string[] {
  return [...new Set([current, ...readPast()])].slice(0, MAX_PAST + 1);
}

/** Forget this browser's session ids (after Erase my data), so the next load starts fresh. */
export function forgetSessionId(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(PAST_KEY);
  } catch {
    // ignore
  }
}

/** Start a fresh, isolated session (used after logging out). */
export function rotateSessionId(): string {
  try {
    const previous = window.localStorage.getItem(STORAGE_KEY);
    if (isValidSessionId(previous)) {
      const past = [previous, ...readPast().filter((id) => id !== previous)].slice(0, MAX_PAST);
      window.localStorage.setItem(PAST_KEY, JSON.stringify(past));
    }
  } catch {
    // storage unavailable
  }
  const id = generateId();
  store(id);
  return id;
}
