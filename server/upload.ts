import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { HttpError } from './utils/errors';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Formats WhatsApp renders natively as image/video messages. */
export const ALLOWED_MEDIA = new Map<string, { ext: string; maxBytes: number }>([
  ['image/jpeg', { ext: '.jpg', maxBytes: 16 * 1024 * 1024 }],
  ['image/png', { ext: '.png', maxBytes: 16 * 1024 * 1024 }],
  ['image/webp', { ext: '.webp', maxBytes: 16 * 1024 * 1024 }],
  ['video/mp4', { ext: '.mp4', maxBytes: 64 * 1024 * 1024 }],
  ['video/3gpp', { ext: '.3gp', maxBytes: 64 * 1024 * 1024 }],
]);

export const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = ALLOWED_MEDIA.get(file.mimetype)?.ext ?? '';
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MEDIA.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Unsupported file type. Use JPG, PNG, WEBP images or MP4/3GP videos.'));
    }
  },
});

export async function removeUpload(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => undefined);
}
