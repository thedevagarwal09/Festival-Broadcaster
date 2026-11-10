import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emitToSession } from '../realtime';
import { UPLOAD_DIR } from '../upload';
import { errorMessage } from '../utils/errors';
import { compressMedia, keepOriginal, MediaError, type MediaKind } from './mediaCompressor';
import type { MediaInfo, MediaJob } from '../../src/lib/types';

/** Compressed files are named "<timestamp>-<uuid>.jpg|mp4"; nothing else is accepted as a media reference. */
const MEDIA_FILE_RE = /^\d{10,16}-[0-9a-f-]{36}\.(jpg|png|webp|mp4)$/;
const JOB_TTL_MS = 60 * 60_000;

const jobs = new Map<string, MediaJob>();
/** Video transcodes are CPU-heavy: run them one at a time. Images run immediately. */
let videoQueue: Promise<unknown> = Promise.resolve();

/** Forget these sessions' compression jobs (used by Erase my data). */
export function clearMediaJobsFor(sessionIds: ReadonlySet<string>): void {
  for (const [id, job] of jobs) if (sessionIds.has(job.sessionId)) jobs.delete(id);
}

/** Session that uploaded or created a media file, from its sidecar (null for older files). */
export async function readMediaOwner(file: string): Promise<string | null> {
  if (!isMediaFileName(file)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(sidecarPath(file), 'utf8')) as { owner?: unknown };
    return typeof raw.owner === 'string' ? raw.owner : null;
  } catch {
    return null;
  }
}

export function isMediaFileName(file: unknown): file is string {
  return typeof file === 'string' && MEDIA_FILE_RE.test(file);
}

export function mediaFilePath(file: string): string {
  return path.join(UPLOAD_DIR, file);
}

const sidecarPath = (file: string): string => `${mediaFilePath(file)}.json`;

/** Details of a compressed file, read from the sidecar written when it was produced. */
export async function readMediaInfo(file: unknown): Promise<MediaInfo | null> {
  if (!isMediaFileName(file)) return null;
  try {
    await fs.access(mediaFilePath(file));
    const { owner: _owner, ...info } = JSON.parse(await fs.readFile(sidecarPath(file), 'utf8')) as MediaInfo & {
      owner?: string;
    };
    return info;
  } catch {
    return null;
  }
}

export async function deleteMediaFile(file: string): Promise<void> {
  if (!isMediaFileName(file)) return;
  await Promise.all([fs.rm(mediaFilePath(file), { force: true }), fs.rm(sidecarPath(file), { force: true })]);
}

export function getMediaJob(sessionId: string, jobId: string): MediaJob | null {
  const job = jobs.get(jobId);
  return job && job.sessionId === sessionId ? job : null;
}

/**
 * Start compressing an uploaded file in the background. Progress is pushed to the session's
 * browsers as `media_job` events (and can be polled), so slow video transcodes never hit an
 * HTTP or proxy timeout.
 */
export function startMediaJob(params: {
  sessionId: string;
  uploadPath: string;
  kind: MediaKind;
  originalName: string;
  /** false = keep the file exactly as uploaded */
  compress: boolean;
}): MediaJob {
  const job: MediaJob = {
    id: randomUUID(),
    sessionId: params.sessionId,
    status: 'processing',
    progress: 0,
    stage: params.compress && params.kind === 'video' ? 'Waiting to start' : 'Starting',
    result: null,
    error: null,
  };
  jobs.set(job.id, job);

  let lastEmit = 0;
  const publish = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit < 400) return; // at most ~2 updates per second
    lastEmit = now;
    emitToSession(job.sessionId, 'media_job', { ...job });
  };

  const work = async (): Promise<void> => {
    try {
      const run = params.compress ? compressMedia : keepOriginal;
      const result = await run({
        inputPath: params.uploadPath,
        kind: params.kind,
        originalName: params.originalName,
        outputDir: UPLOAD_DIR,
        onProgress: (pct, stage) => {
          job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
          job.stage = stage;
          publish();
        },
      });
      // owner: lets Erase my data find this file. It is never sent to the browser.
      await fs.writeFile(sidecarPath(result.file), JSON.stringify({ ...result, owner: params.sessionId }));
      job.status = 'ready';
      job.progress = 100;
      job.stage = 'Ready';
      job.result = result;
      console.log(
        params.compress
          ? `[media] ${params.kind} "${params.originalName}": ${(result.originalSize / 1048576).toFixed(1)} MB → ${(result.size / 1048576).toFixed(2)} MB`
          : `[media] ${params.kind} "${params.originalName}": kept original (${(result.size / 1048576).toFixed(1)} MB)`,
      );
    } catch (err) {
      job.status = 'failed';
      job.stage = 'Failed';
      job.error = err instanceof MediaError ? err.message : `Could not process the file: ${errorMessage(err)}`;
      console.warn(`[media] failed for "${params.originalName}":`, errorMessage(err));
    } finally {
      await fs.rm(params.uploadPath, { force: true }); // the original is no longer needed
      publish(true);
      setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
    }
  };

  if (params.compress && params.kind === 'video') {
    videoQueue = videoQueue.then(work, work);
  } else {
    void work();
  }
  publish(true);
  return { ...job };
}
