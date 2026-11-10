'use client';

import { useEffect, useState } from 'react';
import { Loader2, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { browserSessionIds } from '@/lib/session-id';
import type { EraseResult } from '@/lib/types';

const CONFIRM_WORD = 'ERASE';

interface EraseDataDialogProps {
  open: boolean;
  /** The session this tab is on; earlier ones from this browser are added automatically. */
  sessionId: string;
  onClose: () => void;
  onErased: (result: EraseResult) => void;
}

/** Confirmation for "Unlink & erase my data". The person must type ERASE. */
export function EraseDataDialog({ open, sessionId, onClose, onErased }: EraseDataDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
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

  const ready = typed.trim().toUpperCase() === CONFIRM_WORD;

  const erase = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onErased(await api.eraseMyData(browserSessionIds(sessionId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erase failed');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="erase-title"
    >
      <div className="card max-h-[90vh] w-full max-w-md overflow-y-auto bg-surface p-6 text-left shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <Trash2 className="h-5 w-5" />
            </span>
            <h2 id="erase-title" className="text-lg font-bold text-stone-900">
              Unlink &amp; erase my data?
            </h2>
          </div>
          <button type="button" className="btn-ghost -mr-2 px-2" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-stone-600">This permanently removes everything of yours from this server:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-600">
          <li>unlinks your WhatsApp and deletes its login keys</li>
          <li>your saved contacts and groups</li>
          <li>your campaigns, scheduled sends and their logs (running ones stop)</li>
          <li>your draft, and the images, videos and e-cards you added</li>
        </ul>
        <p className="mt-3 text-sm text-stone-600">
          It cannot be undone. Other people using this server aren&apos;t affected, and the chats and contacts on
          your phone are not touched.
        </p>

        <label className="mt-4 block text-sm font-medium text-stone-700" htmlFor="erase-confirm">
          Type <span className="font-mono font-bold text-rose-600">{CONFIRM_WORD}</span> to confirm
        </label>
        <input
          id="erase-confirm"
          className="input mt-1.5 font-mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void erase();
          }}
          autoComplete="off"
          autoFocus
          disabled={busy}
        />

        {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={() => void erase()} disabled={!ready || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {busy ? 'Erasing…' : 'Erase everything'}
          </button>
        </div>
        {busy && (
          <p className="mt-3 text-xs text-stone-500">
            Finishing the message in flight and unlinking from WhatsApp — this can take up to a minute.
          </p>
        )}
      </div>
    </div>
  );
}
