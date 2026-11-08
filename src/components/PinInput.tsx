'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { PIN_LENGTH } from '@/lib/pin';

interface PinInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Called once all digits are filled. */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  label: string;
}

/** Four masked digit boxes with auto-advance, backspace-to-previous and paste support. */
export function PinInput({ id, value, onChange, onComplete, disabled, autoFocus, invalid, label }: PinInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  // Keystrokes can arrive faster than React re-renders; always build on the latest value.
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (autoFocus && !disabled) refs.current[Math.min(value.length, PIN_LENGTH - 1)]?.focus();
    // Focus only when (re)enabled, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, disabled]);

  // When the parent clears the PIN (wrong or rejected), start again from the first box.
  useEffect(() => {
    if (value === '' && autoFocus && !disabled) refs.current[0]?.focus();
  }, [value, autoFocus, disabled]);

  const update = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, PIN_LENGTH);
    latest.current = clean;
    onChange(clean);
    refs.current[Math.min(clean.length, PIN_LENGTH - 1)]?.focus();
    if (clean.length === PIN_LENGTH) onComplete?.(clean);
  };

  const onKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    const current = latest.current;
    if (e.key === 'Backspace') {
      e.preventDefault();
      // Delete the last entered digit, wherever the cursor is.
      const next = current.slice(0, Math.max(0, Math.min(current.length, index + 1) - 1));
      latest.current = next;
      onChange(next);
      refs.current[Math.max(0, next.length)]?.focus();
    } else if (/^\d$/.test(e.key)) {
      e.preventDefault();
      update(current.length >= PIN_LENGTH ? e.key : current + e.key);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); // ignore letters
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    update(e.clipboardData.getData('text'));
  };

  return (
    <div role="group" aria-label={label} className="flex justify-center gap-3">
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <input
          key={i}
          id={`${id}-${i}`}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={`${label}, digit ${i + 1}`}
          value={value[i] ?? ''}
          disabled={disabled}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onChange={(e) => {
            // Mobile keyboards, autofill and password managers skip keydown and may insert
            // several digits at once: spread them across this box and the ones after it.
            let digits = e.target.value.replace(/\D/g, '');
            const existing = latest.current[i];
            if (existing && digits.length > 1 && digits.startsWith(existing)) digits = digits.slice(1);
            if (digits) update(latest.current.slice(0, i) + digits);
          }}
          onFocus={(e) => e.target.select()}
          className={`h-14 w-12 rounded-xl border-2 bg-white text-center text-2xl font-bold text-stone-900 outline-none transition focus:border-diya-500 focus:ring-4 focus:ring-diya-100 disabled:opacity-50 ${
            invalid ? 'border-rose-400' : value[i] ? 'border-diya-300' : 'border-stone-200'
          }`}
        />
      ))}
    </div>
  );
}
