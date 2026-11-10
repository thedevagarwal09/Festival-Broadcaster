'use client';

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bold,
  CalendarClock,
  Check,
  Clock,
  Image as ImageIcon,
  Italic,
  Loader2,
  Moon,
  Palette,
  Paperclip,
  Send,
  Shuffle,
  Sparkles,
  Strikethrough,
  Users,
  Video,
  X,
} from 'lucide-react';
import { SummaryModal } from './SummaryModal';
import { api, uploadMedia } from '@/lib/api';
import { contactDisplayName, formatBytes, formatRelative } from '@/lib/format';
import { estimateDurationMs, formatDuration, isPacingMode, PACING_MODES, PACING_PROFILES, type PacingMode } from '@/lib/pacing';
import {
  CATEGORY_LABELS,
  describeDaysAway,
  getOccasion,
  isOccasionId,
  LANGUAGE_LABELS,
  OCCASIONS,
  upcomingOccasions,
  type Occasion,
  type OccasionCategory,
  type TemplateLanguage,
  nextOccurrence,
  type UpcomingOccasion,
} from '@/lib/occasions';
import { describeWindow, runTouchesQuietHours, toLocalInputValue } from '@/lib/quiet-hours';
import { getSocket } from '@/lib/socket';
import { TEMPLATE_VARIABLES, countVariations, renderMessage, validateTemplate } from '@/lib/spintax';
import type { CampaignDTO, ContactDTO, GroupDTO, MediaInfo, MediaJob, QuietHoursSettings } from '@/lib/types';

interface BroadcastComposerProps {
  sessionId: string;
  groups: GroupDTO[];
  contacts: ContactDTO[];
  connected: boolean;
  onCreated: (campaign: CampaignDTO) => void;
  onGoToContacts: () => void;
  /** Set by the dashboard's "upcoming festival" banner; a new nonce applies it. */
  occasionRequest?: { id: string; nonce: number } | null;
}

// Start with the nearest upcoming occasion's template (e.g. Christmas in December).
const FIRST_OCCASION: Occasion = upcomingOccasions(new Date(), 1)[0]?.occasion ?? OCCASIONS[0]!;
const DEFAULT_TEMPLATE = FIRST_OCCASION.templates.en;
/** True when the text is one of the built-in templates (so switching occasion can replace it safely). */
const isStockTemplate = (text: string): boolean =>
  !text.trim() || OCCASIONS.some((o) => Object.values(o.templates).includes(text));

const MAX_TEMPLATE = 4096;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv)$/i;
const IMAGE_MAX = 25 * 1024 * 1024;
const VIDEO_MAX = 500 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/x-matroska,.mkv,.mov';
// "Send original": what WhatsApp accepts as a normal photo / video message, unchanged.
const ORIGINAL_IMAGE_MAX = 16 * 1024 * 1024;
const ORIGINAL_VIDEO_MAX = 64 * 1024 * 1024;
const ACCEPT_ORIGINAL = 'image/jpeg,image/png,image/webp,video/mp4,.mp4';
const COMPRESS_PREF_KEY = 'festival-broadcaster.compress-media';
const DRAFT_SAVE_DELAY_MS = 800;
const BASE_EMOJIS = ['✨', '🎉', '🙏', '🌸', '❤️', '🎁', '🍬', '🌟', '💐'];

const SPINTAX_SNIPPETS = [
  { label: 'Greeting', text: '{Hi|Hello|Namaste} {{first_name}}' },
  { label: 'Wish', text: '{Wishing you|Sending you} {joy|happiness|good health|lots of love}' },
  { label: 'Sign-off', text: '{With love|Warm regards|Best wishes}' },
];

interface UploadState {
  phase: 'uploading' | 'compressing';
  fileName: string;
  kind: 'image' | 'video';
  percent: number;
  stage: string;
  jobId: string | null;
  cancel: (() => void) | null;
}

type DraftStatus = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

export function BroadcastComposer({
  sessionId,
  groups,
  contacts,
  connected,
  onCreated,
  onGoToContacts,
  occasionRequest = null,
}: BroadcastComposerProps) {
  const [groupId, setGroupId] = useState<string>('');
  const [campaignName, setCampaignName] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [occasionId, setOccasionId] = useState<string>(FIRST_OCCASION.id);
  const [language, setLanguage] = useState<TemplateLanguage>('en');
  const [pacing, setPacing] = useState<PacingMode>('careful');
  const [card, setCard] = useState<{ title: string; subtitle: string } | null>(null);
  /** Text that was replaced by the last occasion/language switch, offered back via "Undo". */
  const [undoText, setUndoText] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const occasion = getOccasion(occasionId) ?? FIRST_OCCASION;
  // Browser-only (today's date and the viewer's locale), so server and client HTML match.
  const [upcoming, setUpcoming] = useState<UpcomingOccasion[]>([]);
  const [nextDates, setNextDates] = useState<Record<string, { date: Date; approximate: boolean } | null>>({});
  useEffect(() => {
    const now = new Date();
    setUpcoming(upcomingOccasions(now, 4));
    setNextDates(Object.fromEntries(OCCASIONS.map((o) => [o.id, nextOccurrence(o, now)])));
  }, []);

  /** "25 Dec 2026", "≈ 29 Oct 2027", "Any date" (personal) — shown in front of each occasion. */
  const dateLabel = (o: Occasion): string => {
    if (!o.date) return 'Any date';
    const next = nextDates[o.id];
    if (next === undefined) return '…';
    if (next === null) return 'Date to be confirmed';
    const text = next.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return next.approximate ? `≈ ${text}` : text;
  };
  const byDate = (a: Occasion, b: Occasion): number =>
    (nextDates[a.id]?.date.getTime() ?? Number.MAX_SAFE_INTEGER) - (nextDates[b.id]?.date.getTime() ?? Number.MAX_SAFE_INTEGER);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [compress, setCompress] = useState(true);

  // Remember the compress / original choice in this browser.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(COMPRESS_PREF_KEY) === 'false') setCompress(false);
    } catch {
      // storage unavailable
    }
  }, []);
  const chooseCompress = (value: boolean) => {
    setCompress(value);
    try {
      window.localStorage.setItem(COMPRESS_PREF_KEY, String(value));
    } catch {
      // storage unavailable
    }
  };
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [quietHours, setQuietHours] = useState<QuietHoursSettings | null>(null);
  const [quietEdit, setQuietEdit] = useState<{ enabled: boolean; start: string; end: string } | null>(null);
  const [quietError, setQuietError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('loading');
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [seed, setSeed] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSavedDraft = useRef<string>('');

  // ---- Draft: load once, then auto-save -------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    api
      .draft(sessionId)
      .then((d) => {
        if (cancelled) return;
        if (d.updatedAt) {
          if (d.groupId) setGroupId(d.groupId);
          setCampaignName(d.name);
          setTemplate(d.messageTemplate);
          setMedia(d.media);
          if (isOccasionId(d.occasion)) setOccasionId(d.occasion);
          if (d.language === 'hi' || d.language === 'hinglish' || d.language === 'en') setLanguage(d.language);
          if (isPacingMode(d.pacing)) setPacing(d.pacing);
          if (d.scheduledAt && new Date(d.scheduledAt).getTime() > Date.now()) {
            setSendMode('schedule');
            setScheduleLocal(toLocalInputValue(new Date(d.scheduledAt)));
          }
          setDraftSavedAt(d.updatedAt);
        }
        setDraftStatus(d.updatedAt ? 'saved' : 'idle');
      })
      .catch(() => {
        if (!cancelled) setDraftStatus('idle');
      });
    api
      .quietHours(sessionId)
      .then((q) => {
        if (!cancelled) setQuietHours(q);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const scheduledAtIso = useMemo(() => {
    if (sendMode !== 'schedule' || !scheduleLocal) return null;
    const d = new Date(scheduleLocal);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [sendMode, scheduleLocal]);

  const draftPayload = useMemo(
    () => ({
      groupId: groupId || null,
      name: campaignName,
      messageTemplate: template,
      mediaFile: media?.file ?? null,
      scheduledAt: scheduledAtIso,
      occasion: occasionId,
      language,
      pacing,
    }),
    [groupId, campaignName, template, media, scheduledAtIso, occasionId, language, pacing],
  );

  useEffect(() => {
    if (draftStatus === 'loading') return;
    const serialized = JSON.stringify(draftPayload);
    if (!lastSavedDraft.current) {
      lastSavedDraft.current = serialized; // what we just loaded — nothing to save yet
      return;
    }
    if (serialized === lastSavedDraft.current) return;
    const timer = setTimeout(() => {
      setDraftStatus('saving');
      api
        .saveDraft(sessionId, draftPayload)
        .then((r) => {
          lastSavedDraft.current = serialized;
          setDraftSavedAt(r.updatedAt);
          setDraftStatus('saved');
        })
        .catch(() => setDraftStatus('error'));
    }, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftPayload, draftStatus, sessionId]);

  // ---- Groups / preview ---------------------------------------------------------------

  useEffect(() => {
    if (draftStatus === 'loading') return;
    if (!groupId && groups[0]) setGroupId(groups[0].id);
    if (groupId && groups.length > 0 && !groups.some((g) => g.id === groupId)) setGroupId(groups[0]?.id ?? '');
  }, [groups, groupId, draftStatus]);

  const group = groups.find((g) => g.id === groupId) ?? null;
  const recipients = group?.contactIds.length ?? 0;
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const previewUrl = media ? `/uploads/${media.file}` : null;
  const isVideo = media?.mediaType === 'video';

  const sampleContact = useMemo(() => {
    if (!group || group.contactIds.length === 0) return null;
    const id = group.contactIds[seed % group.contactIds.length];
    return id ? contactById.get(id) ?? null : null;
  }, [group, seed, contactById]);

  const templateError = validateTemplate(template);
  const variations = templateError ? 0 : countVariations(template);
  const preview = useMemo(() => {
    if (templateError) return '';
    return renderMessage(template, {
      name: sampleContact ? sampleContact.name ?? sampleContact.pushName : 'Priya Sharma',
      phone: sampleContact?.phone ?? '+919876543210',
    });
    // `seed` is intentionally a dependency so "shuffle" re-rolls the spintax.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, sampleContact, templateError, seed]);

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setTemplate((t) => t + snippet);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = template.slice(0, start) + snippet + template.slice(end);
    setTemplate(next.slice(0, MAX_TEMPLATE));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  /** WhatsApp formatting markers: *bold*, _italic_, ~strike~. */
  const wrapSelection = (marker: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = template.slice(start, end) || 'text';
    const next = `${template.slice(0, start)}${marker}${selectedText}${marker}${template.slice(end)}`;
    setTemplate(next.slice(0, MAX_TEMPLATE));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + marker.length, start + marker.length + selectedText.length);
    });
  };

  // ---- Attachments: upload → server compresses → ready -----------------------------------

  // Refs mirror state so async callbacks always see the latest values.
  const uploadRef = useRef<UploadState | null>(null);
  uploadRef.current = upload;
  const mediaRef = useRef<MediaInfo | null>(null);
  mediaRef.current = media;

  const setUploadState = (next: UploadState | null) => {
    uploadRef.current = next;
    setUpload(next);
  };

  const finishJob = useCallback(
    (job: MediaJob) => {
      const current = uploadRef.current;
      if (!current || current.jobId !== job.id) return;
      if (job.status === 'processing') {
        setUploadState({ ...current, percent: job.progress, stage: job.stage });
        return;
      }
      setUploadState(null);
      if (job.status === 'ready' && job.result) {
        const previous = mediaRef.current;
        setMedia(job.result);
        if (previous && previous.file !== job.result.file) void api.deleteMedia(sessionId, previous.file);
      } else {
        setError(job.error ?? 'Could not process the file.');
      }
    },
    [sessionId],
  );

  // Follow the compression job: live socket updates, plus polling in case an event is missed.
  const activeJobId = upload?.jobId ?? null;
  useEffect(() => {
    if (!activeJobId) return;
    const socket = getSocket();
    const onJob = (job: MediaJob) => {
      if (job.id === activeJobId) finishJob(job);
    };
    socket.on('media_job', onJob);
    const poll = setInterval(() => {
      api
        .mediaJob(sessionId, activeJobId)
        .then(finishJob)
        .catch((err: unknown) => {
          setUploadState(null);
          setError(err instanceof Error ? err.message : 'Lost track of the upload. Attach the file again.');
        });
    }, 3_000);
    return () => {
      socket.off('media_job', onJob);
      clearInterval(poll);
    };
  }, [activeJobId, finishJob, sessionId]);

  const onFileChosen = (chosen: File | null) => {
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!chosen) return;
    const kind = chosen.type.startsWith('image/') || IMAGE_EXT.test(chosen.name) ? 'image' : chosen.type.startsWith('video/') || VIDEO_EXT.test(chosen.name) ? 'video' : null;
    if (!kind || (kind === 'image' && !IMAGE_EXT.test(chosen.name) && !/^image\/(jpeg|png|webp)$/.test(chosen.type))) {
      setError('Attach a JPG, PNG or WebP image, or an MP4, MOV or MKV video.');
      return;
    }
    if (compress) {
      if (kind === 'image' && chosen.size > IMAGE_MAX) return setError('Images can be up to 25 MB.');
      if (kind === 'video' && chosen.size > VIDEO_MAX) return setError('Videos can be up to 500 MB before compression.');
    } else {
      if (kind === 'video' && !/\.mp4$/i.test(chosen.name)) {
        return setError('To send a video as-is it must be an MP4. Choose “Compress” for MOV or MKV videos.');
      }
      if (kind === 'image' && chosen.size > ORIGINAL_IMAGE_MAX) {
        return setError('Original images can be up to 16 MB. Choose “Compress” for this photo.');
      }
      if (kind === 'video' && chosen.size > ORIGINAL_VIDEO_MAX) {
        return setError('Original videos can be up to 64 MB. Choose “Compress” for this video.');
      }
    }

    const { promise, cancel } = uploadMedia(sessionId, chosen, compress, (percent) => {
      const u = uploadRef.current;
      if (u && u.phase === 'uploading') setUploadState({ ...u, percent });
    });
    setUploadState({ phase: 'uploading', fileName: chosen.name, kind, percent: 0, stage: 'Uploading', jobId: null, cancel });
    promise
      .then((job) => {
        const u = uploadRef.current;
        if (!u) return; // cancelled meanwhile
        setUploadState({ ...u, phase: 'compressing', percent: job.progress, stage: job.stage, jobId: job.id, cancel: null });
        if (job.status !== 'processing') finishJob(job);
      })
      .catch((err: unknown) => {
        setUploadState(null);
        if (err instanceof Error && err.message === 'Upload cancelled.') return;
        setError(err instanceof Error ? err.message : 'Upload failed.');
      });
  };

  const removeMedia = () => {
    if (media) void api.deleteMedia(sessionId, media.file);
    setMedia(null);
  };

  // ---- Schedule & quiet hours ----------------------------------------------------------

  const startAt = scheduledAtIso ? new Date(scheduledAtIso) : null;
  const etaMs = estimateDurationMs(recipients, pacing);
  const touchesQuiet = quietHours ? runTouchesQuietHours(startAt ?? new Date(), etaMs, quietHours) : false;

  const saveQuiet = async () => {
    if (!quietEdit) return;
    setQuietError(null);
    try {
      setQuietHours(await api.saveQuietHours(sessionId, quietEdit));
      setQuietEdit(null);
    } catch (err) {
      setQuietError(err instanceof Error ? err.message : 'Could not save quiet hours.');
    }
  };

  // ---- Occasion, templates and e-cards -------------------------------------------------

  /** Switch occasion/language; replace the text only if it's still an unedited built-in template. */
  /** Switch occasion and/or language and load that occasion's message (the old text can be restored). */
  const chooseOccasion = (id: string, lang: TemplateLanguage = language) => {
    const next = getOccasion(id);
    if (!next) return;
    setOccasionId(id);
    setLanguage(lang);
    setCard(null);
    const nextText = next.templates[lang];
    if (nextText === template) return;
    // Keep offering the person's own text back across several switches (built-in templates
    // don't need an undo); it's dropped once they start editing the new message.
    if (!isStockTemplate(template)) setUndoText(template);
    setTemplate(nextText);
  };

  // "Start a … broadcast" from the dashboard banner.
  useEffect(() => {
    if (!occasionRequest || draftStatus === 'loading') return;
    chooseOccasion(occasionRequest.id, language);
    // Only react to new requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occasionRequest?.nonce, draftStatus === 'loading']);

  const createCard = async () => {
    if (!card) return;
    setCardBusy(true);
    setError(null);
    try {
      const made = await api.createECard(sessionId, { occasion: occasion.id, title: card.title, subtitle: card.subtitle });
      const previous = mediaRef.current;
      setMedia(made);
      if (previous && previous.file !== made.file) void api.deleteMedia(sessionId, previous.file);
      setCard(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the e-card.');
    } finally {
      setCardBusy(false);
    }
  };

  const validationError = (() => {
    if (!group) return 'Create a contact group first.';
    if (recipients === 0) return 'The selected group has no contacts.';
    if (upload) return 'Wait for the attachment to finish processing.';
    if (!template.trim() && !media) return 'Write a message or attach media.';
    if (templateError) return templateError;
    if (sendMode === 'schedule' && (!startAt || startAt.getTime() < Date.now() + 60_000)) {
      return 'Pick a start time at least a minute from now.';
    }
    return null;
  })();

  const submit = async () => {
    if (!group || validationError) return;
    setSubmitting(true);
    setError(null);
    try {
      const campaign = await api.createCampaign(sessionId, {
        groupId: group.id,
        messageTemplate: template,
        name: campaignName.trim() || undefined,
        mediaFile: media?.file ?? null,
        scheduledAt: sendMode === 'schedule' ? scheduledAtIso : null,
        pacing,
        occasion: occasionId,
      });
      setModalOpen(false);
      // The server cleared the draft; start the next one fresh (the template is kept for reuse).
      setMedia(null);
      setCampaignName('');
      setSendMode('now');
      setScheduleLocal('');
      onCreated(campaign);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the campaign');
    } finally {
      setSubmitting(false);
    }
  };

  if (groups.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 p-12 text-center">
        <Users className="h-10 w-10 text-diya-400" />
        <h2 className="text-lg font-semibold">Create a contact group first</h2>
        <p className="max-w-md text-sm text-stone-500">
          Broadcasts are sent to a saved group such as “Family” or “Colleagues”. Pick contacts and save a group, then come back
          here.
        </p>
        <button type="button" className="btn-primary" onClick={onGoToContacts}>
          Go to Contacts & Groups
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="card flex flex-col gap-5 p-6">
        <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[240px] flex-1">
              <span className="mb-1.5 block text-sm font-medium text-stone-700">Occasion</span>
              <select id="occasion" className="input" value={occasionId} onChange={(e) => chooseOccasion(e.target.value)}>
                {(Object.keys(CATEGORY_LABELS) as OccasionCategory[]).map((cat) => (
                  <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                    {OCCASIONS.filter((o) => o.category === cat)
                      .sort(byDate)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {dateLabel(o)} — {o.emoji} {o.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1.5 block text-sm font-medium text-stone-700">Language</span>
              <select
                id="language"
                className="input w-auto"
                value={language}
                onChange={(e) => chooseOccasion(occasionId, e.target.value as TemplateLanguage)}
              >
                {(Object.keys(LANGUAGE_LABELS) as TemplateLanguage[]).map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => chooseOccasion(occasionId, language)}
              title="Replace the message with this occasion's template"
            >
              <Sparkles className="h-4 w-4" /> Use template
            </button>
          </div>
          {upcoming.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-stone-500">Coming up:</span>
              {upcoming.map((u) => (
                <button
                  key={u.occasion.id}
                  type="button"
                  className={`chip ring-1 transition ${
                    u.occasion.id === occasionId ? 'bg-diya-100 text-diya-800 ring-diya-300' : 'bg-surface text-stone-700 ring-stone-200 hover:bg-stone-100'
                  }`}
                  onClick={() => chooseOccasion(u.occasion.id, language)}
                  title={u.approximate ? 'Date varies by region and year — please double-check' : undefined}
                >
                  {u.occasion.emoji} {u.occasion.name} · {describeDaysAway(u.daysAway)}
                  {' '}({u.approximate ? '≈ ' : ''}
                  {u.date.toLocaleDateString([], { day: 'numeric', month: 'short' })})
                </button>
              ))}
            </div>
          )}
          {undoText !== null && (
            <p className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-3 py-1.5 text-xs text-sky-800">
              Message switched to the {occasion.name} template ({LANGUAGE_LABELS[language]}).
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => {
                  setTemplate(undoText);
                  setUndoText(null);
                }}
              >
                Undo — bring back my previous message
              </button>
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-stone-700">Send to group</span>
            <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.contactIds.length})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-stone-700">
              Campaign name <span className="font-normal text-stone-400">(optional)</span>
            </span>
            <input
              className="input"
              placeholder={`${occasion.name} ${new Date().getFullYear()} – Family`}
              value={campaignName}
              maxLength={120}
              onChange={(e) => setCampaignName(e.target.value)}
            />
          </label>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-stone-700">Message</span>
            <span className={`text-xs ${template.length > MAX_TEMPLATE * 0.9 ? 'text-rose-600' : 'text-stone-400'}`}>
              {template.length}/{MAX_TEMPLATE}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-stone-200 focus-within:border-diya-400 focus-within:ring-2 focus-within:ring-diya-100">
            <div className="flex flex-wrap items-center gap-1 border-b border-stone-100 bg-stone-50/80 px-2 py-1.5">
              <button type="button" className="btn-ghost p-1.5" title="Bold (*text*)" onClick={() => wrapSelection('*')}>
                <Bold className="h-4 w-4" />
              </button>
              <button type="button" className="btn-ghost p-1.5" title="Italic (_text_)" onClick={() => wrapSelection('_')}>
                <Italic className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="btn-ghost p-1.5"
                title="Strikethrough (~text~)"
                onClick={() => wrapSelection('~')}
              >
                <Strikethrough className="h-4 w-4" />
              </button>
              <span className="mx-1 h-5 w-px bg-stone-200" />
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.tag}
                  type="button"
                  className="chip bg-sky-50 font-mono text-sky-700 hover:bg-sky-100"
                  title={v.description}
                  onClick={() => insertAtCursor(v.tag)}
                >
                  {v.tag}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-stone-200" />
              {[occasion.emoji, ...BASE_EMOJIS.filter((e) => e !== occasion.emoji)].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded-md px-1 text-base hover:bg-stone-200"
                  onClick={() => insertAtCursor(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="block min-h-[240px] w-full resize-y border-0 bg-surface px-4 py-3 font-mono text-sm leading-relaxed outline-none"
              value={template}
              maxLength={MAX_TEMPLATE}
              onChange={(e) => {
                setTemplate(e.target.value);
                setUndoText(null); // once they start editing the new text, the undo no longer applies
              }}
              spellCheck
            />
          </div>
          {templateError && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-600">
              <AlertTriangle className="h-3.5 w-3.5" /> {templateError}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-900">
            <Sparkles className="h-4 w-4" /> Spintax makes every message unique
          </p>
          <p className="text-xs leading-relaxed text-violet-800">
            Write alternatives inside braces separated by pipes — <code className="font-mono">{'{Hi|Hello|Namaste}'}</code>.
            One option is picked at random for each recipient. Groups can be nested:{' '}
            <code className="font-mono">{'{Have a {great|lovely} day|Enjoy}'}</code>. Use{' '}
            <code className="font-mono">{'{{name}}'}</code> for the contact&apos;s name (falls back to “Friend”).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SPINTAX_SNIPPETS.map((s) => (
              <button
                key={s.label}
                type="button"
                className="chip bg-surface text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100"
                onClick={() => insertAtCursor(s.text)}
              >
                + {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-stone-700">
            Attachment <span className="font-normal text-stone-400">(optional — message becomes the caption)</span>
          </span>
          {upload ? (
            <div className="rounded-xl border border-diya-200 bg-diya-50/50 p-4" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2 font-medium text-stone-800">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-diya-500" />
                  <span className="truncate">{upload.fileName}</span>
                </span>
                {upload.cancel && (
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={upload.cancel}>
                    Cancel
                  </button>
                )}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200">
                <div className="h-full bg-diya-500 transition-all duration-300" style={{ width: `${upload.percent}%` }} />
              </div>
              <p className="mt-2 text-xs text-stone-600">
                {upload.phase === 'uploading'
                  ? `Uploading… ${upload.percent}%`
                  : `${upload.stage} · ${upload.percent}%`}
                {upload.phase === 'compressing' && upload.kind === 'video' && (
                  <> — videos can take a minute or two. You can keep writing meanwhile.</>
                )}
              </p>
            </div>
          ) : media && previewUrl ? (
            <div className="flex items-start gap-4 rounded-xl border border-stone-200 p-3">
              {isVideo ? (
                <video src={previewUrl} className="h-28 w-40 rounded-lg bg-black object-cover" controls muted />
              ) : (
                <img src={previewUrl} alt="Attachment preview" className="h-28 w-40 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex items-center gap-1.5 truncate font-medium text-stone-800">
                  {isVideo ? <Video className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
                  {media.originalName}
                </p>
                {media.compressed === false ? (
                  <p className="mt-1 text-xs text-stone-600">
                    Original, not compressed · <strong className="text-stone-800">{formatBytes(media.size)}</strong>
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-stone-600">
                    Compressed <span className="line-through opacity-70">{formatBytes(media.originalSize)}</span> →{' '}
                    <strong className="text-emerald-700">{formatBytes(media.size)}</strong>
                  </p>
                )}
                <p className="text-xs text-stone-500">
                  {media.width && media.height ? `${media.width}×${media.height}` : ''}
                  {media.durationSec ? ` · ${formatDuration(media.durationSec * 1000)}` : ''}
                  {media.compressed === false
                    ? ` · ${media.mimeType.replace(/^\w+\//, '').toUpperCase()}`
                    : isVideo
                      ? ' · H.264 MP4'
                      : ' · JPEG, metadata removed'}
                </p>
                {media.note && <p className="mt-1 text-xs text-amber-700">{media.note}</p>}
                {media.compressed === false && media.size > 5 * 1024 * 1024 && (
                  <p className="mt-1 text-xs text-amber-700">
                    Large file: it is uploaded once per recipient, so sending takes longer and may fail on slow
                    connections.
                  </p>
                )}
              </div>
              <button type="button" className="btn-ghost p-1.5" onClick={removeMedia} title="Remove attachment">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
            {card ? (
              <div className="mb-3 rounded-xl border border-diya-200 bg-diya-50/50 p-3">
                <p className="mb-2 text-sm font-medium text-stone-800">
                  {occasion.emoji} {occasion.name} e-card
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    id="card-title"
                    className="input"
                    maxLength={40}
                    value={card.title}
                    onChange={(e) => setCard({ ...card, title: e.target.value })}
                    aria-label="Card title"
                  />
                  <input
                    id="card-subtitle"
                    className="input"
                    maxLength={80}
                    placeholder="Sign-off, e.g. From the Sharma family"
                    value={card.subtitle}
                    onChange={(e) => setCard({ ...card, subtitle: e.target.value })}
                    aria-label="Card sign-off"
                  />
                </div>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="btn-primary" disabled={cardBusy || !card.title.trim()} onClick={() => void createCard()}>
                    {cardBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Palette className="h-4 w-4" />} Create card
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setCard(null)}>
                    Cancel
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-stone-500">
                  Everyone gets the same card (it's uploaded once); the caption below stays personalised.
                </p>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary mb-3 w-full"
                onClick={() => setCard({ title: occasion.card.title[language === 'hi' ? 'hi' : 'en'], subtitle: '' })}
              >
                <Palette className="h-4 w-4" /> Create a {occasion.name} e-card
              </button>
            )}
            <div className="mb-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to send the attachment">
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
                  compress ? 'border-diya-400 bg-diya-50/60' : 'border-stone-200'
                }`}
              >
                <input type="radio" name="compress-mode" className="mt-0.5 accent-diya-500" checked={compress} onChange={() => chooseCompress(true)} />
                <span>
                  <span className="block text-sm font-medium text-stone-800">Compress (recommended)</span>
                  Smaller files send faster and more reliably to every recipient.
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
                  !compress ? 'border-diya-400 bg-diya-50/60' : 'border-stone-200'
                }`}
              >
                <input type="radio" name="compress-mode" className="mt-0.5 accent-diya-500" checked={!compress} onChange={() => chooseCompress(false)} />
                <span>
                  <span className="block text-sm font-medium text-stone-800">Send original</span>
                  Exactly as uploaded: photos up to 16 MB, MP4 videos up to 64 MB.
                </span>
              </label>
            </div>
            <button
              type="button"
              className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500 transition hover:border-diya-300 hover:bg-diya-50/40"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Attach an image or video
              </span>
              <span className="text-xs text-stone-400">
                {compress
                  ? 'JPG/PNG/WebP up to 25 MB · MP4/MOV/MKV up to 500 MB — compressed automatically'
                  : 'JPG/PNG/WebP up to 16 MB · MP4 up to 64 MB — sent unchanged'}
              </span>
            </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={compress ? ACCEPT : ACCEPT_ORIGINAL}
            className="hidden"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-stone-700">Sending speed</span>
          <div className="mb-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Sending speed">
            {PACING_MODES.map((mode) => (
              <label
                key={mode}
                className={`flex cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2.5 text-xs ${
                  pacing === mode ? 'border-diya-400 bg-diya-50/60' : 'border-stone-200'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-stone-800">
                  <input type="radio" name="pacing" className="accent-diya-500" checked={pacing === mode} onChange={() => setPacing(mode)} />
                  {PACING_PROFILES[mode].label}
                  <span className="ml-auto text-xs font-normal text-stone-500">
                    ~{formatDuration(estimateDurationMs(Math.max(recipients, 1), mode))}
                  </span>
                </span>
                <span className="text-stone-500">{PACING_PROFILES[mode].summary}</span>
              </label>
            ))}
          </div>
          {pacing !== 'careful' && (
            <p className="-mt-2 mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Faster sending finishes sooner but raises the chance of WhatsApp restricting your number — no pacing can
              hide automation. It matters most with large groups or contacts who don&apos;t know you.
            </p>
          )}

          <span className="mb-1.5 block text-sm font-medium text-stone-700">When to send</span>
          <div className="grid gap-2 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                sendMode === 'now' ? 'border-diya-400 bg-diya-50/60' : 'border-stone-200'
              }`}
            >
              <input type="radio" name="send-mode" className="accent-diya-500" checked={sendMode === 'now'} onChange={() => setSendMode('now')} />
              <Send className="h-4 w-4 text-stone-500" /> Start right away
            </label>
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                sendMode === 'schedule' ? 'border-diya-400 bg-diya-50/60' : 'border-stone-200'
              }`}
            >
              <input
                type="radio"
                name="send-mode"
                className="accent-diya-500"
                checked={sendMode === 'schedule'}
                onChange={() => {
                  setSendMode('schedule');
                  if (!scheduleLocal) {
                    const tomorrow7 = new Date();
                    tomorrow7.setDate(tomorrow7.getDate() + 1);
                    tomorrow7.setHours(7, 0, 0, 0);
                    setScheduleLocal(toLocalInputValue(tomorrow7));
                  }
                }}
              />
              <CalendarClock className="h-4 w-4 text-stone-500" /> Schedule for later
            </label>
          </div>
          {sendMode === 'schedule' && (
            <div className="mt-3">
              <input
                id="schedule-at"
                type="datetime-local"
                className="input w-auto"
                value={scheduleLocal}
                min={toLocalInputValue(new Date(Date.now() + 60_000))}
                onChange={(e) => setScheduleLocal(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-stone-500">
                In your browser&apos;s time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). The server starts it on
                its own — you can close this page.
              </p>
            </div>
          )}

          <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2.5 text-xs text-stone-600">
            {quietEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-diya-500"
                    checked={quietEdit.enabled}
                    onChange={(e) => setQuietEdit({ ...quietEdit, enabled: e.target.checked })}
                  />
                  Quiet hours from
                </label>
                <input
                  id="quiet-start"
                  type="time"
                  className="input w-auto px-2 py-1 text-xs"
                  value={quietEdit.start}
                  onChange={(e) => setQuietEdit({ ...quietEdit, start: e.target.value })}
                />
                to
                <input
                  id="quiet-end"
                  type="time"
                  className="input w-auto px-2 py-1 text-xs"
                  value={quietEdit.end}
                  onChange={(e) => setQuietEdit({ ...quietEdit, end: e.target.value })}
                />
                <span className="text-stone-400">({quietHours?.timeZone})</span>
                <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={() => void saveQuiet()}>
                  <Check className="h-3.5 w-3.5" /> Save
                </button>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setQuietEdit(null)}>
                  Cancel
                </button>
                {quietError && <span className="w-full text-rose-600">{quietError}</span>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <Moon className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
                  {quietHours?.enabled ? (
                    <>
                      Quiet hours <strong className="text-stone-800">{quietHours.start}–{quietHours.end}</strong> (
                      {quietHours.timeZone}): sending pauses and resumes by itself.
                      {quietHours.activeNow && <strong className="text-amber-700"> In effect now.</strong>}
                    </>
                  ) : (
                    'Quiet hours are off — messages can go out at any time.'
                  )}
                </span>
                {quietHours && (
                  <button
                    type="button"
                    className="font-medium text-diya-700 hover:underline"
                    onClick={() => setQuietEdit({ enabled: quietHours.enabled, start: quietHours.start, end: quietHours.end })}
                  >
                    Change
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}
      </section>

      <aside className="flex flex-col gap-4">
        <section className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold text-stone-900">Live preview</h3>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setSeed((s) => s + 1)}>
              <Shuffle className="h-3.5 w-3.5" /> Shuffle
            </button>
          </div>
          <div className="palette-light rounded-2xl bg-[#e7ddd3] p-4">
            <div className="ml-auto max-w-[95%] rounded-xl rounded-tr-sm bg-[#d9fdd3] p-2 shadow-sm">
              {previewUrl &&
                (isVideo ? (
                  <video src={previewUrl} className="mb-2 w-full rounded-lg" muted />
                ) : (
                  <img src={previewUrl} alt="" className="mb-2 w-full rounded-lg" />
                ))}
              <p className="whitespace-pre-wrap break-words px-1 text-sm text-stone-800">
                {preview || <span className="italic text-stone-400">Your message preview…</span>}
              </p>
              <p className="mt-1 text-right text-[10px] text-stone-500">now ✓✓</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Previewing for <strong>{sampleContact ? contactDisplayName(sampleContact) : 'a sample contact'}</strong>
          </p>
        </section>

        <section className="card space-y-3 p-5 text-sm">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-stone-600">
              <Users className="h-4 w-4" /> Recipients
            </span>
            <strong>{recipients}</strong>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-stone-600">
              <Sparkles className="h-4 w-4" /> Unique variations
            </span>
            <strong>{variations > 1_000_000 ? '1M+' : variations.toLocaleString()}</strong>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-stone-600">
              <Clock className="h-4 w-4" /> Estimated time
            </span>
            <strong>~{formatDuration(etaMs)}</strong>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-stone-600">
              <CalendarClock className="h-4 w-4" /> Starts
            </span>
            <strong>
              {startAt ? startAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Right away'}
            </strong>
          </div>
          {touchesQuiet && quietHours && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">
              This run overlaps quiet hours ({describeWindow(quietHours)}). It pauses then and continues at{' '}
              {quietHours.end}, so it finishes later than the estimate.
            </p>
          )}
          {variations > 0 && variations < Math.min(recipients, 10) && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Add more spintax options so recipients don&apos;t all receive identical text.
            </p>
          )}
          {!connected && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              WhatsApp is not connected right now. You can still queue — sending starts once it reconnects.
            </p>
          )}
          <button
            type="button"
            className="btn-primary w-full py-3"
            disabled={validationError !== null}
            onClick={() => {
              setError(null);
              setModalOpen(true);
            }}
            title={validationError ?? undefined}
          >
            {sendMode === 'schedule' ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {sendMode === 'schedule' ? 'Review & schedule' : 'Review & send'}
          </button>
          {validationError && <p className="text-center text-xs text-stone-500">{validationError}</p>}
          <p className="text-center text-xs text-stone-400" aria-live="polite">
            {draftStatus === 'saving' && 'Saving draft…'}
            {draftStatus === 'saved' && draftSavedAt && `Draft saved ${formatRelative(draftSavedAt)}`}
            {draftStatus === 'error' && <span className="text-rose-600">Couldn’t save the draft — check the connection.</span>}
          </p>
        </section>
      </aside>

      <SummaryModal
        open={modalOpen}
        groupName={group?.name ?? ''}
        recipients={recipients}
        variations={variations}
        media={media}
        pacing={pacing}
        startAt={startAt}
        quietHours={touchesQuiet ? quietHours : null}
        preview={preview}
        submitting={submitting}
        error={error}
        onCancel={() => setModalOpen(false)}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
