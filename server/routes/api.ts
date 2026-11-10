import path from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { Dispatcher } from '../queue/dispatcher';
import { queueItemToLog, toCampaignDTO } from '../serializers';
import { removeUpload, upload, UPLOAD_DIR } from '../upload';
import {
  detectMediaKind,
  IMAGE_MAX_INPUT_BYTES,
  ORIGINAL_IMAGE_MAX_BYTES,
  ORIGINAL_VIDEO_MAX_BYTES,
} from '../services/mediaCompressor';
import {
  deleteMediaFile,
  getMediaJob,
  isMediaFileName,
  mediaFilePath,
  readMediaInfo,
  startMediaJob,
} from '../services/mediaJobs';
import {
  describeQuietHours,
  getQuietHoursSettings,
  isQuietNow,
  quietHoursEnd,
  saveQuietHours,
  serverTimeZone,
} from '../services/quietHours';
import { HttpError, errorMessage } from '../utils/errors';
import type { SessionManager } from '../whatsapp/session-manager';
import { estimateDurationMs, isPacingMode } from '../../src/lib/pacing';
import { getOccasion, isOccasionId } from '../../src/lib/occasions';
import { createECard } from '../services/ecard';
import { eraseMyData, MAX_ERASE_SESSIONS } from '../services/eraseMyData';
import { validateTemplate } from '../../src/lib/spintax';
import {
  isValidSessionId,
  type CampaignDetailResponse,
  type ContactDTO,
  type DraftDTO,
  type GroupDTO,
} from '../../src/lib/types';

const MAX_TEMPLATE_LENGTH = 4096;
const MAX_GROUP_NAME_LENGTH = 80;
const LOG_HISTORY_LIMIT = 500;

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Forward async errors to the Express error handler. */
const ah =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

function readGroupInput(body: unknown): { name: string; contactIds: string[]; autoAddNew: boolean } {
  const record = (body ?? {}) as Record<string, unknown>;
  const autoAddNew = record.autoAddNew === true;
  const name = readString(record.name);
  if (!name) throw new HttpError(400, 'Group name is required.');
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw new HttpError(400, `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer.`);
  }
  return { name, contactIds: readIdList(record.contactIds), autoAddNew };
}

/** Only allow contacts that belong to this session to be attached to its groups. */
async function ownedContactIds(sessionId: string, ids: string[]): Promise<Array<{ id: string }>> {
  if (ids.length === 0) return [];
  const rows = await prisma.contact.findMany({
    where: { sessionId, id: { in: ids } },
    select: { id: true },
  });
  return rows;
}

function toGroupDTO(group: {
  id: string;
  name: string;
  autoAddNew: boolean;
  createdAt: Date;
  contacts: Array<{ id: string }>;
}): GroupDTO {
  return {
    id: group.id,
    name: group.name,
    contactIds: group.contacts.map((c) => c.id),
    autoAddNew: group.autoAddNew,
    createdAt: group.createdAt.toISOString(),
  };
}

export function createApiRouter(deps: {
  sessions: SessionManager;
  dispatcher: Dispatcher;
  /** Called after quiet hours are edited, so the change takes effect immediately. */
  onQuietHoursChanged?: () => void;
}): express.Router {
  const { sessions, dispatcher, onQuietHoursChanged } = deps;
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.param('sessionId', (_req, res, next, value: unknown) => {
    if (!isValidSessionId(value)) {
      res.status(400).json({ error: 'Invalid session id.' });
      return;
    }
    next();
  });

  // --- Session ---------------------------------------------------------------

  router.get(
    '/sessions/:sessionId/status',
    ah(async (req, res) => {
      res.json(sessions.snapshot(req.params.sessionId));
    }),
  );

  router.post(
    '/sessions/:sessionId/logout',
    ah(async (req, res) => {
      await sessions.logout(req.params.sessionId);
      res.json({ ok: true });
    }),
  );

  // Unlink and delete everything belonging to the person asking: the session ids this browser has
  // used (each id is an unguessable UUID, the same key that opens the dashboard) plus every
  // session of the WhatsApp numbers linked to them. Other people's data is never touched.
  // The body must say ERASE so a stray or replayed request can't trigger it.
  router.post(
    '/erase-my-data',
    ah(async (req, res) => {
      const body = (req.body ?? {}) as { confirm?: unknown; sessionIds?: unknown };
      if (body.confirm !== 'ERASE') throw new HttpError(400, 'Type ERASE to confirm.');
      const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds.filter(isValidSessionId))] : [];
      if (ids.length === 0) throw new HttpError(400, 'No session to erase.');
      if (ids.length > MAX_ERASE_SESSIONS) throw new HttpError(400, 'Too many sessions in one request.');
      res.json(await eraseMyData(ids, sessions, dispatcher));
    }),
  );

  // --- Contacts --------------------------------------------------------------

  router.get(
    '/sessions/:sessionId/contacts',
    ah(async (req, res) => {
      const contacts = await prisma.contact.findMany({
        where: { sessionId: req.params.sessionId },
        include: { groups: { select: { id: true } } },
        // Saved (named) contacts first; number-only entries at the bottom.
        orderBy: [
          { name: { sort: 'asc', nulls: 'last' } },
          { pushName: { sort: 'asc', nulls: 'last' } },
          { phone: 'asc' },
        ],
      });
      const payload: ContactDTO[] = contacts.map((c) => ({
        id: c.id,
        jid: c.jid,
        name: c.name,
        pushName: c.pushName,
        phone: c.phone,
        groupIds: c.groups.map((g) => g.id),
      }));
      res.json(payload);
    }),
  );

  /** Saved-contact count, last address-book sync time, and whether a sync is running. */
  router.get(
    '/sessions/:sessionId/contacts/sync',
    ah(async (req, res) => {
      res.json(await sessions.contactSyncState(req.params.sessionId));
    }),
  );

  /** "Sync now": pull address-book changes from WhatsApp immediately. */
  router.post(
    '/sessions/:sessionId/contacts/sync',
    ah(async (req, res) => {
      if (!sessions.getConnectedSocket(req.params.sessionId)) {
        throw new HttpError(409, 'WhatsApp is not connected right now. Try again once it shows Connected.');
      }
      res.json(await sessions.syncAddressBook(req.params.sessionId));
    }),
  );

  // --- Groups ----------------------------------------------------------------

  /** Add contacts to a group, or remove them from it, without touching other members. */
  router.post(
    '/sessions/:sessionId/groups/:groupId/members',
    ah(async (req, res) => {
      const { sessionId, groupId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = body.action === 'add' || body.action === 'remove' ? body.action : null;
      if (!action) throw new HttpError(400, 'action must be "add" or "remove".');
      const ids = await ownedContactIds(sessionId, readIdList(body.contactIds));
      if (ids.length === 0) throw new HttpError(400, 'Select at least one contact.');
      const group = await prisma.contactGroup.findFirst({ where: { id: groupId, sessionId } });
      if (!group) throw new HttpError(404, 'Group not found.');
      const updated = await prisma.contactGroup.update({
        where: { id: groupId },
        data: { contacts: action === 'add' ? { connect: ids } : { disconnect: ids } },
        include: { contacts: { select: { id: true } } },
      });
      res.json(toGroupDTO(updated));
    }),
  );

  /** Move contacts from one group to another in a single step. */
  router.post(
    '/sessions/:sessionId/groups/move',
    ah(async (req, res) => {
      const { sessionId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fromGroupId = readString(body.fromGroupId);
      const toGroupId = readString(body.toGroupId);
      if (!fromGroupId || !toGroupId) throw new HttpError(400, 'Pick the group to move from and the group to move to.');
      if (fromGroupId === toGroupId) throw new HttpError(400, 'Choose a different group to move to.');

      const [from, to] = await Promise.all([
        prisma.contactGroup.findFirst({
          where: { id: fromGroupId, sessionId },
          include: { contacts: { select: { id: true } } },
        }),
        prisma.contactGroup.findFirst({ where: { id: toGroupId, sessionId } }),
      ]);
      if (!from || !to) throw new HttpError(404, 'Group not found.');

      // Only contacts that are actually in the source group are moved.
      const inSource = new Set(from.contacts.map((c) => c.id));
      const ids = readIdList(body.contactIds).filter((id) => inSource.has(id)).map((id) => ({ id }));
      if (ids.length === 0) throw new HttpError(400, `None of the selected contacts are in “${from.name}”.`);

      const [fromAfter, toAfter] = await prisma.$transaction([
        prisma.contactGroup.update({
          where: { id: from.id },
          data: { contacts: { disconnect: ids } },
          include: { contacts: { select: { id: true } } },
        }),
        prisma.contactGroup.update({
          where: { id: to.id },
          data: { contacts: { connect: ids } },
          include: { contacts: { select: { id: true } } },
        }),
      ]);
      res.json({ moved: ids.length, from: toGroupDTO(fromAfter), to: toGroupDTO(toAfter) });
    }),
  );

  router.get(
    '/sessions/:sessionId/groups',
    ah(async (req, res) => {
      const groups = await prisma.contactGroup.findMany({
        where: { sessionId: req.params.sessionId },
        include: { contacts: { select: { id: true } } },
        orderBy: { createdAt: 'asc' },
      });
      res.json(groups.map(toGroupDTO));
    }),
  );

  router.post(
    '/sessions/:sessionId/groups',
    ah(async (req, res) => {
      const { sessionId } = req.params;
      const input = readGroupInput(req.body);
      const group = await prisma.contactGroup.create({
        data: {
          sessionId,
          name: input.name,
          autoAddNew: input.autoAddNew,
          contacts: { connect: await ownedContactIds(sessionId, input.contactIds) },
        },
        include: { contacts: { select: { id: true } } },
      });
      res.status(201).json(toGroupDTO(group));
    }),
  );

  router.put(
    '/sessions/:sessionId/groups/:groupId',
    ah(async (req, res) => {
      const { sessionId, groupId } = req.params;
      const input = readGroupInput(req.body);
      const existing = await prisma.contactGroup.findFirst({ where: { id: groupId, sessionId } });
      if (!existing) throw new HttpError(404, 'Group not found.');
      const group = await prisma.contactGroup.update({
        where: { id: groupId },
        data: {
          name: input.name,
          autoAddNew: input.autoAddNew,
          contacts: { set: await ownedContactIds(sessionId, input.contactIds) },
        },
        include: { contacts: { select: { id: true } } },
      });
      res.json(toGroupDTO(group));
    }),
  );

  router.delete(
    '/sessions/:sessionId/groups/:groupId',
    ah(async (req, res) => {
      const { sessionId, groupId } = req.params;
      const deleted = await prisma.contactGroup.deleteMany({ where: { id: groupId, sessionId } });
      if (deleted.count === 0) throw new HttpError(404, 'Group not found.');
      res.json({ ok: true });
    }),
  );

  // --- Campaigns -------------------------------------------------------------

  router.get(
    '/sessions/:sessionId/campaigns',
    ah(async (req, res) => {
      const campaigns = await prisma.broadcastCampaign.findMany({
        where: { sessionId: req.params.sessionId },
        include: { group: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(campaigns.map(toCampaignDTO));
    }),
  );

  /**
   * Create a campaign. Body (JSON): { groupId, messageTemplate, name?, mediaFile?, scheduledAt? }.
   * mediaFile must be a file produced by the compression pipeline (POST /media).
   * scheduledAt in the future → SCHEDULED; otherwise it starts now (or waits if it's quiet hours).
   */
  router.post(
    '/sessions/:sessionId/campaigns',
    ah(async (req, res) => {
      const { sessionId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const groupId = readString(body.groupId);
      const messageTemplate = typeof body.messageTemplate === 'string' ? body.messageTemplate.trim() : '';
      const requestedName = readString(body.name);
      const pacing = isPacingMode(body.pacing) ? body.pacing : 'careful';
      const occasion = isOccasionId(body.occasion) ? body.occasion : null;

      const media = body.mediaFile ? await readMediaInfo(body.mediaFile) : null;
      if (body.mediaFile && !media) {
        throw new HttpError(400, 'The attachment is no longer available. Remove it and attach it again.');
      }
      if (!messageTemplate && !media) throw new HttpError(400, 'Write a message or attach an image/video.');
      if (messageTemplate.length > MAX_TEMPLATE_LENGTH) {
        throw new HttpError(400, `Message must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`);
      }
      const templateError = validateTemplate(messageTemplate);
      if (templateError) throw new HttpError(400, `Spintax error: ${templateError}`);

      let scheduledAt: Date | null = null;
      if (body.scheduledAt) {
        scheduledAt = new Date(String(body.scheduledAt));
        if (Number.isNaN(scheduledAt.getTime())) throw new HttpError(400, 'The scheduled time is not a valid date.');
        if (scheduledAt.getTime() > Date.now() + 366 * 24 * 3600_000) {
          throw new HttpError(400, 'Schedule within the next year.');
        }
        if (scheduledAt.getTime() <= Date.now() + 30_000) scheduledAt = null; // in the past or now → send now
      }

      await prisma.userSession.upsert({ where: { id: sessionId }, create: { id: sessionId }, update: {} });
      const group = await prisma.contactGroup.findFirst({
        where: { id: groupId, sessionId },
        include: { contacts: { orderBy: [{ name: 'asc' }, { phone: 'asc' }] } },
      });
      if (!group) throw new HttpError(404, 'Pick a contact group to broadcast to.');

      const recipients = [...new Map(group.contacts.map((c) => [c.jid, c])).values()];
      if (recipients.length === 0) throw new HttpError(400, 'That group has no contacts.');

      const quiet = await isQuietNow();
      const status = scheduledAt ? 'SCHEDULED' : quiet ? 'QUIET_HOURS_PAUSED' : 'PROCESSING';
      const startMs = (scheduledAt ?? new Date()).getTime();
      const name =
        requestedName.slice(0, 120) ||
        `${group.name} · ${new Date(startMs).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;

      const campaign = await prisma.$transaction(async (tx) => {
        const created = await tx.broadcastCampaign.create({
          data: {
            sessionId,
            groupId: group.id,
            name,
            messageTemplate,
            mediaPath: media ? path.relative(process.cwd(), mediaFilePath(media.file)) : null,
            mediaType: media?.mediaType ?? null,
            mediaSize: media?.size ?? null,
            mediaDuration: media?.durationSec ?? null,
            status,
            scheduledAt,
            pacing,
            occasion,
            totalRecipients: recipients.length,
          },
          include: { group: { select: { name: true } } },
        });
        await tx.queueItem.createMany({
          data: recipients.map((contact, position) => ({
            campaignId: created.id,
            position,
            recipientJid: contact.jid,
            recipientName: contact.name ?? contact.pushName ?? null,
            status: 'PENDING',
            scheduledAt: new Date(startMs + estimateDurationMs(position, pacing)),
          })),
        });
        // The draft has become a campaign.
        await tx.draft.deleteMany({ where: { sessionId } });
        return created;
      });

      const when = scheduledAt
        ? `Scheduled for ${scheduledAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} (${serverTimeZone()}).`
        : quiet
          ? `It's quiet hours (${await describeQuietHours()}), so sending starts at ${await quietHoursEnd()}.`
          : 'Sending now.';
      dispatcher.log(sessionId, campaign.id, quiet && !scheduledAt ? 'warn' : 'info', `Campaign queued for ${recipients.length} recipient(s) in "${group.name}". ${when}`);
      if (status === 'PROCESSING') dispatcher.kick(sessionId);
      res.status(201).json(toCampaignDTO(campaign));
    }),
  );

  // --- Media (compression pipeline) -----------------------------------------

  /** Upload an original. Compression runs in the background; poll the job or listen for `media_job`. */
  router.post(
    '/sessions/:sessionId/media',
    upload.single('media'),
    ah(async (req, res) => {
      const file = req.file;
      if (!file) throw new HttpError(400, 'Choose a file to upload.');
      const kind = detectMediaKind(file.mimetype, file.originalname);
      if (!kind) {
        await removeUpload(file.path);
        throw new HttpError(400, 'Unsupported file type.');
      }
      // "compress" form field: anything but "false" means compress (the default).
      const compress = (req.body as Record<string, unknown>)?.compress !== 'false';
      const limit = compress
        ? kind === 'image' ? IMAGE_MAX_INPUT_BYTES : null
        : kind === 'image' ? ORIGINAL_IMAGE_MAX_BYTES : ORIGINAL_VIDEO_MAX_BYTES;
      if (limit !== null && file.size > limit) {
        await removeUpload(file.path);
        throw new HttpError(
          400,
          compress
            ? 'Images can be up to 25 MB.'
            : `To send ${kind === 'image' ? 'an image' : 'a video'} as-is it must be under ${Math.round(limit / 1048576)} MB. Choose “Compress” instead.`,
        );
      }
      const job = startMediaJob({
        sessionId: req.params.sessionId,
        uploadPath: file.path,
        kind,
        originalName: file.originalname.slice(0, 200),
        compress,
      });
      res.status(202).json(job);
    }),
  );

  router.get(
    '/sessions/:sessionId/media/jobs/:jobId',
    ah(async (req, res) => {
      const job = getMediaJob(req.params.sessionId, req.params.jobId);
      if (!job) throw new HttpError(404, 'That upload is no longer being tracked. Attach the file again.');
      res.json(job);
    }),
  );

  /** Delete a compressed file that was attached and then removed (kept if any campaign uses it). */
  router.delete(
    '/sessions/:sessionId/media/:file',
    ah(async (req, res) => {
      const { file } = req.params;
      if (!isMediaFileName(file)) throw new HttpError(400, 'Not a media file.');
      const inUse = await prisma.broadcastCampaign.count({ where: { mediaPath: { endsWith: file } } });
      if (inUse === 0) await deleteMediaFile(file);
      res.status(204).end();
    }),
  );

  // --- Festival e-cards ---------------------------------------------------------

  /** Generate a festival e-card and return it as a ready attachment. */
  router.post(
    '/sessions/:sessionId/ecards',
    ah(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const occasion = getOccasion(readString(body.occasion));
      if (!occasion) throw new HttpError(400, 'Pick an occasion for the card.');
      const title = readString(body.title).slice(0, 40) || occasion.card.title.en;
      const subtitle = readString(body.subtitle).slice(0, 80);
      res.status(201).json(await createECard({ occasion, title, subtitle }, UPLOAD_DIR, req.params.sessionId));
    }),
  );

  // --- Draft auto-save ---------------------------------------------------------

  router.get(
    '/sessions/:sessionId/draft',
    ah(async (req, res) => {
      const draft = await prisma.draft.findUnique({ where: { sessionId: req.params.sessionId } });
      const media = draft?.media ? await readMediaInfo((JSON.parse(draft.media) as { file?: unknown }).file) : null;
      const payload: DraftDTO = {
        groupId: draft?.groupId ?? null,
        name: draft?.name ?? '',
        messageTemplate: draft?.messageTemplate ?? '',
        media,
        scheduledAt: draft?.scheduledAt ? draft.scheduledAt.toISOString() : null,
        occasion: draft?.occasion ?? null,
        language: draft?.language ?? 'en',
        pacing: draft?.pacing ?? 'careful',
        updatedAt: draft ? draft.updatedAt.toISOString() : null,
      };
      res.json(payload);
    }),
  );

  router.put(
    '/sessions/:sessionId/draft',
    ah(async (req, res) => {
      const { sessionId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const template = typeof body.messageTemplate === 'string' ? body.messageTemplate.slice(0, MAX_TEMPLATE_LENGTH) : '';
      const media = body.mediaFile ? await readMediaInfo(body.mediaFile) : null;
      const scheduled = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
      const data = {
        groupId: readString(body.groupId) || null,
        name: readString(body.name).slice(0, 120),
        messageTemplate: template,
        media: media ? JSON.stringify({ file: media.file }) : null,
        scheduledAt: scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : null,
        occasion: isOccasionId(body.occasion) ? body.occasion : null,
        language: body.language === 'hi' || body.language === 'hinglish' ? body.language : 'en',
        pacing: isPacingMode(body.pacing) ? body.pacing : 'careful',
      };
      await prisma.userSession.upsert({ where: { id: sessionId }, create: { id: sessionId }, update: {} });
      const saved = await prisma.draft.upsert({ where: { sessionId }, create: { sessionId, ...data }, update: data });
      res.json({ updatedAt: saved.updatedAt.toISOString() });
    }),
  );

  router.delete(
    '/sessions/:sessionId/draft',
    ah(async (req, res) => {
      await prisma.draft.deleteMany({ where: { sessionId: req.params.sessionId } });
      res.status(204).end();
    }),
  );

  // --- Settings ----------------------------------------------------------------

  router.get(
    '/settings/quiet-hours',
    ah(async (_req, res) => {
      res.json(await getQuietHoursSettings());
    }),
  );

  router.put(
    '/settings/quiet-hours',
    ah(async (req, res) => {
      let saved;
      try {
        saved = await saveQuietHours(req.body);
      } catch (err) {
        throw new HttpError(400, errorMessage(err));
      }
      res.json(saved);
      // Apply the new window right away instead of at the next minute tick.
      onQuietHoursChanged?.();
    }),
  );

  router.get(
    '/sessions/:sessionId/campaigns/:campaignId',
    ah(async (req, res) => {
      const { sessionId, campaignId } = req.params;
      const campaign = await prisma.broadcastCampaign.findFirst({
        where: { id: campaignId, sessionId },
        include: { group: { select: { name: true } } },
      });
      if (!campaign) throw new HttpError(404, 'Campaign not found.');
      const items = await prisma.queueItem.findMany({
        where: { campaignId, status: { not: 'PENDING' } },
        orderBy: { updatedAt: 'desc' },
        take: LOG_HISTORY_LIMIT,
      });
      const payload: CampaignDetailResponse = {
        campaign: toCampaignDTO(campaign),
        logs: items.reverse().map(queueItemToLog),
      };
      res.json(payload);
    }),
  );

  const control = (action: 'pause' | 'resume' | 'abort'): RequestHandler =>
    ah(async (req, res) => {
      const { sessionId, campaignId } = req.params;
      const exists = await prisma.broadcastCampaign.findFirst({ where: { id: campaignId, sessionId } });
      if (!exists) throw new HttpError(404, 'Campaign not found.');
      const dto = await dispatcher[action](sessionId, campaignId);
      res.json(dto);
    });

  router.post('/sessions/:sessionId/campaigns/:campaignId/pause', control('pause'));
  router.post('/sessions/:sessionId/campaigns/:campaignId/resume', control('resume'));
  router.post('/sessions/:sessionId/campaigns/:campaignId/abort', control('abort'));

  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (videos up to 500 MB, images up to 25 MB).' : err.message;
      res.status(400).json({ error: message });
      return;
    }
    if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON in the request body.' });
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'A group with that name already exists.' });
      return;
    }
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: errorMessage(err) });
  };
  router.use(onError);

  return router;
}
