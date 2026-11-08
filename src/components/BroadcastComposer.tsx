'use client';

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bold,
  Clock,
  Image as ImageIcon,
  Italic,
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
import { api } from '@/lib/api';
import { contactDisplayName, formatBytes } from '@/lib/format';
import { estimateDurationMs, formatDuration } from '@/lib/pacing';
import { TEMPLATE_VARIABLES, countVariations, renderMessage, validateTemplate } from '@/lib/spintax';
import type { CampaignDTO, ContactDTO, GroupDTO } from '@/lib/types';

interface BroadcastComposerProps {
  sessionId: string;
  groups: GroupDTO[];
  contacts: ContactDTO[];
  connected: boolean;
  onCreated: (campaign: CampaignDTO) => void;
  onGoToContacts: () => void;
}

const DEFAULT_TEMPLATE = `{Happy Diwali|Wishing you a joyful Diwali|Warm Diwali greetings}, {{first_name}}! 🪔

{May this festival of lights|May the glow of a thousand diyas} bring {joy, prosperity and good health|happiness and success} to you and your family. ✨

{With love|Warm regards|Best wishes} 🙏`;

const MAX_TEMPLATE = 4096;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/3gpp'];
const IMAGE_MAX = 16 * 1024 * 1024;
const VIDEO_MAX = 64 * 1024 * 1024;
const EMOJIS = ['🪔', '✨', '🎆', '🎇', '🙏', '🌸', '🍬', '❤️', '🎉', '🕉️'];

const SPINTAX_SNIPPETS = [
  { label: 'Greeting', text: '{Happy Diwali|Wishing you a joyful Diwali|Warm Diwali greetings}' },
  { label: 'Blessing', text: '{May this Diwali bring|Wishing you} {joy|prosperity|happiness}' },
  { label: 'Sign-off', text: '{With love|Warm regards|Best wishes}' },
];

export function BroadcastComposer({
  sessionId,
  groups,
  contacts,
  connected,
  onCreated,
  onGoToContacts,
}: BroadcastComposerProps) {
  const [groupId, setGroupId] = useState<string>('');
  const [campaignName, setCampaignName] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [seed, setSeed] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!groupId && groups[0]) setGroupId(groups[0].id);
    if (groupId && !groups.some((g) => g.id === groupId)) setGroupId(groups[0]?.id ?? '');
  }, [groups, groupId]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const group = groups.find((g) => g.id === groupId) ?? null;
  const recipients = group?.contactIds.length ?? 0;
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

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

  const onFileChosen = (chosen: File | null) => {
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    const isImage = IMAGE_TYPES.includes(chosen.type);
    const isVideo = VIDEO_TYPES.includes(chosen.type);
    if (!isImage && !isVideo) {
      setError('Attach a JPG/PNG/WEBP image or an MP4/3GP video.');
      return;
    }
    if ((isImage && chosen.size > IMAGE_MAX) || (isVideo && chosen.size > VIDEO_MAX)) {
      setError(`File is too large (max ${isImage ? '16' : '64'} MB).`);
      return;
    }
    setFile(chosen);
  };

  const clearFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const validationError = (() => {
    if (!group) return 'Create a contact group first.';
    if (recipients === 0) return 'The selected group has no contacts.';
    if (!template.trim() && !file) return 'Write a message or attach media.';
    if (templateError) return templateError;
    return null;
  })();

  const submit = async () => {
    if (!group || validationError) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('groupId', group.id);
      form.append('messageTemplate', template);
      if (campaignName.trim()) form.append('name', campaignName.trim());
      if (file) form.append('media', file);
      const campaign = await api.createCampaign(sessionId, form);
      setModalOpen(false);
      clearFile();
      setCampaignName('');
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
          Broadcasts are sent to a saved group such as “Diwali - Family”. Pick contacts and save a group, then come back
          here.
        </p>
        <button type="button" className="btn-primary" onClick={onGoToContacts}>
          Go to Contacts & Groups
        </button>
      </div>
    );
  }

  const isVideo = file ? VIDEO_TYPES.includes(file.type) : false;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="card flex flex-col gap-5 p-6">
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
              placeholder="Diwali 2026 – Family"
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
              {EMOJIS.map((emoji) => (
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
              onChange={(e) => setTemplate(e.target.value)}
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
          {file && previewUrl ? (
            <div className="flex items-start gap-4 rounded-xl border border-stone-200 p-3">
              {isVideo ? (
                <video src={previewUrl} className="h-28 w-40 rounded-lg bg-black object-cover" controls muted />
              ) : (
                <img src={previewUrl} alt="Attachment preview" className="h-28 w-40 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex items-center gap-1.5 truncate font-medium text-stone-800">
                  {isVideo ? <Video className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
                  {file.name}
                </p>
                <p className="text-xs text-stone-500">
                  {formatBytes(file.size)} · {file.type}
                </p>
              </div>
              <button type="button" className="btn-ghost p-1.5" onClick={clearFile} title="Remove">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500 transition hover:border-diya-300 hover:bg-diya-50/40"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="h-4 w-4" /> Attach an image (≤16 MB) or MP4 video (≤64 MB)
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={[...IMAGE_TYPES, ...VIDEO_TYPES].join(',')}
            className="hidden"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
          />
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
            <strong>~{formatDuration(estimateDurationMs(recipients))}</strong>
          </div>
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
            <Send className="h-4 w-4" /> Review & send
          </button>
          {validationError && <p className="text-center text-xs text-stone-500">{validationError}</p>}
        </section>
      </aside>

      <SummaryModal
        open={modalOpen}
        groupName={group?.name ?? ''}
        recipients={recipients}
        variations={variations}
        hasMedia={file !== null}
        mediaKind={isVideo ? 'video' : 'image'}
        preview={preview}
        submitting={submitting}
        error={error}
        onCancel={() => setModalOpen(false)}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
