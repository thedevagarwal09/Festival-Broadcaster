'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  Pause,
  Play,
  Radio,
  Square,
  Terminal,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatClock, formatDateTime, jidToPhone } from '@/lib/format';
import { estimateDurationMs, formatDuration } from '@/lib/pacing';
import { getSocket } from '@/lib/socket';
import type { CampaignDTO, CampaignLogEntry, CampaignStatus, LogLevel } from '@/lib/types';

interface LiveTerminalProps {
  sessionId: string;
  campaigns: CampaignDTO[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCampaignChange: (campaign: CampaignDTO) => void;
}

const MAX_LOG_LINES = 1000;

const STATUS_STYLE: Record<CampaignStatus, string> = {
  RUNNING: 'bg-emerald-50 text-emerald-700',
  PAUSED: 'bg-amber-50 text-amber-700',
  COMPLETED: 'bg-sky-50 text-sky-700',
  ABORTED: 'bg-rose-50 text-rose-700',
};

const LEVEL_STYLE: Record<LogLevel, { color: string; tag: string }> = {
  info: { color: 'text-sky-300', tag: 'INFO' },
  warn: { color: 'text-amber-300', tag: 'WARN' },
  processing: { color: 'text-stone-400', tag: 'TYPE' },
  sent: { color: 'text-emerald-400', tag: 'SENT' },
  failed: { color: 'text-rose-400', tag: 'FAIL' },
};

function LevelIcon({ level }: { level: LogLevel }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (level) {
    case 'sent':
      return <CheckCircle2 className={`${cls} text-emerald-400`} />;
    case 'failed':
      return <XCircle className={`${cls} text-rose-400`} />;
    case 'warn':
      return <TriangleAlert className={`${cls} text-amber-300`} />;
    case 'processing':
      return <Loader2 className={`${cls} animate-spin text-stone-400`} />;
    default:
      return <Info className={`${cls} text-sky-300`} />;
  }
}

export function LiveTerminal({ sessionId, campaigns, activeId, onSelect, onCampaignChange }: LiveTerminalProps) {
  const [logs, setLogs] = useState<CampaignLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [pendingAction, setPendingAction] = useState<'pause' | 'resume' | 'abort' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(activeId);

  const campaign = campaigns.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    activeRef.current = activeId;
    if (!activeId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    setLoadingLogs(true);
    setError(null);
    api
      .campaign(sessionId, activeId)
      .then((detail) => {
        if (cancelled) return;
        // Keep any live lines that arrived while history was loading.
        setLogs((live) => {
          const fromHistory = new Set(detail.logs.map((l) => l.id));
          return [...detail.logs, ...live.filter((l) => l.campaignId === activeId && !fromHistory.has(l.id))];
        });
        onCampaignChange(detail.campaign);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load campaign');
      })
      .finally(() => {
        if (!cancelled) setLoadingLogs(false);
      });
    return () => {
      cancelled = true;
      setLogs([]);
    };
  }, [sessionId, activeId, onCampaignChange]);

  useEffect(() => {
    const socket = getSocket();
    const onLog = (entry: CampaignLogEntry) => {
      if (entry.campaignId !== activeRef.current) return;
      setLogs((prev) => {
        // Collapse the "Typing…" line once that recipient's final result arrives.
        const trimmed =
          entry.level === 'sent' || entry.level === 'failed' || entry.level === 'warn'
            ? prev.filter((l) => !(l.level === 'processing' && l.recipientJid === entry.recipientJid))
            : prev;
        const next = [...trimmed, entry];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    };
    socket.on('campaign_log', onLog);
    return () => {
      socket.off('campaign_log', onLog);
    };
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const control = async (action: 'pause' | 'resume' | 'abort') => {
    if (!campaign) return;
    if (
      action === 'abort' &&
      !window.confirm('Abort this campaign? Messages not yet sent will be cancelled. This cannot be undone.')
    ) {
      return;
    }
    setPendingAction(action);
    setError(null);
    try {
      const updated = await api.controlCampaign(sessionId, campaign.id, action);
      onCampaignChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} the campaign`);
    } finally {
      setPendingAction(null);
    }
  };

  if (campaigns.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 p-12 text-center">
        <Terminal className="h-10 w-10 text-stone-300" />
        <h2 className="text-lg font-semibold">No campaigns yet</h2>
        <p className="text-sm text-stone-500">Compose a broadcast and its live dispatch log will appear here.</p>
      </div>
    );
  }

  const processed = campaign ? campaign.sentCount + campaign.failedCount : 0;
  const total = campaign?.totalRecipients ?? 0;
  const sentPct = total ? (campaign!.sentCount / total) * 100 : 0;
  const failedPct = total ? (campaign!.failedCount / total) * 100 : 0;
  const remaining = Math.max(0, total - processed);
  const isActive = campaign?.status === 'RUNNING' || campaign?.status === 'PAUSED';

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="card max-h-[75vh] overflow-y-auto p-3">
        <h2 className="px-2 pb-2 pt-1 text-sm font-semibold text-stone-700">Campaigns</h2>
        <ul className="space-y-1">
          {campaigns.map((c) => {
            const pct = c.totalRecipients ? Math.round(((c.sentCount + c.failedCount) / c.totalRecipients) * 100) : 0;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                    c.id === activeId ? 'bg-diya-50 ring-1 ring-diya-200' : 'hover:bg-stone-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-stone-800">{c.name}</span>
                    <span className={`chip shrink-0 ${STATUS_STYLE[c.status]}`}>{c.status.toLowerCase()}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div className="h-full bg-diya-400" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {c.sentCount + c.failedCount}/{c.totalRecipients} · {formatDateTime(c.createdAt)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {campaign ? (
        <section className="flex flex-col gap-4">
          <div className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {campaign.status === 'RUNNING' && <Radio className="h-4 w-4 animate-pulse text-emerald-500" />}
                  <h2 className="truncate text-lg font-bold text-stone-900">{campaign.name}</h2>
                  <span className={`chip ${STATUS_STYLE[campaign.status]}`}>{campaign.status.toLowerCase()}</span>
                </div>
                <p className="mt-1 text-sm text-stone-500">
                  {campaign.groupName ? `Group “${campaign.groupName}”` : 'Group deleted'}
                  {campaign.mediaType ? ` · with ${campaign.mediaType}` : ''} · started {formatDateTime(campaign.createdAt)}
                </p>
              </div>
              {isActive && (
                <div className="flex gap-2">
                  {campaign.status === 'RUNNING' ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void control('pause')}
                      disabled={pendingAction !== null}
                    >
                      {pendingAction === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void control('resume')}
                      disabled={pendingAction !== null}
                    >
                      {pendingAction === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void control('abort')}
                    disabled={pendingAction !== null}
                  >
                    {pendingAction === 'abort' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                    Abort
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5">
              <div className="flex h-3 overflow-hidden rounded-full bg-stone-100">
                <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${sentPct}%` }} />
                <div className="h-full bg-rose-500 transition-all duration-500" style={{ width: `${failedPct}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-stone-500">Sent</p>
                  <p className="text-xl font-bold text-emerald-600">{campaign.sentCount}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-500">Failed</p>
                  <p className="text-xl font-bold text-rose-600">{campaign.failedCount}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-500">Remaining</p>
                  <p className="text-xl font-bold text-stone-800">{isActive ? remaining : 0}</p>
                </div>
                <div>
                  <p className="flex items-center gap-1 text-xs text-stone-500">
                    <Clock className="h-3 w-3" /> Time left
                  </p>
                  <p className="text-xl font-bold text-stone-800">
                    {campaign.status === 'RUNNING' && remaining > 0
                      ? `~${formatDuration(estimateDurationMs(remaining))}`
                      : campaign.status === 'PAUSED'
                        ? 'paused'
                        : '—'}
                  </p>
                </div>
              </div>
            </div>
            {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          </div>

          <div className="palette-light overflow-hidden rounded-2xl border border-stone-800 bg-stone-950 shadow-lg">
            <div className="flex items-center justify-between border-b border-stone-800 px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-rose-500" />
                <span className="h-3 w-3 rounded-full bg-amber-400" />
                <span className="h-3 w-3 rounded-full bg-emerald-500" />
                <span className="ml-3 font-mono text-xs text-stone-400">dispatch.log</span>
              </div>
              {!autoScroll && (
                <button
                  type="button"
                  className="font-mono text-xs text-diya-300 hover:text-diya-200"
                  onClick={() => setAutoScroll(true)}
                >
                  ↓ follow
                </button>
              )}
            </div>
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="h-[420px] overflow-y-auto px-4 py-3 font-mono text-xs leading-6"
            >
              {loadingLogs && logs.length === 0 ? (
                <p className="flex items-center gap-2 text-stone-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading history…
                </p>
              ) : logs.length === 0 ? (
                <p className="text-stone-500">$ waiting for the first dispatch…</p>
              ) : (
                logs.map((entry) => {
                  const style = LEVEL_STYLE[entry.level];
                  const who = entry.recipientName ?? (entry.recipientJid ? jidToPhone(entry.recipientJid) : null);
                  return (
                    <div key={entry.id} className="flex items-center gap-2 whitespace-nowrap">
                      <span className="text-stone-600">{formatClock(entry.timestamp)}</span>
                      <LevelIcon level={entry.level} />
                      <span className={`w-10 shrink-0 ${style.color}`}>{style.tag}</span>
                      {who && <span className="max-w-[220px] truncate text-stone-100">{who}</span>}
                      {entry.recipientJid && entry.recipientName && (
                        <span className="text-stone-600">{jidToPhone(entry.recipientJid)}</span>
                      )}
                      <span className={`truncate ${entry.level === 'failed' ? 'text-rose-300' : 'text-stone-400'}`}>
                        {who ? '— ' : ''}
                        {entry.message}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      ) : (
        <div className="card flex items-center justify-center p-12 text-sm text-stone-500">
          Select a campaign to view its live log.
        </div>
      )}
    </div>
  );
}
