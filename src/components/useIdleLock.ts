'use client';

import { useEffect, useRef } from 'react';
import { authApi } from '@/lib/api';

/** Lock after this long with no mouse, keyboard, touch or scroll activity. */
export const AUTO_LOCK_MS = 15 * 60_000;
/** While active, refresh the server-side idle timer at most this often. */
const PING_EVERY_MS = 4 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Auto-lock on inactivity. Also keeps the server's (longer) idle timer alive while the person
 * is actually using the page, so an active session never expires underneath them.
 */
export function useIdleLock(onLock: () => void): void {
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  useEffect(() => {
    const markActive = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastPing.current > PING_EVERY_MS) {
        lastPing.current = now;
        authApi.ping().catch(() => undefined); // a 401 here triggers the lock screen via the api helper
      }
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, markActive, { passive: true });

    const check = () => {
      if (Date.now() - lastActivity.current >= AUTO_LOCK_MS) onLockRef.current();
    };
    const timer = setInterval(check, 15_000);
    // Laptops that slept past the limit should lock as soon as the tab is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, markActive);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
