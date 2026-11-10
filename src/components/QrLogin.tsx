'use client';

/* eslint-disable @next/next/no-img-element */
import { Loader2, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2, WifiOff } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { SessionSnapshot } from '@/lib/types';

interface QrLoginProps {
  snapshot: SessionSnapshot;
  qr: { qr: string; attempt: number } | null;
  socketConnected: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Opens the "Unlink & erase all data" confirmation. */
  onEraseAll: () => void;
}

const STEPS = [
  'Open WhatsApp on your phone',
  'Tap Menu (⋮) or Settings → Linked devices',
  'Tap “Link a device” and point your camera at this code',
];

export function QrLogin({ snapshot, qr, socketConnected, error, onRefresh, onEraseAll }: QrLoginProps) {
  const expired = snapshot.status === 'idle' || snapshot.status === 'conflict';
  const waiting = !qr && !expired;

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6 pt-20 md:pt-6">
      <ThemeToggle className="absolute right-4 top-4 md:right-6 md:top-6" />
      <div className="card grid w-full max-w-4xl overflow-hidden md:grid-cols-2">
        <section className="palette-light flex flex-col justify-between bg-gradient-to-br from-diya-500 via-diya-600 to-rose-600 p-8 text-white">
          <div>
            <div className="mb-6 flex items-center gap-2 text-diya-100">
              <span className="text-2xl">🎉</span>
              <span className="text-sm font-semibold uppercase tracking-widest">Festival Broadcaster</span>
            </div>
            <h1 className="text-3xl font-bold leading-tight">Send warm festival wishes to everyone you love.</h1>
            <p className="mt-3 text-diya-100">
              Link your WhatsApp once. It runs on your own server — no paid APIs, no third-party cloud.
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
            <ShieldCheck className="h-4 w-4" /> Your WhatsApp login stays on your server.
          </p>
        </section>

        <section className="flex flex-col items-center justify-center gap-5 p-8">
          <div className="palette-light relative flex h-72 w-72 items-center justify-center rounded-2xl border-2 border-dashed border-stone-200 bg-white">
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
              <WifiOff className="h-4 w-4" /> Lost connection to the server — reconnecting…
            </p>
          )}
          {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
          <button
            type="button"
            className="btn-ghost text-xs text-stone-500 hover:text-rose-600"
            onClick={onEraseAll}
            title="Delete all contacts, groups, campaigns, uploads and WhatsApp logins stored on this server"
          >
            <Trash2 className="h-3.5 w-3.5" /> Erase all data on this server
          </button>
        </section>
      </div>
    </main>
  );
}
