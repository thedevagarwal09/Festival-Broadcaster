'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Info,
  Loader2,
  Moon,
  Pause,
  Play,
  Radio,
  Square,
  Terminal,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes, formatClock, formatDateTime, jidToPhone } from '@/lib/format';
import { estimateDurationMs, formatDuration, PACING_PROFILES } from '@/lib/pacing';
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
  SCHEDULED: 'bg-violet-50 text-violet-700',
  PROCESSING: 'bg-emerald-50 text-emerald-700',
  PAUSED: 'bg-amber-50 text-amber-700',
  QUIET_HOURS_PAUSED: 'bg-sky-50 text-sky-700',
  COMPLETED: 'bg-stone-100 text-stone-700',
  ABORTED: 'bg-rose-50 text-rose-700',
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  SCHEDULED: 'scheduled',
  PROCESSING: 'sending',
  PAUSED: 'paused',
  QUIET_HOURS_PAUSED: 'quiet hours',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
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

  const total = campaign?.totalRecipients ?? 0;
  const sent = campaign?.sentCount ?? 0;
  const failed = campaign?.failedCount ?? 0;
  const delivered = Math.min(campaign?.deliveredCount ?? 0, sent);
  const read = Math.min(campaign?.readCount ?? 0, delivered);
  const processed = sent + failed;
  const status = campaign?.status;
  const isOpen = status === 'SCHEDULED' || status === 'PROCESSING' || status === 'PAUSED' || status === 'QUIET_HOURS_PAUSED';
  const remaining = isOpen ? Math.max(0, total - processed) : 0;
  const completionPct = total ? Math.round((processed / total) * 100) : 0;
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : '0%');

  // ETA from the real average gap between messages so far (it includes the jitter and cooldown
  // breaks). Clamped so a long pause (quiet hours, manual pause) doesn't distort it; falls back to
  // the pacing settings until two messages have gone out.
  const pacingPerMessage = remaining > 0 ? estimateDurationMs(remaining, campaign?.pacing ?? 'careful') / remaining : 0;
  const observed = campaign?.avgIntervalMs ?? null;
  const perMessage = observed
    ? Math.min(Math.max(observed, pacingPerMessage * 0.5), pacingPerMessage * 2.5)
    : pacingPerMessage;
  const etaMs = remaining * perMessage;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="card max-h-[75vh] overflow-y-auto p-3">
        <h2 className="px-2 pb-2 pt-1 text-sm font-semibold text-stone-700">Campaigns</h2>
        <ul className="space-y-1">
          {campaigns.map((c) => {
            const done = c.totalRecipients ? Math.round(((c.sentCount + c.failedCount) / c.totalRecipients) * 100) : 0;
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
                    <span className={`chip shrink-0 ${STATUS_STYLE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div className="h-full bg-diya-400" style={{ width: `${done}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {c.status === 'SCHEDULED' && c.scheduledAt
                      ? `Starts ${formatDateTime(c.scheduledAt)}`
                      : `${c.sentCount + c.failedCount}/${c.totalRecipients} · ${formatDateTime(c.createdAt)}`}
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
                  {status === 'PROCESSING' && <Radio className="h-4 w-4 animate-pulse text-emerald-500" />}
                  {status === 'QUIET_HOURS_PAUSED' && <Moon className="h-4 w-4 text-sky-500" />}
                  {status === 'SCHEDULED' && <CalendarClock className="h-4 w-4 text-violet-500" />}
                  <h2 className="truncate text-lg font-bold text-stone-900">{campaign.name}</h2>
                  <span className={`chip ${STATUS_STYLE[campaign.status]}`}>{STATUS_LABEL[campaign.status]}</span>
                </div>
                <p className="mt-1 text-sm text-stone-500">
                  {campaign.groupName ? `Group “${campaign.groupName}”` : 'Group deleted'}
                  {campaign.mediaType
                    ? ` · with ${campaign.mediaType}${campaign.mediaSize ? ` (${formatBytes(campaign.mediaSize)})` : ''}`
                    : ''}
                  {` · ${PACING_PROFILES[campaign.pacing].label.toLowerCase()} pacing`}
                  {' · '}
                  {status === 'SCHEDULED' && campaign.scheduledAt
                    ? `starts ${formatDateTime(campaign.scheduledAt)}`
                    : campaign.startedAt
                      ? `started ${formatDateTime(campaign.startedAt)}`
                      : `created ${formatDateTime(campaign.createdAt)}`}
                </p>
                {status === 'QUIET_HOURS_PAUSED' && (
                  <p className="mt-2 text-sm text-sky-700">Paused for quiet hours — it resumes on its own when they end.</p>
                )}
              </div>
              {isOpen && (
                <div className="flex flex-wrap gap-2">
                  {status === 'PROCESSING' || status === 'QUIET_HOURS_PAUSED' ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void control('pause')}
                      disabled={pendingAction !== null}
                      title={status === 'QUIET_HOURS_PAUSED' ? 'Keep it paused after quiet hours end' : undefined}
                    >
                      {pendingAction === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                      {status === 'QUIET_HOURS_PAUSED' ? 'Hold' : 'Pause'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void control('resume')}
                      disabled={pendingAction !== null}
                    >
                      {pendingAction === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      {status === 'SCHEDULED' ? 'Start now' : 'Resume'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void control('abort')}
                    disabled={pendingAction !== null}
                  >
                    {pendingAction === 'abort' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                    {status === 'SCHEDULED' ? 'Cancel' : 'Abort'}
                  </button>
                </div>
              )}
            </div>

            {/* Analytics */}
            <div className="mt-5">
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-semibold text-stone-800">{completionPct}% complete</span>
                <span className="text-xs text-stone-500" aria-live="polite">
                  {isOpen && status !== 'SCHEDULED' && remaining === 0
                    ? 'All messages processed — finishing up'
                    : status === 'PROCESSING' && remaining > 0
                    ? `~${formatDuration(etaMs)} left · ${observed ? `avg ${(perMessage / 1000).toFixed(1)} s per message so far` : 'estimated from pacing settings'}`
                    : status === 'SCHEDULED'
                      ? `~${formatDuration(etaMs)} once it starts`
                      : status === 'PAUSED'
                        ? 'Paused'
                        : status === 'QUIET_HOURS_PAUSED'
                          ? `~${formatDuration(etaMs)} of sending left after quiet hours`
                          : status === 'COMPLETED'
                            ? `Finished ${campaign.completedAt ? formatDateTime(campaign.completedAt) : ''}`
                            : ''}
                </span>
              </div>
              <div
                className="flex h-3 overflow-hidden rounded-full bg-stone-100"
                role="progressbar"
                aria-valuenow={completionPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Campaign completion"
              >
                <div className="h-full bg-emerald-700 transition-all duration-500" style={{ width: pct(read) }} title="Read" />
                <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: pct(delivered - read) }} title="Delivered" />
                <div className="h-full bg-emerald-300 transition-all duration-500" style={{ width: pct(sent - delivered) }} title="Dispatched" />
                <div className="h-full bg-rose-500 transition-all duration-500" style={{ width: pct(failed) }} title="Failed" />
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  { label: 'Total targets', value: total, sub: `${remaining} to go`, tone: 'text-stone-800', dot: 'bg-stone-300' },
                  { label: 'Dispatched', value: sent, sub: total ? `${Math.round((sent / total) * 100)}% of targets` : '', tone: 'text-emerald-600', dot: 'bg-emerald-300' },
                  { label: 'Delivered', value: delivered, sub: sent ? `${Math.round((delivered / sent) * 100)}% of dispatched` : '—', tone: 'text-emerald-700', dot: 'bg-emerald-500' },
                  { label: 'Read', value: read, sub: sent ? `${Math.round((read / sent) * 100)}% of dispatched` : '—', tone: 'text-emerald-800', dot: 'bg-emerald-700' },
                  { label: 'Failed', value: failed, sub: total ? `${Math.round((failed / total) * 100)}% of targets` : '', tone: 'text-rose-600', dot: 'bg-rose-500' },
                ].map((m) => (
                  <div key={m.label} className="rounded-xl bg-stone-50 px-3 py-2.5">
                    <dt className="flex items-center gap-1.5 text-xs text-stone-500">
                      <span className={`h-2 w-2 rounded-full ${m.dot}`} /> {m.label}
                    </dt>
                    <dd className={`text-2xl font-bold tabular-nums ${m.tone}`}>{m.value.toLocaleString()}</dd>
                    <dd className="text-[11px] text-stone-400">{m.sub}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-[11px] text-stone-400">
                Delivered and Read come from WhatsApp receipts. Read only counts people who share read receipts.
              </p>
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
