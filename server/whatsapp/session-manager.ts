import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type BaileysEventMap,
  type Contact as WAContact,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import { toDataURL } from 'qrcode';
import { prisma } from '../db';
import { emitToSession, sessionWatcherCount } from '../realtime';
import { errorMessage } from '../utils/errors';
import { sleep } from '../utils/sleep';
import { mergePreviousSessions } from './account-merge';
import { jidToPhone, normalizePnJid, toSessionUser } from '../utils/jid';
import {
  isValidSessionId,
  type ContactSyncState,
  type SessionSnapshot,
  type SessionStatus,
  type SessionUser,
} from '../../src/lib/types';

/** WhatsApp login keys. Override with SESSIONS_DIR (the Docker image uses /data/sessions). */
export const SESSIONS_DIR = path.resolve(process.cwd(), process.env.SESSIONS_DIR || 'sessions');

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

const MAX_RECONNECT_DELAY_MS = 30_000;
const CONTACT_CHUNK_SIZE = 200;
/** Short pause after connecting so the socket finishes its own start-up queries first. */
const ADDRESS_BOOK_SYNC_DELAY_MS = 2_000;
/**
 * Contacts are stored in the database, so a reconnect does NOT re-sync them if the last sync is
 * recent. New or edited contacts still arrive instantly: WhatsApp pushes a `server_sync`
 * notification and Baileys pulls just that change. This periodic pull is only a backstop.
 */
const ADDRESS_BOOK_MAX_AGE_MS = 6 * 60 * 60_000;

interface ManagedSession {
  id: string;
  sock: WASocket | null;
  status: SessionStatus;
  qr: string | null;
  qrAttempt: number;
  user: SessionUser | null;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  starting: boolean;
  /** Set when we intentionally closed the socket (logout / shutdown) so no reconnect happens. */
  stopped: boolean;
}

type SessionListener = (sessionId: string) => void;
type MessageStatusListener = (sessionId: string, updates: Array<{ messageId: string; status: number }>) => void;

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Contacts may arrive keyed by phone JID or by LID with the phone JID in another field. */
function resolveContactJid(contact: Partial<WAContact>): string | null {
  const record = contact as unknown as Record<string, unknown>;
  for (const key of ['id', 'jid', 'phoneNumber']) {
    const jid = normalizePnJid(record[key]);
    if (jid) return jid;
  }
  return null;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly connectedListeners: SessionListener[] = [];
  private readonly loggedOutListeners: SessionListener[] = [];
  private readonly statusListeners: MessageStatusListener[] = [];
  private readonly contactSyncChains = new Map<string, Promise<void>>();
  private readonly addressBookSyncs = new Map<string, Promise<ContactSyncState>>();
  private versionPromise: Promise<WAVersion | undefined> | null = null;
  private shuttingDown = false;

  onConnected(listener: SessionListener): void {
    this.connectedListeners.push(listener);
  }

  onLoggedOut(listener: SessionListener): void {
    this.loggedOutListeners.push(listener);
  }

  /** Delivery/read status changes for messages this account sent. */
  onMessageStatus(listener: MessageStatusListener): void {
    this.statusListeners.push(listener);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const s = this.sessions.get(sessionId);
    return {
      sessionId,
      status: s?.status ?? 'idle',
      user: s?.user ?? null,
      qr: s?.status === 'qr' ? s.qr : null,
      qrAttempt: s?.qrAttempt ?? 0,
    };
  }

  /** The live socket, but only while the session is fully connected. */
  getConnectedSocket(sessionId: string): WASocket | null {
    const s = this.sessions.get(sessionId);
    return s && s.status === 'connected' && s.sock ? s.sock : null;
  }

  /** Called whenever a browser subscribes to a session. Opens a socket if none is active. */
  async ensureSession(sessionId: string): Promise<SessionSnapshot> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session id');
    const s = this.getOrCreate(sessionId);
    if (!s.sock && !s.starting) {
      this.clearReconnectTimer(s);
      await this.connect(s);
    }
    return this.snapshot(sessionId);
  }

  /** Force a brand-new socket — used by the "Generate new QR" and "Reconnect" buttons. */
  async refresh(sessionId: string): Promise<SessionSnapshot> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session id');
    const s = this.getOrCreate(sessionId);
    if (s.status === 'connected' || s.starting) return this.snapshot(sessionId);
    this.clearReconnectTimer(s);
    this.teardownSocket(s);
    s.qrAttempt = 0;
    await this.connect(s);
    return this.snapshot(sessionId);
  }

  async logout(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session id');
    const s = this.sessions.get(sessionId);
    if (!s) {
      await this.wipeAuth(sessionId);
      return;
    }
    s.stopped = true;
    this.clearReconnectTimer(s);
    const sock = s.sock;
    s.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.warn(`[session:${sessionId}] logout request failed:`, errorMessage(err));
      }
      try {
        sock.end(undefined);
      } catch {
        // socket already closed
      }
    }
    await this.handleLoggedOut(s, 'Logged out by user');
  }

  /** Reconnect every previously paired session on boot so queued campaigns resume. */
  async restoreSessions(): Promise<void> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
      try {
        const raw = await fs.readFile(path.join(SESSIONS_DIR, entry.name, 'creds.json'), 'utf8');
        const creds = JSON.parse(raw) as { me?: { id?: string } };
        if (!creds.me?.id) continue; // never finished pairing
      } catch {
        continue;
      }
      console.log(`[session:${entry.name}] restoring saved WhatsApp session`);
      await this.ensureSession(entry.name).catch((err: unknown) =>
        console.error(`[session:${entry.name}] restore failed:`, errorMessage(err)),
      );
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const s of this.sessions.values()) {
      s.stopped = true;
      this.clearReconnectTimer(s);
      this.teardownSocket(s);
    }
    await Promise.allSettled([...this.contactSyncChains.values()]);
  }

  // ---------------------------------------------------------------------------

  private getOrCreate(sessionId: string): ManagedSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        sock: null,
        status: 'idle',
        qr: null,
        qrAttempt: 0,
        user: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        starting: false,
        stopped: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private setStatus(s: ManagedSession, status: SessionStatus): void {
    s.status = status;
    emitToSession(s.id, 'session_status', this.snapshot(s.id));
  }

  private getVersion(): Promise<WAVersion | undefined> {
    if (!this.versionPromise) {
      this.versionPromise = fetchLatestBaileysVersion()
        .then(({ version }) => version)
        .catch(() => undefined);
    }
    return this.versionPromise;
  }

  private async connect(s: ManagedSession): Promise<void> {
    if (s.starting || this.shuttingDown) return;
    s.starting = true;
    s.stopped = false;
    try {
      await prisma.userSession.upsert({ where: { id: s.id }, create: { id: s.id }, update: {} });

      const authDir = path.join(SESSIONS_DIR, s.id);
      await fs.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      if (state.creds.me?.id && !s.user) {
        s.user = toSessionUser(state.creds.me.id, state.creds.me.name ?? null);
      }
      if (s.status !== 'reconnecting') this.setStatus(s, 'connecting');

      const version = await this.getVersion();
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        // Download no chat history at all — no chats, no messages, not even the profile-name list.
        // History sync is the slow part of linking (the phone uploads and Baileys decrypts it), and
        // with it disabled Baileys also skips its up-to-20 s wait for history on every connect.
        // The address book is fetched directly (scheduleAddressBookSync), and WhatsApp profile
        // names still arrive live through contacts.update.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
      });
      s.sock = sock;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => {
        this.onConnectionUpdate(s, sock, update).catch((err: unknown) =>
          console.error(`[session:${s.id}] connection.update handler failed:`, err),
        );
      });
      sock.ev.on('contacts.upsert', (contacts) => this.queueContactSync(s.id, contacts));
      // Delivery (3) / read (4) / played (5) receipts for messages we sent.
      sock.ev.on('messages.update', (updates) => {
        const receipts = updates
          .filter((u) => u.key.fromMe && u.key.id && typeof u.update.status === 'number')
          .map((u) => ({ messageId: u.key.id as string, status: u.update.status as number }));
        if (receipts.length > 0) for (const listener of this.statusListeners) listener(s.id, receipts);
      });
      sock.ev.on('contacts.update', (contacts) => this.queueContactSync(s.id, contacts));
    } catch (err) {
      console.error(`[session:${s.id}] failed to open socket:`, errorMessage(err));
      s.starting = false;
      this.scheduleReconnect(s);
      return;
    }
    s.starting = false;
  }

  private async onConnectionUpdate(
    s: ManagedSession,
    sock: WASocket,
    update: BaileysEventMap['connection.update'],
  ): Promise<void> {
    if (s.sock !== sock) return; // event from a socket we already replaced
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const dataUrl = await toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      if (s.sock !== sock) return;
      s.qr = dataUrl;
      s.qrAttempt += 1;
      this.setStatus(s, 'qr');
      emitToSession(s.id, 'qr_code', { sessionId: s.id, qr: dataUrl, attempt: s.qrAttempt });
    }

    if (connection === 'open') {
      s.qr = null;
      s.qrAttempt = 0;
      s.reconnectAttempts = 0;
      if (sock.user?.id) {
        s.user = toSessionUser(sock.user.id, sock.user.name ?? sock.user.notify ?? null);
      }
      await prisma.userSession.update({
        where: { id: s.id },
        data: {
          phoneNumber: s.user?.phoneNumber ?? null,
          name: s.user?.name ?? null,
          status: 'CONNECTED',
        },
      });
      this.setStatus(s, 'connected');
      if (s.user) emitToSession(s.id, 'session_connected', { ...s.user, sessionId: s.id });

      const phoneNumber = s.user?.phoneNumber;
      if (phoneNumber) {
        // Run inside the contact-sync chain so it never interleaves with incoming contact writes.
        await this.enqueueContactWork(s.id, async () => {
          const merged = await mergePreviousSessions(s.id, phoneNumber, (id) => this.isActive(id));
          if (merged.mergedSessions > 0) {
            console.log(
              `[session:${s.id}] merged ${merged.mergedSessions} earlier session(s) for ${phoneNumber}: ` +
                `${merged.movedGroups} group(s), ${merged.movedContacts} contact(s), ${merged.movedCampaigns} campaign(s)`,
            );
          }
        });
      }

      const count = await prisma.contact.count({ where: { sessionId: s.id } });
      emitToSession(s.id, 'contacts_synced', { sessionId: s.id, count, received: 0 });
      console.log(`[session:${s.id}] connected as ${s.user?.phoneNumber ?? 'unknown'} (${count} contacts saved)`);
      for (const listener of this.connectedListeners) listener(s.id);
      this.planAddressBookSync(s, sock).catch((err: unknown) =>
        console.warn(`[session:${s.id}] could not plan address book sync:`, errorMessage(err)),
      );
      return;
    }

    if (connection === 'close') {
      s.sock = null;
      if (s.stopped || this.shuttingDown) return;

      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const wasPairing = s.status === 'qr';
      console.log(`[session:${s.id}] connection closed (code ${statusCode ?? 'n/a'})`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        await this.handleLoggedOut(s, 'WhatsApp unlinked this device');
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        // Another client opened this account; reconnecting would just kick it off again.
        this.setStatus(s, 'conflict');
        return;
      }

      if (wasPairing && statusCode === DisconnectReason.timedOut) {
        // QR codes ran out. Generate a fresh batch only if someone is looking at the screen.
        s.qr = null;
        if (sessionWatcherCount(s.id) > 0) {
          s.qrAttempt = 0;
          await this.connect(s);
        } else {
          this.setStatus(s, 'idle');
        }
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        // Normal right after a successful QR scan.
        await this.connect(s);
        return;
      }

      this.scheduleReconnect(s);
    }
  }

  /**
   * Decide when to pull the address book after connecting. Contacts are already in the database,
   * so if the last sync is recent we skip it entirely and just keep listening for live changes.
   */
  private async planAddressBookSync(s: ManagedSession, sock: WASocket): Promise<void> {
    const row = await prisma.userSession.findUnique({
      where: { id: s.id },
      select: { contactsSyncedAt: true },
    });
    const age = row?.contactsSyncedAt ? Date.now() - row.contactsSyncedAt.getTime() : Number.POSITIVE_INFINITY;
    if (age < ADDRESS_BOOK_MAX_AGE_MS) {
      console.log(
        `[session:${s.id}] using saved contacts (last synced ${Math.round(age / 60_000)} min ago); live changes still apply`,
      );
      this.scheduleAddressBookSync(s, sock, ADDRESS_BOOK_MAX_AGE_MS - age);
    } else {
      this.scheduleAddressBookSync(s, sock, ADDRESS_BOOK_SYNC_DELAY_MS);
    }
  }

  private scheduleAddressBookSync(s: ManagedSession, sock: WASocket, delayMs: number): void {
    const timer = setTimeout(() => {
      // Stop the cycle once this socket is replaced or closed; the next 'open' plans a new one.
      if (s.sock !== sock || this.shuttingDown) return;
      this.syncAddressBook(s.id)
        .catch((err: unknown) => console.warn(`[session:${s.id}] address book sync failed:`, errorMessage(err)))
        .finally(() => this.scheduleAddressBookSync(s, sock, ADDRESS_BOOK_MAX_AGE_MS));
    }, delayMs);
    timer.unref();
  }

  /**
   * Pull the address book ("critical_unblock_low" app-state collection) now. The first time this
   * downloads the full list; afterwards WhatsApp only sends what changed since the stored version.
   * Concurrent calls share one run.
   */
  syncAddressBook(sessionId: string): Promise<ContactSyncState> {
    const running = this.addressBookSyncs.get(sessionId);
    if (running) return running;
    const sock = this.getConnectedSocket(sessionId);
    if (!sock) return Promise.reject(new Error('WhatsApp is not connected right now.'));

    const run = (async (): Promise<ContactSyncState> => {
      const startedAt = Date.now();
      emitToSession(sessionId, 'contacts_sync_state', { ...(await this.contactSyncState(sessionId)), syncing: true });
      await sock.resyncAppState(['critical_unblock_low'], true);
      // Baileys flushes the buffered contacts.upsert events just after the call resolves;
      // then wait for every queued database write to finish.
      await sleep(1_000);
      for (let chain = this.contactSyncChains.get(sessionId); chain; ) {
        await chain;
        const next = this.contactSyncChains.get(sessionId);
        if (next === chain) break;
        chain = next;
      }
      await prisma.userSession.update({ where: { id: sessionId }, data: { contactsSyncedAt: new Date() } });
      const state = await this.contactSyncState(sessionId, false);
      console.log(
        `[session:${sessionId}] address book synced in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${state.count} contacts`,
      );
      emitToSession(sessionId, 'contacts_synced', { sessionId, count: state.count, received: 0 });
      return state;
    })();

    this.addressBookSyncs.set(sessionId, run);
    const finish = (): void => {
      this.addressBookSyncs.delete(sessionId);
      this.contactSyncState(sessionId)
        .then((state) => emitToSession(sessionId, 'contacts_sync_state', state))
        .catch(() => undefined);
    };
    run.then(finish, finish);
    return run;
  }

  /** What the Contacts page shows: how many are saved, when they were last synced, and whether a sync is running. */
  async contactSyncState(sessionId: string, syncing = this.addressBookSyncs.has(sessionId)): Promise<ContactSyncState> {
    const [row, count] = await Promise.all([
      prisma.userSession.findUnique({ where: { id: sessionId }, select: { contactsSyncedAt: true } }),
      prisma.contact.count({ where: { sessionId } }),
    ]);
    return {
      sessionId,
      syncing,
      syncedAt: row?.contactsSyncedAt ? row.contactsSyncedAt.toISOString() : null,
      count,
    };
  }

  private isActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && (s.sock !== null || s.starting || s.reconnectTimer !== null);
  }

  private scheduleReconnect(s: ManagedSession): void {
    if (s.stopped || this.shuttingDown) return;
    this.clearReconnectTimer(s);
    s.reconnectAttempts += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(s.reconnectAttempts, 5));
    this.setStatus(s, 'reconnecting');
    console.log(`[session:${s.id}] reconnecting in ${Math.round(delay / 1000)}s`);
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = null;
      void this.connect(s);
    }, delay);
  }

  private clearReconnectTimer(s: ManagedSession): void {
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  }

  /** Close the current socket without triggering reconnect logic (its events become stale). */
  private teardownSocket(s: ManagedSession): void {
    const sock = s.sock;
    s.sock = null;
    if (!sock) return;
    try {
      sock.end(undefined);
    } catch {
      // already closed
    }
  }

  private async handleLoggedOut(s: ManagedSession, reason: string): Promise<void> {
    this.clearReconnectTimer(s);
    s.stopped = true;
    s.user = null;
    s.qr = null;
    await this.wipeAuth(s.id);
    await prisma.userSession
      .update({ where: { id: s.id }, data: { status: 'LOGGED_OUT' } })
      .catch(() => undefined);
    this.setStatus(s, 'logged_out');
    emitToSession(s.id, 'session_logged_out', { sessionId: s.id, reason });
    this.sessions.delete(s.id);
    for (const listener of this.loggedOutListeners) listener(s.id);
    console.log(`[session:${s.id}] logged out: ${reason}`);
  }

  private async wipeAuth(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) return;
    await fs.rm(path.join(SESSIONS_DIR, sessionId), { recursive: true, force: true });
  }

  // --- Contact sync ----------------------------------------------------------

  /** Serialise contact writes per session so large history syncs never interleave. */
  private queueContactSync(sessionId: string, contacts: Array<Partial<WAContact>>): void {
    if (contacts.length === 0) return;
    if (process.env.DEBUG_CONTACTS) {
      // Shape only — never log numbers or names.
      const shapes = new Map<string, number>();
      for (const c of contacts) {
        const rec = c as unknown as Record<string, unknown>;
        const kinds = Object.entries(rec)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => (typeof v === 'string' && v.includes('@') ? `${k}@${v.split('@')[1]}` : k))
          .sort()
          .join(',');
        shapes.set(kinds, (shapes.get(kinds) ?? 0) + 1);
      }
      console.log(`[debug:contacts] batch of ${contacts.length}:`, Object.fromEntries(shapes));
    }
    void this.enqueueContactWork(sessionId, () => this.syncContacts(sessionId, contacts));
  }

  /** Run `work` after every contact write already queued for this session. Never rejects. */
  private enqueueContactWork(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.contactSyncChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((err: unknown) => console.error(`[session:${sessionId}] contact sync failed:`, err));
    this.contactSyncChains.set(sessionId, next);
    return next;
  }

  private async syncContacts(sessionId: string, contacts: Array<Partial<WAContact>>): Promise<void> {
    const ownJid = this.sessions.get(sessionId)?.user?.jid;
    const merged = new Map<string, { name: string | null; pushName: string | null }>();

    let skipped = 0;
    for (const contact of contacts) {
      const jid = resolveContactJid(contact);
      if (!jid || jid === ownJid) {
        skipped += 1;
        continue;
      }
      const name = cleanString(contact.name);
      const pushName = cleanString(contact.notify) ?? cleanString(contact.verifiedName);
      const prev = merged.get(jid);
      merged.set(jid, {
        name: name ?? prev?.name ?? null,
        pushName: pushName ?? prev?.pushName ?? null,
      });
    }
    if (skipped > 0) {
      console.log(
        `[session:${sessionId}] skipped ${skipped} contact entr${skipped === 1 ? 'y' : 'ies'} (your own number, or no phone-number JID)`,
      );
    }
    if (merged.size === 0) return;

    const rows = [...merged.entries()];
    /** Saved (named) contacts that are new to us, or just got an address-book name. */
    const newlySaved: string[] = [];
    let created = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += CONTACT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CONTACT_CHUNK_SIZE);
      const stored = new Map(
        (
          await prisma.contact.findMany({
            where: { sessionId, jid: { in: chunk.map(([jid]) => jid) } },
            select: { id: true, jid: true, name: true, pushName: true },
          })
        ).map((c) => [c.jid, c]),
      );

      const toCreate: Array<{ sessionId: string; jid: string; phone: string; name: string | null; pushName: string | null }> = [];
      const toUpdate: Array<{ id: string; data: { name?: string; pushName?: string } }> = [];
      for (const [jid, info] of chunk) {
        const existing = stored.get(jid);
        if (!existing) {
          toCreate.push({ sessionId, jid, phone: jidToPhone(jid), name: info.name, pushName: info.pushName });
          if (info.name) newlySaved.push(jid);
          continue;
        }
        // Only touch rows whose names actually changed, and never blank out a known name.
        const data: { name?: string; pushName?: string } = {};
        if (info.name && info.name !== existing.name) data.name = info.name;
        if (info.pushName && info.pushName !== existing.pushName) data.pushName = info.pushName;
        if (data.name !== undefined || data.pushName !== undefined) toUpdate.push({ id: existing.id, data });
        if (info.name && existing.name === null) newlySaved.push(jid);
      }

      if (toCreate.length > 0) {
        await prisma.contact.createMany({ data: toCreate });
        created += toCreate.length;
      }
      if (toUpdate.length > 0) {
        await prisma.$transaction(toUpdate.map((u) => prisma.contact.update({ where: { id: u.id }, data: u.data })));
        updated += toUpdate.length;
      }
    }

    await this.addToAutoGroups(sessionId, newlySaved);

    if (created + updated === 0) return; // nothing changed — don't make every browser reload the list
    if (rows.length > 20) {
      console.log(`[session:${sessionId}] contacts: ${created} new, ${updated} updated, ${rows.length - created - updated} unchanged`);
    }
    const count = await prisma.contact.count({ where: { sessionId } });
    emitToSession(sessionId, 'contacts_synced', { sessionId, count, received: merged.size });
  }

  /**
   * Put newly saved contacts into every group flagged "auto-add new contacts". Only address-book
   * contacts qualify, so strangers who merely message you never end up in a broadcast group.
   */
  private async addToAutoGroups(sessionId: string, jids: string[]): Promise<void> {
    if (jids.length === 0) return;
    const groups = await prisma.contactGroup.findMany({
      where: { sessionId, autoAddNew: true },
      select: { id: true, name: true },
    });
    if (groups.length === 0) return;

    for (let i = 0; i < jids.length; i += CONTACT_CHUNK_SIZE) {
      const ids = await prisma.contact.findMany({
        where: { sessionId, jid: { in: jids.slice(i, i + CONTACT_CHUNK_SIZE) } },
        select: { id: true },
      });
      if (ids.length === 0) continue;
      await prisma.$transaction(
        groups.map((g) =>
          prisma.contactGroup.update({ where: { id: g.id }, data: { contacts: { connect: ids } } }),
        ),
      );
    }
    console.log(
      `[session:${sessionId}] auto-added ${jids.length} new contact(s) to ${groups.map((g) => `"${g.name}"`).join(', ')}`,
    );
  }
}
