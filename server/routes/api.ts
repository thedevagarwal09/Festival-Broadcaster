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
import { ALLOWED_MEDIA, removeUpload, upload } from '../upload';
import { HttpError, errorMessage } from '../utils/errors';
import type { SessionManager } from '../whatsapp/session-manager';
import { estimateDurationMs } from '../../src/lib/pacing';
import { validateTemplate } from '../../src/lib/spintax';
import {
  isValidSessionId,
  type CampaignDetailResponse,
  type ContactDTO,
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

export function createApiRouter(deps: { sessions: SessionManager; dispatcher: Dispatcher }): express.Router {
  const { sessions, dispatcher } = deps;
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

  // --- Groups ----------------------------------------------------------------

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

  router.post(
    '/sessions/:sessionId/campaigns',
    upload.single('media'),
    ah(async (req, res) => {
      const { sessionId } = req.params;
      const file = req.file;
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const groupId = readString(body.groupId);
        const messageTemplate = typeof body.messageTemplate === 'string' ? body.messageTemplate.trim() : '';
        const requestedName = readString(body.name);

        if (!messageTemplate && !file) throw new HttpError(400, 'Write a message or attach an image/video.');
        if (messageTemplate.length > MAX_TEMPLATE_LENGTH) {
          throw new HttpError(400, `Message must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`);
        }
        const templateError = validateTemplate(messageTemplate);
        if (templateError) throw new HttpError(400, `Spintax error: ${templateError}`);

        if (file) {
          const rule = ALLOWED_MEDIA.get(file.mimetype);
          if (!rule) throw new HttpError(400, 'Unsupported attachment type.');
          if (file.size > rule.maxBytes) {
            throw new HttpError(400, `Attachment is too large (max ${Math.round(rule.maxBytes / 1024 / 1024)} MB).`);
          }
        }

        await prisma.userSession.upsert({ where: { id: sessionId }, create: { id: sessionId }, update: {} });
        const group = await prisma.contactGroup.findFirst({
          where: { id: groupId, sessionId },
          include: { contacts: { orderBy: [{ name: 'asc' }, { phone: 'asc' }] } },
        });
        if (!group) throw new HttpError(404, 'Pick a contact group to broadcast to.');

        const recipients = [...new Map(group.contacts.map((c) => [c.jid, c])).values()];
        if (recipients.length === 0) throw new HttpError(400, 'That group has no contacts.');

        const now = Date.now();
        const mediaType = file ? (file.mimetype.startsWith('video/') ? 'video' : 'image') : null;
        const mediaPath = file ? path.relative(process.cwd(), file.path) : null;
        const name =
          requestedName.slice(0, 120) ||
          `${group.name} · ${new Date(now).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;

        const campaign = await prisma.$transaction(async (tx) => {
          const created = await tx.broadcastCampaign.create({
            data: {
              sessionId,
              groupId: group.id,
              name,
              messageTemplate,
              mediaPath,
              mediaType,
              status: 'RUNNING',
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
              scheduledAt: new Date(now + estimateDurationMs(position)),
            })),
          });
          return created;
        });

        dispatcher.log(
          sessionId,
          campaign.id,
          'info',
          `Campaign queued for ${recipients.length} recipient(s) in "${group.name}".`,
        );
        dispatcher.kick(sessionId);
        res.status(201).json(toCampaignDTO(campaign));
      } catch (err) {
        await removeUpload(file?.path);
        throw err;
      }
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
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Attachment is too large (max 64 MB).' : err.message;
      res.status(400).json({ error: message });
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
