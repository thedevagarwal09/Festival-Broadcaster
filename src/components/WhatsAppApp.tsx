'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dashboard } from './Dashboard';
import { QrLogin } from './QrLogin';
import { ThemeToggle } from './ThemeToggle';
import { api } from '@/lib/api';
import { getOrCreateSessionId, rotateSessionId } from '@/lib/session-id';
import { getSocket } from '@/lib/socket';
import type { SessionSnapshot, SessionUser } from '@/lib/types';

export function WhatsAppApp() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [qr, setQr] = useState<{ qr: string; attempt: number } | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [slowConnect, setSlowConnect] = useState(false);

  // If the live connection hasn't come up after 10 s, show a troubleshooting hint.
  useEffect(() => {
    if (socketConnected) {
      setSlowConnect(false);
      return;
    }
    const timer = setTimeout(() => setSlowConnect(true), 10_000);
    return () => clearTimeout(timer);
  }, [socketConnected]);

  useEffect(() => {
    const id = getOrCreateSessionId();
    sessionRef.current = id;
    setSessionId(id);
  }, []);

  /** Switch to a brand-new isolated session, but only if we're still on the one that ended. */
  const rotateFrom = useCallback((expected: string) => {
    if (sessionRef.current !== expected) return;
    const id = rotateSessionId();
    sessionRef.current = id;
    setSnapshot(null);
    setQr(null);
    setSessionId(id);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();

    const join = () => {
      setSocketConnected(true);
      setError(null);
      socket.emit('init_session', { sessionId });
    };
    const onDisconnect = () => setSocketConnected(false);
    const onStatus = (next: SessionSnapshot) => {
      if (next.sessionId !== sessionId) return;
      setSnapshot(next);
      if (next.status === 'qr' && next.qr) {
        setQr({ qr: next.qr, attempt: next.qrAttempt });
      } else if (next.status !== 'qr') {
        setQr(null);
      }
    };
    const onQr = (payload: { sessionId: string; qr: string; attempt: number }) => {
      if (payload.sessionId !== sessionId) return;
      setQr({ qr: payload.qr, attempt: payload.attempt });
    };
    const onConnected = (user: SessionUser & { sessionId: string }) => {
      if (user.sessionId !== sessionId) return;
      setSnapshot((prev) =>
        prev ? { ...prev, status: 'connected', user, qr: null } : { sessionId, status: 'connected', user, qr: null, qrAttempt: 0 },
      );
      setQr(null);
    };
    const onLoggedOut = (payload: { sessionId: string }) => rotateFrom(payload.sessionId);
    const onError = (payload: { message: string }) => setError(payload.message);

    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('session_status', onStatus);
    socket.on('qr_code', onQr);
    socket.on('session_connected', onConnected);
    socket.on('session_logged_out', onLoggedOut);
    socket.on('session_error', onError);
    if (socket.connected) join();

    return () => {
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
      socket.off('session_status', onStatus);
      socket.off('qr_code', onQr);
      socket.off('session_connected', onConnected);
      socket.off('session_logged_out', onLoggedOut);
      socket.off('session_error', onError);
    };
  }, [sessionId, rotateFrom]);

  const refresh = useCallback(() => {
    if (sessionId) getSocket().emit('refresh_qr', { sessionId });
  }, [sessionId]);

  const logout = useCallback(async () => {
    if (!sessionId) return;
    await api.logout(sessionId);
    rotateFrom(sessionId); // no-op if the socket event already rotated us
  }, [sessionId, rotateFrom]);

  if (!sessionId || !snapshot) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <ThemeToggle className="absolute right-4 top-4 md:right-6 md:top-6" />
        <div className="flex items-center gap-3 text-stone-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          {socketConnected ? 'Preparing your WhatsApp session…' : 'Connecting to the server…'}
        </div>
        {slowConnect && !socketConnected && (
          <p className="max-w-md text-sm text-stone-500">
            This is taking longer than usual. Check that the server is running and that this address
            reaches it. If you use a reverse proxy, make sure it forwards the <code>/socket.io</code> path.
          </p>
        )}
        {error && <p className="fixed bottom-6 rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}
      </main>
    );
  }

  const showDashboard = snapshot.user !== null && snapshot.status !== 'qr' && snapshot.status !== 'logged_out';

  return showDashboard ? (
    <Dashboard
      sessionId={sessionId}
      snapshot={snapshot}
      socketConnected={socketConnected}
      onLogout={logout}
      onReconnect={refresh}
    />
  ) : (
    <QrLogin
      snapshot={snapshot}
      qr={qr}
      socketConnected={socketConnected}
      error={error}
      onRefresh={refresh}
    />
  );
}
