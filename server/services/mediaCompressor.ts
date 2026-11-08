/**
 * Media compression pipeline.
 *
 * Runs before a file can be attached to a broadcast, so the queue never has to push a huge
 * upload to WhatsApp for every recipient (which causes socket timeouts and "payload too large").
 *
 *  Images (sharp):   JPEG / PNG / WebP up to 25 MB → JPEG, max 1920×1080 (1080×1920 portrait), quality 80→75,
 *                    target < 800 KB, EXIF and other metadata stripped (orientation applied first).
 *  Videos (ffmpeg):  MP4 / MOV / MKV → H.264 + AAC in MP4, max 720p (short side) at ≤ 30 fps.
 *                    Short clips: single-pass CRF 25 with a bitrate cap (always < 14 MB).
 *                    Longer clips: two-pass at a bitrate computed to land at ~14 MB (limit 16 MB).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import type { MediaInfo } from '../../src/lib/types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---- Limits -----------------------------------------------------------------

export const IMAGE_MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_INPUT_BYTES = 500 * 1024 * 1024;

const IMAGE_MAX_WIDTH = 1920;
const IMAGE_MAX_HEIGHT = 1080;
const IMAGE_TARGET_BYTES = 800 * 1024;
const IMAGE_QUALITIES = [80, 78, 75] as const;

const VIDEO_LONG_SIDE = 1280;
const VIDEO_SHORT_SIDE = 720;
const VIDEO_MAX_FPS = 30;
const VIDEO_TARGET_BYTES = 14 * 1024 * 1024; // aim inside the 10–16 MB window
const VIDEO_MAX_BYTES = 16 * 1024 * 1024; // hard ceiling
const VIDEO_CRF = 25;
const VIDEO_MAX_KBPS = 2500; // plenty for 720p30; short clips never need more
const VIDEO_MIN_KBPS = 300; // below this 720p looks broken — ask for a shorter clip instead
const AUDIO_KBPS = 96;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/matroska']);

export type MediaKind = 'image' | 'video';

/** Decide from MIME type or extension (browsers often send an empty type for .mkv). */
export function detectMediaKind(mimeType: string, fileName: string): MediaKind | null {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_MIMES.has(mimeType) || IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_MIMES.has(mimeType) || VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

export type ProgressFn = (percent: number, stage: string) => void;

export interface CompressOptions {
  /** Absolute path of the uploaded original. */
  inputPath: string;
  kind: MediaKind;
  originalName: string;
  /** Folder the compressed file is written to. */
  outputDir: string;
  onProgress?: ProgressFn;
}

/** Compress an upload. Returns the compressed file's details; the original is left in place. */
export async function compressMedia(opts: CompressOptions): Promise<MediaInfo> {
  const originalSize = (await fs.stat(opts.inputPath)).size;
  const result = opts.kind === 'image' ? await compressImage(opts) : await compressVideo(opts);
  return { ...result, originalSize, originalName: opts.originalName };
}

// ---- Images -------------------------------------------------------------------

async function compressImage(opts: CompressOptions): Promise<Omit<MediaInfo, 'originalSize' | 'originalName'>> {
  const { inputPath, outputDir, onProgress } = opts;
  if ((await fs.stat(inputPath)).size > IMAGE_MAX_INPUT_BYTES) {
    throw new MediaError('Images can be up to 25 MB.');
  }
  onProgress?.(5, 'Reading image');

  let meta: Metadata;
  try {
    meta = await sharp(inputPath, { failOn: 'error' }).metadata();
  } catch {
    throw new MediaError('That file is not a readable image.');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw new MediaError('Use a JPG, PNG or WebP image.');
  }

  // Encode with the given bounding box and quality. rotate() applies the EXIF orientation;
  // sharp drops all metadata (EXIF, GPS, ICC…) unless asked to keep it.
  const encode = (maxW: number, maxH: number, quality: number): Promise<{ data: Buffer; info: OutputInfo }> =>
    sharp(inputPath, { failOn: 'error' })
      .rotate()
      .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // PNG/WebP transparency → white (JPEG has no alpha)
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });

  // Bounding box follows the photo's orientation: landscape fits 1920×1080, portrait 1080×1920.
  // EXIF orientations 5–8 mean the stored pixels are rotated 90°.
  const rotated = (meta.orientation ?? 1) >= 5;
  const shownW = (rotated ? meta.height : meta.width) ?? IMAGE_MAX_WIDTH;
  const shownH = (rotated ? meta.width : meta.height) ?? IMAGE_MAX_HEIGHT;
  const portrait = shownH > shownW;

  let best: { data: Buffer; info: OutputInfo } | null = null;
  let maxW = portrait ? IMAGE_MAX_HEIGHT : IMAGE_MAX_WIDTH;
  let maxH = portrait ? IMAGE_MAX_WIDTH : IMAGE_MAX_HEIGHT;
  // First try quality 80 → 75 at full size; if still too big, shrink 15% per step at quality 75.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const quality = IMAGE_QUALITIES[Math.min(attempt, IMAGE_QUALITIES.length - 1)]!;
    if (attempt >= IMAGE_QUALITIES.length) {
      maxW = Math.round(maxW * 0.85);
      maxH = Math.round(maxH * 0.85);
    }
    best = await encode(maxW, maxH, quality);
    onProgress?.(Math.min(90, 20 + attempt * 10), 'Compressing image');
    if (best.data.length <= IMAGE_TARGET_BYTES || maxW < 480) break;
  }
  if (!best) throw new MediaError('Could not compress the image.');

  const file = `${Date.now()}-${randomUUID()}.jpg`;
  await fs.writeFile(path.join(outputDir, file), best.data);
  onProgress?.(100, 'Done');
  return {
    file,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    size: best.data.length,
    width: best.info.width,
    height: best.info.height,
    durationSec: null,
  };
}

// ---- Videos -------------------------------------------------------------------

interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number | null;
  rotation: number;
  hasAudio: boolean;
}

/** Read duration, size, frame rate, rotation and audio presence from `ffmpeg -i` output. */
export function probeVideo(inputPath: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, ['-hide_banner', '-i', inputPath]);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', () => {
      // ffmpeg exits with an error ("At least one output file must be specified"); that's expected.
      const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const videoLine = stderr.split('\n').find((l) => /Stream #.*Video:/.test(l));
      if (!duration || !videoLine) {
        reject(new MediaError('That file is not a readable video.'));
        return;
      }
      const dims = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(videoLine);
      const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(videoLine);
      const rot =
        /displaymatrix: rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr) ?? /rotate\s*:\s*(-?\d+)/.exec(stderr);
      resolve({
        durationSec: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
        width: dims ? Number(dims[1]) : 1280,
        height: dims ? Number(dims[2]) : 720,
        fps: fps ? Number(fps[1]) : null,
        rotation: rot ? Math.round(Number(rot[1])) : 0,
        hasAudio: /Stream #.*Audio:/.test(stderr),
      });
    });
  });
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

function timemarkSeconds(mark: string | undefined): number {
  const m = mark ? /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(mark) : null;
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function runFfmpeg(
  inputPath: string,
  outputPath: string,
  options: string[],
  durationSec: number,
  onPercent: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(options)
      .output(outputPath)
      .on('progress', (p: { timemark?: string }) => {
        if (durationSec > 0) onPercent(Math.min(100, (timemarkSeconds(p.timemark) / durationSec) * 100));
      })
      .on('end', () => resolve())
      .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
        const last = (stderr ?? '').trim().split('\n').slice(-3).join(' ');
        reject(new MediaError(`Video conversion failed: ${last || err.message}`));
      })
      .run();
  });
}

async function compressVideo(opts: CompressOptions): Promise<Omit<MediaInfo, 'originalSize' | 'originalName'>> {
  const { inputPath, outputDir, onProgress } = opts;
  if ((await fs.stat(inputPath)).size > VIDEO_MAX_INPUT_BYTES) {
    throw new MediaError('Videos can be up to 500 MB before compression.');
  }
  onProgress?.(1, 'Reading video');
  const probe = await probeVideo(inputPath);
  if (probe.durationSec <= 0) throw new MediaError('Could not read the video length.');

  // Output size: fit inside 1280×720 (or 720×1280 for portrait), never upscale, even numbers.
  const sideways = Math.abs(probe.rotation) % 180 === 90;
  const dispW = sideways ? probe.height : probe.width;
  const dispH = sideways ? probe.width : probe.height;
  const scale = Math.min(1, VIDEO_LONG_SIDE / Math.max(dispW, dispH), VIDEO_SHORT_SIDE / Math.min(dispW, dispH));
  const outW = even(dispW * scale);
  const outH = even(dispH * scale);
  const filters = [`scale=${outW}:${outH}`, ...(probe.fps && probe.fps > VIDEO_MAX_FPS + 0.5 ? [`fps=${VIDEO_MAX_FPS}`] : [])];

  const common = [
    '-map 0:v:0',
    ...(probe.hasAudio ? ['-map 0:a:0?'] : []),
    `-vf ${filters.join(',')}`,
    '-c:v libx264',
    '-preset veryfast',
    '-profile:v main',
    '-pix_fmt yuv420p',
    '-map_metadata -1',
  ];
  const audio = probe.hasAudio ? ['-c:a aac', `-b:a ${AUDIO_KBPS}k`, '-ac 2', '-ar 44100'] : ['-an'];

  const file = `${Date.now()}-${randomUUID()}.mp4`;
  const outputPath = path.join(outputDir, file);
  const passLog = path.join(os.tmpdir(), `fb-pass-${randomUUID()}`);

  // Video bitrate that would make the whole file land on the target size.
  const audioBits = probe.hasAudio ? AUDIO_KBPS * 1000 * probe.durationSec : 0;
  const budgetKbps = Math.floor(((VIDEO_TARGET_BYTES * 8 - audioBits) / probe.durationSec / 1000) * 0.97);

  const encodeTwoPass = async (kbps: number): Promise<void> => {
    const rate = [`-b:v ${kbps}k`, `-maxrate ${Math.round(kbps * 1.5)}k`, `-bufsize ${kbps * 2}k`];
    onProgress?.(2, 'Analysing video (pass 1 of 2)');
    await runFfmpeg(
      inputPath,
      os.devNull,
      [...common, ...rate, '-pass 1', `-passlogfile ${passLog}`, '-an', '-f mp4'],
      probe.durationSec,
      (pct) => onProgress?.(2 + pct * 0.43, 'Analysing video (pass 1 of 2)'),
    );
    await runFfmpeg(
      inputPath,
      outputPath,
      [...common, ...rate, '-pass 2', `-passlogfile ${passLog}`, ...audio, '-movflags +faststart'],
      probe.durationSec,
      (pct) => onProgress?.(45 + pct * 0.54, 'Compressing video (pass 2 of 2)'),
    );
  };

  try {
    if (budgetKbps >= VIDEO_MAX_KBPS) {
      // Short clip: quality-based single pass; the cap guarantees it stays under the target size.
      await runFfmpeg(
        inputPath,
        outputPath,
        [
          ...common,
          `-crf ${VIDEO_CRF}`,
          `-maxrate ${VIDEO_MAX_KBPS}k`,
          `-bufsize ${VIDEO_MAX_KBPS * 2}k`,
          ...audio,
          '-movflags +faststart',
        ],
        probe.durationSec,
        (pct) => onProgress?.(2 + pct * 0.97, 'Compressing video'),
      );
    } else if (budgetKbps >= VIDEO_MIN_KBPS) {
      await encodeTwoPass(budgetKbps);
    } else {
      const maxMinutes = Math.floor((VIDEO_TARGET_BYTES * 8) / ((VIDEO_MIN_KBPS + AUDIO_KBPS) * 1000) / 60);
      throw new MediaError(
        `This video is ${Math.round(probe.durationSec / 60)} min long. To stay under WhatsApp's size limit with watchable quality, keep it under about ${maxMinutes} minutes.`,
      );
    }

    let size = (await fs.stat(outputPath)).size;
    if (size > VIDEO_MAX_BYTES) {
      // Rare overshoot (very noisy footage): one more two-pass run at a proportionally lower bitrate.
      const actualKbps = (size * 8) / probe.durationSec / 1000;
      await encodeTwoPass(Math.max(VIDEO_MIN_KBPS, Math.floor(actualKbps * (VIDEO_TARGET_BYTES / size) * 0.9)));
      size = (await fs.stat(outputPath)).size;
      if (size > VIDEO_MAX_BYTES) throw new MediaError('Could not get this video under 16 MB. Try a shorter clip.');
    }

    onProgress?.(100, 'Done');
    return {
      file,
      mediaType: 'video',
      mimeType: 'video/mp4',
      size,
      width: outW,
      height: outH,
      durationSec: Math.round(probe.durationSec * 10) / 10,
    };
  } catch (err) {
    await fs.rm(outputPath, { force: true });
    throw err;
  } finally {
    // Two-pass log files: <prefix>-0.log and <prefix>-0.log.mbtree
    await Promise.all(
      ['-0.log', '-0.log.mbtree', '-0.log.temp', '-0.log.mbtree.temp'].map((s) => fs.rm(passLog + s, { force: true })),
    );
  }
}
