'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PinScreen } from '@/components/PinScreen';
import { WhatsAppApp } from '@/components/WhatsAppApp';
import { AUTH_REQUIRED_EVENT, authApi } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';

type AuthState = 'checking' | 'setup' | 'locked' | 'unlocked' | 'offline';

/** PIN gate: nothing that touches WhatsApp or your data loads until the app is unlocked. */
export default function HomePage() {
  const [state, setState] = useState<AuthState>('checking');

  const checkStatus = useCallback(() => {
    authApi
      .status()
      .then((s) => setState(!s.pinSet ? 'setup' : s.authenticated ? 'unlocked' : 'locked'))
      .catch(() => setState('offline'));
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Any 401 (expired session, PIN changed in another tab, server restarted) shows the lock screen.
  useEffect(() => {
    const onAuthRequired = () => {
      disconnectSocket();
      setState((s) => (s === 'setup' ? s : 'locked'));
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const lock = useCallback(() => {
    disconnectSocket();
    setState('locked');
    authApi.logout().catch(() => undefined);
  }, []);

  const unlocked = useCallback(() => setState('unlocked'), []);

  if (state === 'checking' || state === 'offline') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 text-stone-500">
        {state === 'checking' ? (
          <span className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin" /> Connecting to local server…
          </span>
        ) : (
          <>
            <p>The local server isn’t responding. Make sure “npm run dev” is running.</p>
            <button type="button" className="btn-secondary" onClick={checkStatus}>
              Try again
            </button>
          </>
        )}
      </main>
    );
  }
  if (state === 'setup') return <PinScreen mode="setup" onUnlocked={unlocked} />;
  if (state === 'locked') return <PinScreen key="unlock" mode="unlock" onUnlocked={unlocked} />;
  return <WhatsAppApp onLock={lock} />;
}
