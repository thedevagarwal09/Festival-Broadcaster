/**
 * Upload-once media cache.
 *
 * Baileys can reuse an uploaded attachment: when a socket has a `mediaCache`, the first send of a
 * file encrypts and uploads it, then stores the resulting media pointer (CDN url, mediaKey,
 * fileEncSha256, fileSha256, fileLength, thumbnail) under "<type>:<file path>". Every later send of
 * the same file reuses that pointer — no re-encryption, no re-upload. A campaign always sends its
 * attachment from one path, so it is uploaded once per campaign instead of once per recipient.
 *
 * Entries expire after a few hours so long-running campaigns (e.g. across quiet hours) refresh the
 * upload instead of relying on an old pointer, and a failed send drops the entry.
 */
import type { CacheStore } from '@whiskeysockets/baileys';

const TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 50;

class MediaUploadCache implements CacheStore {
  private readonly entries = new Map<string, { value: unknown; expires: number; hits: number }>();

  constructor(private readonly label: string) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    entry.hits += 1;
    if (entry.hits === 1 || entry.hits % 50 === 0) {
      console.log(`[media-cache:${this.label}] reusing uploaded attachment (${entry.hits} sends without re-uploading)`);
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(key, { value, expires: Date.now() + TTL_MS, hits: 0 });
    console.log(`[media-cache:${this.label}] attachment uploaded once and cached`);
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }

  /** Drop every cached upload of this file (any media type). */
  forgetFile(filePath: string): void {
    for (const key of this.entries.keys()) if (key.endsWith(`:${filePath}`)) this.entries.delete(key);
  }
}

const caches = new Map<string, MediaUploadCache>();

/** One cache per WhatsApp account, kept across reconnects. */
export function mediaCacheFor(sessionId: string): MediaUploadCache {
  let cache = caches.get(sessionId);
  if (!cache) {
    cache = new MediaUploadCache(sessionId.slice(0, 8));
    caches.set(sessionId, cache);
  }
  return cache;
}
