'use client';

/* eslint-disable @next/next/no-img-element */
import { Loader2, Lock, QrCode, RefreshCw, ShieldCheck, Smartphone, WifiOff } from 'lucide-react';
import type { SessionSnapshot } from '@/lib/types';

interface QrLoginProps {
  snapshot: SessionSnapshot;
  qr: { qr: string; attempt: number } | null;
  socketConnected: boolean;
  error: string | null;
  onRefresh: () => void;
  onLock: () => void;
}

const STEPS = [
  'Open WhatsApp on your phone',
  'Tap Menu (⋮) or Settings → Linked devices',
  'Tap “Link a device” and point your camera at this code',
];

export function QrLogin({ snapshot, qr, socketConnected, error, onRefresh, onLock }: QrLoginProps) {
  const expired = snapshot.status === 'idle' || snapshot.status === 'conflict';
  const waiting = !qr && !expired;

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6">
      <button type="button" className="btn-secondary absolute right-6 top-6" onClick={onLock}>
        <Lock className="h-4 w-4" /> Lock
      </button>
      <div className="card grid w-full max-w-4xl overflow-hidden md:grid-cols-2">
        <section className="flex flex-col justify-between bg-gradient-to-br from-diya-500 via-diya-600 to-rose-600 p-8 text-white">
          <div>
            <div className="mb-6 flex items-center gap-2 text-diya-100">
              <span className="text-2xl">🪔</span>
              <span className="text-sm font-semibold uppercase tracking-widest">Festival Broadcaster</span>
            </div>
            <h1 className="text-3xl font-bold leading-tight">Send warm festival wishes to everyone you love.</h1>
            <p className="mt-3 text-diya-100">
              Link your WhatsApp once. Everything runs on this computer — no paid APIs, no cloud.
            </p>
          </div>
          <ol className="mt-10 space-y-4">
            {STEPS.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">
                  {i + 1}
                </span>
                <span className="pt-0.5 text-sm">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-10 flex items-center gap-2 text-xs text-diya-100">
            <ShieldCheck className="h-4 w-4" /> Credentials are stored only in ./sessions on this machine.
          </p>
        </section>

        <section className="flex flex-col items-center justify-center gap-5 p-8">
          <div className="relative flex h-72 w-72 items-center justify-center rounded-2xl border-2 border-dashed border-stone-200 bg-white">
            {qr && !expired && <img src={qr.qr} alt="WhatsApp pairing QR code" className="h-64 w-64 rounded-lg" />}
            {waiting && (
              <div className="flex flex-col items-center gap-3 text-stone-500">
                <Loader2 className="h-8 w-8 animate-spin text-diya-500" />
                <span className="text-sm">
                  {snapshot.status === 'reconnecting' ? 'Reconnecting to WhatsApp…' : 'Generating QR code…'}
                </span>
              </div>
            )}
            {expired && (
              <div className="flex flex-col items-center gap-3 px-6 text-center text-stone-500">
                <QrCode className="h-10 w-10 text-stone-300" />
                <span className="text-sm">
                  {snapshot.status === 'conflict'
                    ? 'This account was opened in another WhatsApp Web client.'
                    : 'The QR code expired.'}
                </span>
                <button type="button" className="btn-primary" onClick={onRefresh}>
                  <RefreshCw className="h-4 w-4" /> Generate new code
                </button>
              </div>
            )}
          </div>

          {qr && !expired && (
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="flex items-center gap-2 text-sm text-stone-600">
                <Smartphone className="h-4 w-4 text-diya-500" /> Scan with WhatsApp → Linked devices
              </p>
              <p className="text-xs text-stone-400">
                Code #{qr.attempt} · refreshes automatically every ~20 seconds
              </p>
              <button type="button" className="btn-ghost text-xs" onClick={onRefresh}>
                <RefreshCw className="h-3.5 w-3.5" /> Get a new code now
              </button>
            </div>
          )}

          {!socketConnected && (
            <p className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <WifiOff className="h-4 w-4" /> Lost connection to the local server — retrying…
            </p>
          )}
          {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        </section>
      </div>
    </main>
  );
}
