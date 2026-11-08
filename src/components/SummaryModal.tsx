'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Loader2, Rocket, ShieldAlert, X } from 'lucide-react';
import { PACING, estimateDurationMs, formatDuration } from '@/lib/pacing';

interface SummaryModalProps {
  open: boolean;
  groupName: string;
  recipients: number;
  variations: number;
  hasMedia: boolean;
  mediaKind: 'image' | 'video';
  preview: string;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function riskLevel(recipients: number): { label: string; tone: string; advice: string } {
  if (recipients <= 50) {
    return {
      label: 'Low',
      tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
      advice: 'A small list of people who know you is the safest kind of broadcast.',
    };
  }
  if (recipients <= 200) {
    return {
      label: 'Moderate',
      tone: 'bg-amber-50 text-amber-700 ring-amber-200',
      advice: 'Consider splitting into a few groups and sending them on different days or hours.',
    };
  }
  return {
    label: 'High',
    tone: 'bg-rose-50 text-rose-700 ring-rose-200',
    advice:
      'Hundreds of messages from a personal account can get it restricted or banned — especially if recipients have not saved your number. Split this list.',
  };
}

export function SummaryModal({
  open,
  groupName,
  recipients,
  variations,
  hasMedia,
  mediaKind,
  preview,
  submitting,
  error,
  onCancel,
  onConfirm,
}: SummaryModalProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onCancel]);

  if (!open) return null;

  const avg = estimateDurationMs(recipients, 'avg');
  const min = estimateDurationMs(recipients, 'min');
  const max = estimateDurationMs(recipients, 'max');
  const finishAt = new Date(Date.now() + avg).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cooldowns = Math.floor(Math.max(0, recipients - 1) / PACING.cooldownEvery);
  const risk = riskLevel(recipients);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="summary-title"
    >
      <div className="card max-h-[90vh] w-full max-w-lg overflow-y-auto bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="summary-title" className="text-lg font-bold text-stone-900">
              Ready to broadcast?
            </h2>
            <p className="text-sm text-stone-500">
              “{groupName}” · {recipients} recipient{recipients === 1 ? '' : 's'}
              {hasMedia ? ` · with ${mediaKind}` : ''}
            </p>
          </div>
          <button type="button" className="btn-ghost p-1.5" onClick={onCancel} disabled={submitting}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-stone-50 p-3">
            <p className="text-xs text-stone-500">Estimated</p>
            <p className="text-lg font-bold text-stone-900">{formatDuration(avg)}</p>
          </div>
          <div className="rounded-xl bg-stone-50 p-3">
            <p className="text-xs text-stone-500">Range</p>
            <p className="text-sm font-semibold text-stone-900">
              {formatDuration(min)} – {formatDuration(max)}
            </p>
          </div>
          <div className="rounded-xl bg-stone-50 p-3">
            <p className="text-xs text-stone-500">Done around</p>
            <p className="text-lg font-bold text-stone-900">{finishAt}</p>
          </div>
        </div>

        <ul className="mt-4 space-y-1.5 rounded-xl border border-stone-100 p-4 text-xs text-stone-600">
          <li className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-diya-500" />
            One message at a time, {PACING.jitterMinMs / 1000}–{PACING.jitterMaxMs / 1000}s random gap between recipients
          </li>
          <li className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-diya-500" />
            “Typing…” shown for {PACING.typingMinMs / 1000}–{PACING.typingMaxMs / 1000}s before each message
          </li>
          <li className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-diya-500" />
            {PACING.cooldownMs / 1000}s cooldown after every {PACING.cooldownEvery} messages
            {cooldowns > 0 ? ` (${cooldowns} in this run)` : ''}
          </li>
          <li className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-diya-500" />
            {variations > 1_000_000 ? '1M+' : variations.toLocaleString()} possible text variation
            {variations === 1 ? '' : 's'}
          </li>
        </ul>

        <div className={`mt-4 rounded-xl p-4 text-sm ring-1 ${risk.tone}`}>
          <p className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4" /> Ban risk: {risk.label}
          </p>
          <p className="mt-1 text-xs">{risk.advice}</p>
        </div>

        <div className="mt-4 rounded-xl bg-amber-50 p-4 text-xs text-amber-900">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Before you start
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Automating a personal account is against WhatsApp&apos;s Terms; pacing reduces risk but cannot remove it.</li>
            <li>Only message people who know you — reports and blocks are the biggest ban trigger.</li>
            <li>Keep the server running until the campaign finishes (if it runs on a laptop, keep the laptop awake).</li>
            <li>Your phone can stay offline; linked devices send on their own.</li>
          </ul>
        </div>

        {preview && (
          <div className="mt-4">
            <p className="mb-1 text-xs font-medium text-stone-500">Sample message</p>
            <p className="palette-light max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#d9fdd3] p-3 text-sm text-stone-800">
              {preview}
            </p>
          </div>
        )}

        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-diya-500"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I understand the risks, and everyone in this group knows me.
        </label>

        {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={!acknowledged || submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            Start broadcast
          </button>
        </div>
      </div>
    </div>
  );
}
