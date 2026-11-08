import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { detectMediaKind, VIDEO_MAX_INPUT_BYTES } from './services/mediaCompressor';
import { HttpError } from './utils/errors';

/** Override with UPLOAD_DIR (the Docker image uses /data/uploads). */
export const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
/** Raw uploads waiting to be compressed; deleted once compression finishes. */
export const INCOMING_DIR = path.join(UPLOAD_DIR, 'incoming');
fs.mkdirSync(INCOMING_DIR, { recursive: true });

/** Accepts originals for the compression pipeline: JPEG/PNG/WebP images and MP4/MOV/MKV videos. */
export const upload = multer({
  storage: multer.diskStorage({
    destination: INCOMING_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: VIDEO_MAX_INPUT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (detectMediaKind(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Unsupported file type. Use a JPG, PNG or WebP image, or an MP4, MOV or MKV video.'));
    }
  },
});

export async function removeUpload(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => undefined);
}

/** Leftover originals from a crash mid-compression. */
export async function cleanIncoming(): Promise<void> {
  const entries = await fs.promises.readdir(INCOMING_DIR).catch(() => [] as string[]);
  await Promise.all(entries.map((f) => fs.promises.rm(path.join(INCOMING_DIR, f), { force: true })));
}
