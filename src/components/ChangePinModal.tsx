'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { PinInput } from './PinInput';
import { authApi } from '@/lib/api';
import { pinProblem } from '@/lib/pin';

interface ChangePinModalProps {
  open: boolean;
  onClose: () => void;
}

export function ChangePinModal({ open, onClose }: ChangePinModalProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setDone(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    if (current.length !== 4) return setError('Enter your current PIN.');
    const problem = pinProblem(next);
    if (problem) return setError(problem);
    if (next !== confirm) return setError('The new PINs don’t match.');
    setBusy(true);
    try {
      await authApi.change(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the PIN.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-pin-title"
    >
      <div className="card w-full max-w-sm bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 id="change-pin-title" className="text-lg font-bold text-stone-900">
            Change PIN
          </h2>
          <button type="button" className="btn-ghost p-1.5" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <p className="text-sm text-stone-600">
              Your PIN is changed. Any other browser that was unlocked has been locked.
            </p>
            <button type="button" className="btn-primary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium text-stone-700">Current PIN</p>
              <PinInput id="pin-current" label="Current PIN" value={current} onChange={setCurrent} disabled={busy} autoFocus />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-stone-700">New PIN</p>
              <PinInput id="pin-new" label="New PIN" value={next} onChange={setNext} disabled={busy} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-stone-700">New PIN again</p>
              <PinInput id="pin-confirm" label="Confirm new PIN" value={confirm} onChange={setConfirm} disabled={busy} />
            </div>
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Change PIN
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
