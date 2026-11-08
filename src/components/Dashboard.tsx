'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, LogOut, RefreshCw, Send, Terminal, Users, Wifi, WifiOff } from 'lucide-react';
import { BroadcastComposer } from './BroadcastComposer';
import { ThemeToggle } from './ThemeToggle';
import { ContactsManager } from './ContactsManager';
import { LiveTerminal } from './LiveTerminal';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import type { CampaignDTO, ContactDTO, ContactSyncState, GroupDTO, SessionSnapshot } from '@/lib/types';

type Tab = 'contacts' | 'compose' | 'live';

interface DashboardProps {
  sessionId: string;
  snapshot: SessionSnapshot;
  socketConnected: boolean;
  onLogout: () => Promise<void>;
  onReconnect: () => void;
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Users }> = [
  { id: 'contacts', label: 'Contacts & Groups', icon: Users },
  { id: 'compose', label: 'Compose Broadcast', icon: Send },
  { id: 'live', label: 'Live Dispatch', icon: Terminal },
];

const STATUS_LABEL: Record<SessionSnapshot['status'], string> = {
  idle: 'Offline',
  connecting: 'Connecting…',
  qr: 'Waiting for scan',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  conflict: 'Opened elsewhere',
  logged_out: 'Logged out',
};

export function Dashboard({ sessionId, snapshot, socketConnected, onLogout, onReconnect }: DashboardProps) {
  const [tab, setTab] = useState<Tab>('contacts');
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [groups, setGroups] = useState<GroupDTO[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignDTO[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<ContactSyncState | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadContacts = useCallback(async () => {
    try {
      setContacts(await api.contacts(sessionId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load contacts');
    } finally {
      setLoadingContacts(false);
    }
  }, [sessionId]);

  const loadGroups = useCallback(async () => {
    setGroups(await api.groups(sessionId));
  }, [sessionId]);

  const loadSyncState = useCallback(async () => {
    setSyncState(await api.contactSyncState(sessionId));
  }, [sessionId]);

  const syncNow = useCallback(async () => {
    setSyncState((prev) => (prev ? { ...prev, syncing: true } : prev));
    try {
      setSyncState(await api.syncContactsNow(sessionId));
    } finally {
      loadSyncState().catch(() => undefined);
    }
  }, [sessionId, loadSyncState]);

  const loadCampaigns = useCallback(async () => {
    const list = await api.campaigns(sessionId);
    setCampaigns(list);
    setActiveCampaignId((current) => current ?? list[0]?.id ?? null);
  }, [sessionId]);

  /** Groups embed contact ids, so refresh both together. */
  const reloadGroupsAndContacts = useCallback(async () => {
    await Promise.all([loadGroups(), loadContacts()]);
  }, [loadGroups, loadContacts]);

  useEffect(() => {
    setLoadingContacts(true);
    void loadContacts();
    loadGroups().catch(() => undefined);
    loadCampaigns().catch(() => undefined);
    loadSyncState().catch(() => undefined);
  }, [loadContacts, loadGroups, loadCampaigns, loadSyncState]);

  useEffect(() => {
    const socket = getSocket();
    const onContactsSynced = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return;
      // History sync arrives in bursts — debounce the reload.
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      // Groups too: auto-add groups and merged sessions change membership server-side.
      reloadTimer.current = setTimeout(() => {
        void loadContacts();
        loadGroups().catch(() => undefined);
        loadSyncState().catch(() => undefined);
      }, 1200);
    };
    const onProgress = (campaign: CampaignDTO) => {
      if (campaign.sessionId !== sessionId) return;
      setCampaigns((prev) => {
        const exists = prev.some((c) => c.id === campaign.id);
        return exists ? prev.map((c) => (c.id === campaign.id ? campaign : c)) : [campaign, ...prev];
      });
    };
    const onSyncState = (state: ContactSyncState) => {
      if (state.sessionId === sessionId) setSyncState(state);
    };
    socket.on('contacts_synced', onContactsSynced);
    socket.on('contacts_sync_state', onSyncState);
    socket.on('campaign_progress', onProgress);
    return () => {
      socket.off('contacts_synced', onContactsSynced);
      socket.off('contacts_sync_state', onSyncState);
      socket.off('campaign_progress', onProgress);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [sessionId, loadContacts, loadGroups, loadSyncState]);

  const handleCampaignCreated = useCallback((campaign: CampaignDTO) => {
    setCampaigns((prev) => [campaign, ...prev.filter((c) => c.id !== campaign.id)]);
    setActiveCampaignId(campaign.id);
    setTab('live');
  }, []);

  const handleCampaignChange = useCallback((campaign: CampaignDTO) => {
    setCampaigns((prev) => prev.map((c) => (c.id === campaign.id ? campaign : c)));
  }, []);

  const handleLogout = async () => {
    if (!window.confirm('Unlink this WhatsApp account from Festival Broadcaster?')) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Logout failed');
      setLoggingOut(false);
    }
  };

  const connected = snapshot.status === 'connected' && socketConnected;
  const runningCount = campaigns.filter((c) => c.status === 'PROCESSING').length;

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 p-4 md:p-8">
      <header className="card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-diya-400 to-rose-500 text-2xl">
            🪔
          </span>
          <div>
            <h1 className="text-lg font-bold text-stone-900">Festival Broadcaster</h1>
            <p className="text-sm text-stone-500">
              {snapshot.user?.name ?? 'Your WhatsApp'} · {snapshot.user?.phoneNumber}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`chip ${connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
            title={socketConnected ? undefined : 'Browser lost its connection to the server'}
          >
            {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {socketConnected ? STATUS_LABEL[snapshot.status] : 'Server offline'}
          </span>
          <ThemeToggle />
          <button
            type="button"
            className="btn-secondary"
            onClick={handleLogout}
            disabled={loggingOut}
            title="Unlink WhatsApp from this app"
          >
            {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            Unlink
          </button>
        </div>
      </header>

      {snapshot.status !== 'connected' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
          <span>
            {snapshot.status === 'conflict'
              ? 'WhatsApp Web was opened in another client, so this session was disconnected.'
              : 'WhatsApp is temporarily disconnected. Queued messages will continue automatically once it is back.'}
          </span>
          <button type="button" className="btn-secondary" onClick={onReconnect}>
            <RefreshCw className="h-4 w-4" /> Reconnect now
          </button>
        </div>
      )}

      <nav className="flex gap-2 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`btn whitespace-nowrap ${
              tab === id ? 'bg-stone-900 text-stone-50 shadow' : 'bg-surface/70 text-stone-600 hover:bg-surface'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
            {id === 'live' && runningCount > 0 && (
              <span className="ml-1 h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            )}
            {id === 'contacts' && <span className="text-xs opacity-60">{contacts.length}</span>}
          </button>
        ))}
      </nav>

      {loadError && <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{loadError}</p>}

      <main className="flex-1">
        {tab === 'contacts' && (
          <ContactsManager
            sessionId={sessionId}
            contacts={contacts}
            groups={groups}
            loading={loadingContacts}
            syncState={syncState}
            connected={connected}
            onSyncNow={syncNow}
            onGroupsChanged={reloadGroupsAndContacts}
          />
        )}
        {tab === 'compose' && (
          <BroadcastComposer
            sessionId={sessionId}
            groups={groups}
            contacts={contacts}
            connected={connected}
            onCreated={handleCampaignCreated}
            onGoToContacts={() => setTab('contacts')}
          />
        )}
        {tab === 'live' && (
          <LiveTerminal
            sessionId={sessionId}
            campaigns={campaigns}
            activeId={activeCampaignId}
            onSelect={setActiveCampaignId}
            onCampaignChange={handleCampaignChange}
          />
        )}
      </main>
    </div>
  );
}
