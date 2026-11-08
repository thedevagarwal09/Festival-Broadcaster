'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  FolderMinus,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UserRound,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { contactDisplayName, formatRelative, initials } from '@/lib/format';
import type { ContactDTO, ContactSyncState, GroupDTO, SmartCategory } from '@/lib/types';
import { SMART_META, SmartGroupsCard } from './SmartGroupsCard';

interface ContactsManagerProps {
  sessionId: string;
  contacts: ContactDTO[];
  groups: GroupDTO[];
  loading: boolean;
  /** Saved count, last address-book sync and whether a sync is running. */
  syncState: ContactSyncState | null;
  /** WhatsApp is connected, so "Sync now" can run. */
  connected: boolean;
  onSyncNow: () => Promise<void>;
  onGroupsChanged: () => Promise<void>;
}

type Filter = 'all' | 'named' | 'unnamed' | 'ungrouped' | 'selected' | `group:${string}` | `cat:${SmartCategory}`;

const PAGE_SIZE = 200;
const GROUP_SUGGESTIONS = ['Diwali - Family', 'Diwali - Friends', 'Diwali - Colleagues', 'Diwali - Clients'];

export function ContactsManager({
  sessionId,
  contacts,
  groups,
  loading,
  syncState,
  connected,
  onSyncNow,
  onGroupsChanged,
}: ContactsManagerProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [autoAddNew, setAutoAddNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [targetGroupId, setTargetGroupId] = useState('');
  const [bulkBusy, setBulkBusy] = useState<'move' | 'add' | 'remove' | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [bulkMessage, setBulkMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return contacts.filter((c) => {
      if (filter === 'named' && !c.name && !c.pushName) return false;
      if (filter === 'unnamed' && (c.name || c.pushName)) return false;
      if (filter === 'ungrouped' && c.groupIds.length > 0) return false;
      if (filter === 'selected' && !selected.has(c.id)) return false;
      if (filter.startsWith('group:') && !c.groupIds.includes(filter.slice(6))) return false;
      if (filter.startsWith('cat:') && c.chatCategory !== filter.slice(4)) return false;
      if (!q) return true;
      const haystack = `${c.name ?? ''} ${c.pushName ?? ''}`.toLowerCase();
      return haystack.includes(q) || (digits.length > 0 && c.phone.replace(/\D/g, '').includes(digits));
    });
  }, [contacts, filter, query, selected]);

  const visible = filtered.slice(0, limit);
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const editingGroup = groups.find((g) => g.id === editingId) ?? null;
  /** The group whose members are being shown — the source for "Move" and "Remove". */
  const viewingGroup = filter.startsWith('group:') ? (groups.find((g) => g.id === filter.slice(6)) ?? null) : null;

  const runBulk = async (action: 'move' | 'add' | 'remove') => {
    const ids = [...selected];
    const target = groups.find((g) => g.id === targetGroupId) ?? null;
    if (ids.length === 0) return;
    if ((action === 'move' || action === 'add') && !target) return;
    if ((action === 'move' || action === 'remove') && !viewingGroup) return;
    setBulkBusy(action);
    setBulkMessage(null);
    try {
      if (action === 'move' && viewingGroup && target) {
        const result = await api.moveContacts(sessionId, viewingGroup.id, target.id, ids);
        setBulkMessage({
          kind: 'ok',
          text: `Moved ${result.moved} contact${result.moved === 1 ? '' : 's'} from “${viewingGroup.name}” to “${target.name}”.`,
        });
      } else if (action === 'add' && target) {
        const already = new Set(target.contactIds);
        const added = ids.filter((id) => !already.has(id)).length;
        await api.groupMembers(sessionId, target.id, 'add', ids);
        setBulkMessage({
          kind: 'ok',
          text:
            added === 0
              ? `All selected contacts were already in “${target.name}”.`
              : `Added ${added} contact${added === 1 ? '' : 's'} to “${target.name}”.`,
        });
      } else if (action === 'remove' && viewingGroup) {
        await api.groupMembers(sessionId, viewingGroup.id, 'remove', ids);
        setBulkMessage({
          kind: 'ok',
          text: `Removed ${ids.length} contact${ids.length === 1 ? '' : 's'} from “${viewingGroup.name}”.`,
        });
      }
      setSelected(new Set());
      await onGroupsChanged();
    } catch (err) {
      setBulkMessage({ kind: 'error', text: err instanceof Error ? err.message : 'That didn’t work. Try again.' });
    } finally {
      setBulkBusy(null);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((c) => next.delete(c.id));
      else filtered.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const startEdit = (group: GroupDTO) => {
    setEditingId(group.id);
    setGroupName(group.name);
    setAutoAddNew(group.autoAddNew);
    setSelected(new Set(group.contactIds));
    setFilter('all');
    setMessage(null);
  };

  const resetEditor = () => {
    setEditingId(null);
    setGroupName('');
    setAutoAddNew(false);
    setSelected(new Set());
  };

  const saveGroup = async () => {
    const name = groupName.trim();
    if (!name) {
      setMessage({ kind: 'error', text: 'Give the group a name first.' });
      return;
    }
    if (selected.size === 0 && !autoAddNew) {
      setMessage({ kind: 'error', text: 'Select at least one contact, or turn on auto-add.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const ids = [...selected];
      if (editingId) await api.updateGroup(sessionId, editingId, name, ids, autoAddNew);
      else await api.createGroup(sessionId, name, ids, autoAddNew);
      await onGroupsChanged();
      setMessage({
        kind: 'ok',
        text: `Saved “${name}” with ${ids.length} contact(s)${autoAddNew ? ' — new contacts will join automatically' : ''}.`,
      });
      resetEditor();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save group' });
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (group: GroupDTO) => {
    if (!window.confirm(`Delete the group “${group.name}”? Contacts are not deleted.`)) return;
    try {
      await api.deleteGroup(sessionId, group.id);
      if (editingId === group.id) resetEditor();
      if (filter === `group:${group.id}`) setFilter('all');
      await onGroupsChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not delete group' });
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      {/* Group builder */}
      <aside className="flex flex-col gap-4">
        <SmartGroupsCard sessionId={sessionId} onApplied={onGroupsChanged} />

        <section className="card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold text-stone-900">
            {editingGroup ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editingGroup ? 'Edit group' : 'New group'}
          </h2>
          <p className="mb-4 text-xs text-stone-500">
            Tick contacts on the right, name the group, then save.
          </p>
          <input
            className="input"
            placeholder="e.g. Diwali - Family"
            value={groupName}
            maxLength={80}
            onChange={(e) => setGroupName(e.target.value)}
          />
          {!editingGroup && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {GROUP_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip bg-diya-50 text-diya-700 hover:bg-diya-100"
                  onClick={() => setGroupName(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl bg-stone-50 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-diya-500"
              checked={autoAddNew}
              onChange={(e) => setAutoAddNew(e.target.checked)}
            />
            <span>
              <span className="flex items-center gap-1 font-medium text-stone-800">
                <Zap className="h-3.5 w-3.5 text-diya-500" /> Auto-add new contacts
              </span>
              <span className="block text-xs text-stone-500">
                Contacts you save on your phone later join this group automatically.
              </span>
            </span>
          </label>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-stone-600">
              <strong className="text-stone-900">{selected.size}</strong> selected
            </span>
            {selected.size > 0 && (
              <button type="button" className="text-xs text-stone-500 hover:text-stone-800" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            )}
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={() => void saveGroup()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editingGroup ? 'Update group' : 'Save group'}
            </button>
            {editingGroup && (
              <button type="button" className="btn-secondary" onClick={resetEditor}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
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

        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 font-semibold text-stone-900">
            <Users className="h-4 w-4" /> Saved groups
          </h2>
          {groups.length === 0 ? (
            <p className="text-sm text-stone-500">No groups yet.</p>
          ) : (
            <ul className="space-y-2">
              {groups.map((g) => (
                <li
                  key={g.id}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 ${
                    editingId === g.id ? 'border-diya-300 bg-diya-50' : 'border-stone-100'
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setFilter(`group:${g.id}`)}
                    title="Show members"
                  >
                    <p className="truncate text-sm font-medium text-stone-800">{g.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-stone-500">
                      {g.contactIds.length} contacts
                      {g.smartKey && (
                        <span className={`chip px-1.5 ${SMART_META[g.smartKey].tone}`} title="Smart group — refreshed each time you update smart groups">
                          smart
                        </span>
                      )}
                      {g.autoAddNew && (
                        <span className="chip bg-diya-50 px-1.5 text-diya-700" title="New contacts join automatically">
                          <Zap className="h-3 w-3" /> auto
                        </span>
                      )}
                    </p>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="btn-ghost p-1.5" onClick={() => startEdit(g)} title="Edit">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost p-1.5 text-rose-600 hover:bg-rose-50"
                      onClick={() => void deleteGroup(g)}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      {/* Contact list */}
      <section className="card flex min-h-[500px] flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 p-4">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              className="input pl-9"
              placeholder="Search by name or number…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </div>
          <select
            className="input w-auto"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as Filter);
              setLimit(PAGE_SIZE);
            }}
          >
            <option value="all">All contacts</option>
            <option value="named">With a name</option>
            <option value="unnamed">Number only</option>
            <option value="ungrouped">Not in any group</option>
            <option value="selected">Selected only</option>
            <option value="cat:frequent">⚡ Frequent chats</option>
            <option value="cat:chatted">💬 Chatted before</option>
            <option value="cat:cold">📇 Never chatted (cold)</option>
            {groups.map((g) => (
              <option key={g.id} value={`group:${g.id}`}>
                In: {g.name}
              </option>
            ))}
          </select>
        </div>

        {/* Sync status: contacts are stored on the server; this only pulls changes. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 bg-stone-50/60 px-4 py-2 text-xs text-stone-500">
          <span>
            {syncState?.syncing ? (
              <span className="inline-flex items-center gap-1.5 text-diya-700">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing address book from WhatsApp…
              </span>
            ) : syncState?.syncedAt ? (
              <>
                <strong className="text-stone-700">{syncState.count.toLocaleString()}</strong> contacts saved · last
                synced {formatRelative(syncState.syncedAt)} · new contacts on your phone appear automatically
              </>
            ) : (
              <>
                <strong className="text-stone-700">{contacts.length.toLocaleString()}</strong> contacts saved · address
                book not synced yet
              </>
            )}
            {syncError && <span className="ml-2 text-rose-600">{syncError}</span>}
          </span>
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={!connected || syncState?.syncing === true}
            title={connected ? 'Pull changes from your phone’s address book now' : 'Connect WhatsApp first'}
            onClick={() => {
              setSyncError(null);
              onSyncNow().catch((err: unknown) =>
                setSyncError(err instanceof Error ? err.message : 'Sync failed.'),
              );
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncState?.syncing ? 'animate-spin' : ''}`} /> Sync now
          </button>
        </div>

        {bulkMessage && (
          <div
            className={`flex items-center justify-between gap-2 border-b px-4 py-2 text-sm ${
              bulkMessage.kind === 'ok' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-rose-100 bg-rose-50 text-rose-700'
            }`}
            role="status"
          >
            <span>{bulkMessage.text}</span>
            <button type="button" className="btn-ghost p-1" onClick={() => setBulkMessage(null)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Bulk actions on the selected contacts (hidden while editing a group on the left). */}
        {selected.size > 0 && !editingGroup && (
          <div className="flex flex-wrap items-center gap-2 border-b border-diya-100 bg-diya-50/70 px-4 py-2.5 text-sm">
            <span className="font-medium text-stone-800">{selected.size} selected</span>
            <select
              className="input w-auto py-1.5 text-sm"
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
              aria-label="Target group"
            >
              <option value="">Choose a group…</option>
              {groups
                .filter((g) => g.id !== viewingGroup?.id)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.contactIds.length})
                  </option>
                ))}
            </select>
            {viewingGroup && (
              <button
                type="button"
                className="btn-primary py-1.5"
                disabled={!targetGroupId || bulkBusy !== null}
                onClick={() => void runBulk('move')}
                title={`Take the selected contacts out of “${viewingGroup.name}” and put them in the chosen group`}
              >
                {bulkBusy === 'move' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                Move
              </button>
            )}
            <button
              type="button"
              className={viewingGroup ? 'btn-secondary py-1.5' : 'btn-primary py-1.5'}
              disabled={!targetGroupId || bulkBusy !== null}
              onClick={() => void runBulk('add')}
              title="Add the selected contacts to the chosen group (they stay in their other groups)"
            >
              {bulkBusy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              Add
            </button>
            {viewingGroup && (
              <button
                type="button"
                className="btn-ghost py-1.5 text-rose-600 hover:bg-rose-50"
                disabled={bulkBusy !== null}
                onClick={() => void runBulk('remove')}
              >
                {bulkBusy === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderMinus className="h-4 w-4" />}
                Remove from “{viewingGroup.name}”
              </button>
            )}
            {!viewingGroup && groups.length > 1 && (
              <span className="text-xs text-stone-500">
                To move contacts, open a group first (click it on the left).
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2 text-xs text-stone-500">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-diya-500"
              checked={allFilteredSelected}
              onChange={toggleAllFiltered}
              disabled={filtered.length === 0}
            />
            Select all {filtered.length} shown
          </label>
          <span>
            {filtered.length} of {contacts.length} contacts
          </span>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          {loading ? (
            <div className="flex h-64 items-center justify-center gap-2 text-stone-500">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading contacts…
            </div>
          ) : contacts.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 px-6 text-center text-stone-500">
              <Loader2 className="h-6 w-6 animate-spin text-diya-400" />
              <p className="font-medium text-stone-700">Syncing contacts from your phone…</p>
              <p className="max-w-sm text-sm">
                WhatsApp sends your contacts a few seconds to a few minutes after linking. Keep your phone online —
                this list fills in automatically.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-8 text-center text-sm text-stone-500">No contacts match your search.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {visible.map((c) => {
                const label = contactDisplayName(c);
                const isSelected = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 transition ${
                        isSelected ? 'bg-diya-50/70' : 'hover:bg-stone-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-diya-500"
                        checked={isSelected}
                        onChange={() => toggle(c.id)}
                      />
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-diya-100 to-rose-100 text-xs font-semibold text-diya-800">
                        {c.name || c.pushName ? initials(label) : <UserRound className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-stone-800">{label}</span>
                        <span className="block truncate text-xs text-stone-500">
                          {c.phone}
                          {!c.name && c.pushName ? ' · WhatsApp name' : ''}
                        </span>
                      </span>
                      <span className="hidden min-w-0 max-w-[50%] shrink items-center justify-end gap-1 overflow-hidden sm:flex">
                        {c.chatCategory && (
                          <span
                            className={`chip shrink-0 ${SMART_META[c.chatCategory].tone}`}
                            title={c.lastChatAt ? `Last chat ${formatRelative(c.lastChatAt)}` : SMART_META[c.chatCategory].hint}
                          >
                            {SMART_META[c.chatCategory].icon} {SMART_META[c.chatCategory].short}
                          </span>
                        )}
                        {(() => {
                          // Smart groups are already shown by the category chip above.
                          const manual = c.groupIds
                            .map((gid) => groups.find((x) => x.id === gid))
                            .filter((g): g is GroupDTO => Boolean(g) && !g?.smartKey);
                          return (
                            <>
                              {manual.slice(0, 2).map((g) => (
                                <span key={g.id} className="chip min-w-0 bg-stone-100 text-stone-600" title={g.name}>
                                  <span className="truncate">{g.name}</span>
                                </span>
                              ))}
                              {manual.length > 2 && (
                                <span className="chip shrink-0 bg-stone-100 text-stone-600">+{manual.length - 2}</span>
                              )}
                            </>
                          );
                        })()}
                      </span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-diya-600" />}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {filtered.length > visible.length && (
            <div className="p-4 text-center">
              <button type="button" className="btn-secondary" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
