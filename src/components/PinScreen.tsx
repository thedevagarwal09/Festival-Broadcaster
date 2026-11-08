'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { PinInput } from './PinInput';
import { ApiError, authApi } from '@/lib/api';
import { pinProblem } from '@/lib/pin';

interface PinScreenProps {
  mode: 'setup' | 'unlock';
  onUnlocked: () => void;
}

/** First-run PIN setup, and the lock screen shown whenever the app is locked. */
export function PinScreen({ mode, onUnlocked }: PinScreenProps) {
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);

  useEffect(() => {
    if (lockedFor <= 0) return;
    const t = setTimeout(() => setLockedFor((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockedFor]);

  const unlock = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.login(value);
      onUnlocked();
    } catch (err) {
      setPin('');
      if (err instanceof ApiError && err.retryAfter) setLockedFor(err.retryAfter);
      setError(err instanceof Error ? err.message : 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  };

  const setup = async (value: string) => {
    if (step === 'enter') {
      const problem = pinProblem(value);
      if (problem) {
        setError(problem);
        setPin('');
        return;
      }
      setFirstPin(value);
      setPin('');
      setError(null);
      setStep('confirm');
      return;
    }
    if (value !== firstPin) {
      setError('The PINs did not match. Start again.');
      setPin('');
      setFirstPin('');
      setStep('enter');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.setup(value);
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the PIN.');
      setPin('');
      setStep('enter');
    } finally {
      setBusy(false);
    }
  };

  const isSetup = mode === 'setup';
  const title = isSetup ? (step === 'enter' ? 'Create a 4-digit PIN' : 'Enter the PIN again') : 'Enter your PIN';
  const disabled = busy || lockedFor > 0;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm p-8 text-center">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-diya-400 to-rose-500 text-white">
          {isSetup ? <KeyRound className="h-7 w-7" /> : <Lock className="h-7 w-7" />}
        </span>
        <p className="text-xs font-semibold uppercase tracking-widest text-diya-600">Festival Broadcaster</p>
        <h1 className="mt-1 text-xl font-bold text-stone-900">{title}</h1>
        <p className="mt-2 text-sm text-stone-500">
          {isSetup
            ? step === 'enter'
              ? 'You’ll need it every time you open the app or it locks itself.'
              : 'Type the same 4 digits to confirm.'
            : 'The app locks after 15 minutes without activity. Campaigns keep sending while it’s locked.'}
        </p>

        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length === 4) void (isSetup ? setup(pin) : unlock(pin));
          }}
        >
          <PinInput
            id={isSetup ? `pin-setup-${step}` : 'pin-unlock'}
            label={title}
            value={pin}
            onChange={(v) => {
              setPin(v);
              if (error && v.length > 0) setError(null);
            }}
            onComplete={(v) => void (isSetup ? setup(v) : unlock(v))}
            disabled={disabled}
            invalid={error !== null}
            autoFocus
          />
          <div className="mt-4 min-h-[2.5rem] text-sm" aria-live="polite">
            {busy && (
              <span className="inline-flex items-center gap-2 text-stone-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking…
              </span>
            )}
            {!busy && lockedFor > 0 && <span className="text-rose-600">Too many wrong PINs. Try again in {lockedFor}s.</span>}
            {!busy && lockedFor <= 0 && error && <span className="text-rose-600">{error}</span>}
          </div>
          <button type="submit" className="btn-primary w-full" disabled={disabled || pin.length !== 4}>
            {isSetup ? (step === 'enter' ? 'Continue' : 'Save PIN') : 'Unlock'}
          </button>
        </form>

        <p className="mt-6 flex items-start gap-2 text-left text-xs text-stone-500">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-diya-500" />
          {isSetup ? (
            <span>Only a scrambled hash of your PIN is stored on this computer. Avoid obvious PINs like 1234 or your birth year.</span>
          ) : (
            <span>
              Forgot it? Stop the server and run <code className="rounded bg-stone-100 px-1">npm run pin:reset</code>, then start
              it again. Your WhatsApp link and contacts are kept.
            </span>
          )}
        </p>
      </div>
    </main>
  );
}
