'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import type { SmartCategory, SmartGroupSettings, SmartGroupsAnalysis } from '@/lib/types';

export const SMART_META: Record<SmartCategory, { icon: string; label: string; short: string; tone: string; hint: string }> = {
  frequent: {
    icon: '⚡',
    label: 'Frequent Chats',
    short: 'Frequent',
    tone: 'bg-emerald-50 text-emerald-700',
    hint: 'Recent two-way chats or your most active contacts',
  },
  chatted: {
    icon: '💬',
    label: 'Chatted Before',
    short: 'Chatted',
    tone: 'bg-sky-50 text-sky-700',
    hint: 'You have a chat history together — safe for festival wishes',
  },
  cold: {
    icon: '📇',
    label: 'Never Chatted / Cold',
    short: 'Cold',
    tone: 'bg-amber-50 text-amber-800',
    hint: 'Address book only. Bulk-messaging these risks a ban',
  },
};

const RECENT_OPTIONS = [30, 45, 60];
const TOP_OPTIONS = [10, 15, 20];

interface SmartGroupsCardProps {
  sessionId: string;
  /** Reload groups and contacts after the smart groups were (re)built. */
  onApplied: () => Promise<void>;
}

/** One-click categorisation of contacts into ⚡ Frequent, 💬 Chatted Before and 📇 Cold groups. */
export function SmartGroupsCard({ sessionId, onApplied }: SmartGroupsCardProps) {
  const [settings, setSettings] = useState<SmartGroupSettings>({ recentDays: 45, topPercent: 15 });
  const [preview, setPreview] = useState<SmartGroupsAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .smartGroups(sessionId, settings)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not analyse contacts.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, settings]);

  const apply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const result = await api.applySmartGroups(sessionId, settings);
      setPreview(result);
      await onApplied();
      setMessage({
        kind: 'ok',
        text: `Smart groups updated: ${result.counts.frequent} frequent, ${result.counts.chatted} chatted before, ${result.counts.cold} cold.`,
      });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not build smart groups.' });
    } finally {
      setApplying(false);
    }
  };

  const noHistory = preview !== null && preview.coverage.chatsKnown === 0;

  return (
    <section className="card p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-stone-900">
        <Sparkles className="h-4 w-4 text-diya-500" /> Smart groups
      </h2>
      <p className="mb-4 text-xs text-stone-500">
        Sorts contacts by your WhatsApp chat activity. Only message counts and dates are used — never message text.
      </p>

      <div className="grid gap-2">
        {(Object.keys(SMART_META) as SmartCategory[]).map((key) => (
          <div key={key} className={`flex items-center justify-between rounded-xl px-3 py-2 ${SMART_META[key].tone}`}>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {SMART_META[key].icon} {SMART_META[key].label}
              </span>
              <span className="block text-[11px] opacity-80">{SMART_META[key].hint}</span>
            </span>
            <span className="ml-2 text-lg font-bold tabular-nums">
              {loading && !preview ? '…' : (preview?.counts[key] ?? 0).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {preview && preview.sampleFrequent.length > 0 && (
        <p className="mt-2 truncate text-[11px] text-stone-500" title={preview.sampleFrequent.join(', ')}>
          Most active: {preview.sampleFrequent.join(', ')}
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="mb-1 block text-stone-500">Recent two-way chat within</span>
          <select
            id="smart-recent"
            className="input py-1.5 text-xs"
            value={settings.recentDays}
            onChange={(e) => setSettings((s) => ({ ...s, recentDays: Number(e.target.value) }))}
          >
            {RECENT_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-stone-500">Plus most active</span>
          <select
            id="smart-top"
            className="input py-1.5 text-xs"
            value={settings.topPercent}
            onChange={(e) => setSettings((s) => ({ ...s, topPercent: Number(e.target.value) }))}
          >
            {TOP_OPTIONS.map((p) => (
              <option key={p} value={p}>
                top {p}%
              </option>
            ))}
          </select>
        </label>
      </div>

      {noHistory ? (
        <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No chat history yet, so everyone would count as cold. WhatsApp only shares chat history right after a phone is
            linked: <strong>Unlink</strong>, then scan the QR code again. New messages are tracked from now on either way.
          </span>
        </p>
      ) : (
        preview && (
          <div className="mt-3 space-y-1.5 text-[11px] text-stone-500">
            <p>
              {preview.coverage.historyImportedAt
                ? `Chat history imported ${formatRelative(preview.coverage.historyImportedAt)}, plus new messages since.`
                : 'No chat history imported — only messages since linking are counted.'}{' '}
              {preview.coverage.chatsKnown.toLocaleString()} chats found,{' '}
              <strong className="text-stone-700">{preview.coverage.chatsMatched.toLocaleString()} matched</strong> to saved
              contacts.
            </p>
            {preview.coverage.unmatchedPrivacyIdChats > 0 && (
              <p className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-sky-800">
                {preview.coverage.unmatchedPrivacyIdChats.toLocaleString()} chats use WhatsApp privacy IDs and aren’t linked
                to a contact yet. Matching runs automatically while WhatsApp is connected, and again when you click the
                button below (it can take up to a minute).
              </p>
            )}
          </div>
        )
      )}

      <button
        type="button"
        className="btn-primary mt-3 w-full"
        onClick={() => void apply()}
        disabled={applying || loading || !preview || preview.total === 0}
      >
        {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
        {preview?.categorizedAt ? 'Update smart groups' : 'Create smart groups'}
      </button>
      {preview?.categorizedAt && (
        <p className="mt-1.5 text-center text-[11px] text-stone-400">Last updated {formatRelative(preview.categorizedAt)}</p>
      )}
      {message && (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${
            message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
