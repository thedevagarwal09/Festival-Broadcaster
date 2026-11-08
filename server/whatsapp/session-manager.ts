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
  type SessionSnapshot,
  type SessionStatus,
  type SessionUser,
} from '../../src/lib/types';

export const SESSIONS_DIR = path.resolve(process.cwd(), 'sessions');

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

const MAX_RECONNECT_DELAY_MS = 30_000;
const CONTACT_CHUNK_SIZE = 200;
/** Give Baileys' own initial sync a head start before we request the address book. */
const ADDRESS_BOOK_SYNC_DELAY_MS = 8_000;
/**
 * New contacts normally arrive instantly (WhatsApp pushes a `server_sync` notification and Baileys
 * re-pulls the collection). This periodic delta pull is only a backstop in case a push is missed.
 */
const ADDRESS_BOOK_RESYNC_INTERVAL_MS = 15 * 60_000;

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
  private readonly contactSyncChains = new Map<string, Promise<void>>();
  private versionPromise: Promise<WAVersion | undefined> | null = null;
  private shuttingDown = false;

  onConnected(listener: SessionListener): void {
    this.connectedListeners.push(listener);
  }

  onLoggedOut(listener: SessionListener): void {
    this.loggedOutListeners.push(listener);
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
        // Don't ask the phone for years of chat history…
        syncFullHistory: false,
        // …but DO process the initial/recent sync. In Baileys 6.7.x, leaving this unset makes it
        // default to `syncFullHistory` (false), which silently skips history AND the app-state sync
        // that carries the address book — so no contacts would ever arrive.
        shouldSyncHistoryMessage: () => true,
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
      sock.ev.on('contacts.update', (contacts) => this.queueContactSync(s.id, contacts));
      sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
        const fromChats: Array<Partial<WAContact>> = chats.map((chat) => ({
          id: chat.id,
          name: chat.name ?? undefined,
        }));
        this.queueContactSync(s.id, [...contacts, ...fromChats]);
      });
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
      this.scheduleAddressBookSync(s, sock);
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
   * Explicitly pull the address-book collection ("critical_unblock_low") once the initial sync has
   * settled. Each saved contact arrives as a `contacts.upsert`. If the collection is already up to date
   * this only fetches the small delta, so it is cheap to run on every connect — and it also repairs
   * sessions that were linked before history sync was enabled.
   */
  private scheduleAddressBookSync(s: ManagedSession, sock: WASocket, delayMs = ADDRESS_BOOK_SYNC_DELAY_MS): void {
    setTimeout(() => {
      // Stop the cycle once this socket is replaced or closed; the next 'open' starts a new one.
      if (s.sock !== sock || this.shuttingDown) return;
      if (s.status !== 'connected') {
        this.scheduleAddressBookSync(s, sock, ADDRESS_BOOK_RESYNC_INTERVAL_MS);
        return;
      }
      sock
        .resyncAppState(['critical_unblock_low'], true)
        .then(async () => {
          // Baileys flushes the buffered contacts.upsert events just after this resolves.
          await sleep(1_500);
          await this.contactSyncChains.get(s.id);
          const count = await prisma.contact.count({ where: { sessionId: s.id } });
          console.log(`[session:${s.id}] address book sync done — ${count} contacts saved`);
          emitToSession(s.id, 'contacts_synced', { sessionId: s.id, count, received: 0 });
        })
        .catch((err: unknown) =>
          console.warn(`[session:${s.id}] address book sync failed:`, errorMessage(err)),
        )
        .finally(() => this.scheduleAddressBookSync(s, sock, ADDRESS_BOOK_RESYNC_INTERVAL_MS));
    }, delayMs);
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
    for (let i = 0; i < rows.length; i += CONTACT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CONTACT_CHUNK_SIZE);
      const before = await prisma.contact.findMany({
        where: { sessionId, jid: { in: chunk.map(([jid]) => jid) } },
        select: { jid: true, name: true },
      });
      const hadName = new Map(before.map((c) => [c.jid, c.name !== null]));
      for (const [jid, info] of chunk) {
        if (info.name && hadName.get(jid) !== true) newlySaved.push(jid);
      }
      await prisma.$transaction(
        chunk.map(([jid, info]) =>
          prisma.contact.upsert({
            where: { sessionId_jid: { sessionId, jid } },
            create: {
              sessionId,
              jid,
              phone: jidToPhone(jid),
              name: info.name,
              pushName: info.pushName,
            },
            // Never overwrite a known name with an empty one.
            update: {
              ...(info.name ? { name: info.name } : {}),
              ...(info.pushName ? { pushName: info.pushName } : {}),
            },
          }),
        ),
      );
    }

    await this.addToAutoGroups(sessionId, newlySaved);

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
