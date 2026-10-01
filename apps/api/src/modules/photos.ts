import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { galleries, photos, users, type Photo } from '../db/schema.js';
import { isUuid, loadManagedEvent, makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { enqueuePhoto } from '../lib/jobs.js';
import { publicStorageProblem } from '../lib/storage-config.js';
import { ALLOWED_TYPES, downloadName, mediaKindOf, normalizeTags, photoKeys } from '../lib/media.js';

const MAX_BATCH = 200;

export const photoRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  const limitFor = (contentType: string) => (mediaKindOf(contentType) === 'video' ? ctx.config.MAX_VIDEO_BYTES : ctx.config.MAX_UPLOAD_BYTES);
  const humanSize = (n: number) => (n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);

  async function loadPhoto(req: FastifyRequest, id: string, level: 'manage' | 'contribute' = 'manage') {
    if (!isUuid(id)) throw notFound('Photograph not found');
    const [p] = await ctx.db.select().from(photos).where(eq(photos.id, id));
    if (!p) throw notFound('Photograph not found');
    const event = await loadManagedEvent(ctx, req, p.eventId, level); // access enforced here
    return { photo: p, event };
  }

  /**
   * Uploading needs images:upload. The one exception is a cover-only image, which an event's owner or editor may add
   * with just events:edit (editors do not upload event photos).
   */
  function requireUploadRight(req: FastifyRequest, opts: { cover?: boolean } = {}) {
    const perms = req.perms!;
    if (perms.has('images:upload')) return;
    if (opts.cover && perms.has('events:edit')) return;
    throw forbidden('Missing permission: images:upload');
  }

  /** Invited photographers may only act on what they uploaded themselves. */
  function ownUploadOnly(req: FastifyRequest, p: Pick<Photo, 'uploaderId'>) {
    if (req.eventAccess === 'contribute' && p.uploaderId !== req.user!.id) throw forbidden('You can only change your own uploads');
  }

  async function photoView(p: Photo) {
    const ready = p.status === 'ready';
    return {
      id: p.id,
      eventId: p.eventId,
      galleryId: p.galleryId,
      mediaType: p.mediaType,
      uploaderId: p.uploaderId,
      filename: p.filename,
      title: p.title,
      description: p.description,
      tags: p.tags,
      durationSeconds: p.durationSeconds,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
      width: p.width,
      height: p.height,
      format: p.format,
      status: p.status,
      error: p.error,
      attempts: p.attempts,
      isHidden: p.isHidden,
      downloadPolicy: p.downloadPolicy,
      sortOrder: p.sortOrder,
      takenAt: p.takenAt,
      createdAt: p.createdAt,
      thumbUrl: ready && p.thumbKey ? await ctx.storage.presignDownload(p.thumbKey, { ttlSeconds: 900 }) : null,
      previewUrl: ready && p.previewKey ? await ctx.storage.presignDownload(p.previewKey, { ttlSeconds: 900 }) : null,
    };
  }

  // ---------- upload ----------

  app.post('/events/:id/uploads', { preHandler: guard.user }, async (req) => {
    const body = parse(
      z.object({
        galleryId: z.string().uuid().optional(),
        /** Upload as a hidden, cover-only image (not shown in the gallery). Managers only. */
        asCover: z.boolean().optional(),
        files: z
          .array(
            z.object({
              filename: z.string().trim().min(1).max(255),
              contentType: z.string().max(100),
              sizeBytes: z.number().int().positive(),
              /** Folder uploads: the gallery to put this file in, created on first use. */
              galleryName: z.string().trim().min(1).max(120).optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
      }),
      req.body,
    );
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    if (!['draft', 'active'].includes(ev.status)) throw conflict(`Uploads are closed for ${ev.status} events`);
    if (body.asCover && req.eventAccess !== 'manage') throw forbidden('Only the event owner or an editor can set the cover');
    requireUploadRight(req, { cover: body.asCover });
    // Never hand out upload links a visitor's browser cannot use (they would point at "localhost" on the visitor's own computer).
    const storageProblem = publicStorageProblem(ctx.config);
    if (storageProblem) {
      ctx.log.error({ problem: storageProblem }, 'uploads refused: storage address is not usable from browsers');
      throw new AppError(503, 'storage_not_configured', 'Uploads are not available yet: the file storage address has not been set up. Please tell an administrator (System health explains what to change).', { problem: storageProblem });
    }

    if (body.galleryId) {
      const [g] = await ctx.db.select({ id: galleries.id }).from(galleries).where(and(eq(galleries.id, body.galleryId), eq(galleries.eventId, ev.id)));
      if (!g) throw badRequest('Gallery does not belong to this event');
    }

    const rejected: { filename: string; reason: string }[] = [];
    const accepted = body.files.filter((f) => {
      if (!ALLOWED_TYPES[f.contentType]) rejected.push({ filename: f.filename, reason: `Unsupported type ${f.contentType}` });
      else if (f.sizeBytes > limitFor(f.contentType)) rejected.push({ filename: f.filename, reason: `Larger than ${humanSize(limitFor(f.contentType))}` });
      else return true;
      return false;
    });

    // Quota applies to the uploader's own total footprint, wherever they uploaded.
    const [uploader] = await ctx.db.select().from(users).where(eq(users.id, req.user!.id));
    if (uploader?.storageQuotaBytes) {
      const [{ used } = { used: 0 }] = await ctx.db
        .select({ used: sql<number>`coalesce(sum(size_bytes + preview_size_bytes + thumb_size_bytes), 0)::float8` })
        .from(photos)
        .where(eq(photos.uploaderId, uploader.id));
      const incoming = accepted.reduce((s, f) => s + f.sizeBytes, 0);
      if (used + incoming > uploader.storageQuotaBytes) throw new AppError(413, 'quota_exceeded', 'Storage quota exceeded');
    }

    // Folder uploads name a gallery per subfolder: reuse an existing gallery of that name (case-insensitive) or create it.
    const galleryByName = new Map<string, string>();
    const wanted = [...new Set(accepted.map((f) => f.galleryName?.toLowerCase()).filter((n): n is string => !!n))];
    if (wanted.length) {
      const existing = await ctx.db.select({ id: galleries.id, name: galleries.name, sortOrder: galleries.sortOrder }).from(galleries).where(eq(galleries.eventId, ev.id));
      for (const g of existing) galleryByName.set(g.name.toLowerCase(), g.id);
      let nextOrder = existing.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1;
      const toCreate = accepted.map((f) => f.galleryName).filter((n, i, arr): n is string => !!n && !galleryByName.has(n.toLowerCase()) && arr.findIndex((x) => x?.toLowerCase() === n.toLowerCase()) === i);
      if (existing.length + toCreate.length > 100) throw badRequest('An event can have at most 100 galleries. Upload without grouping by folder, or merge some folders.');
      for (const name of toCreate) {
        const [g] = await ctx.db.insert(galleries).values({ eventId: ev.id, name, sortOrder: nextOrder++ }).returning({ id: galleries.id });
        galleryByName.set(name.toLowerCase(), g!.id);
      }
    }

    const galleryId = body.galleryId ?? (await ctx.db.select({ id: galleries.id }).from(galleries).where(eq(galleries.eventId, ev.id)).orderBy(asc(galleries.sortOrder)).limit(1))[0]?.id ?? null;

    const rows = accepted.length
      ? await ctx.db
          .insert(photos)
          .values(
            accepted.map((f) => {
              const id = crypto.randomUUID();
              return {
                id,
                eventId: ev.id,
                galleryId: (f.galleryName && galleryByName.get(f.galleryName.toLowerCase())) || galleryId,
                uploaderId: req.user!.id,
                isHidden: !!body.asCover,
                filename: f.filename,
                contentType: f.contentType,
                mediaType: mediaKindOf(f.contentType),
                sizeBytes: f.sizeBytes,
                originalKey: `events/${ev.id}/originals/${id}.${ALLOWED_TYPES[f.contentType]}`,
              };
            }),
          )
          .returning()
      : [];

    const uploads = await Promise.all(
      rows.map(async (p) => ({ photoId: p.id, filename: p.filename, uploadUrl: await ctx.storage.presignUpload(p.originalKey, p.contentType) })),
    );
    return { uploads, rejected };
  });

  app.post('/photos/:id/upload-url', { preHandler: guard.user }, async (req) => {
    const { photo } = await loadPhoto(req, (req.params as { id: string }).id, 'contribute');
    ownUploadOnly(req, photo);
    requireUploadRight(req, { cover: photo.isHidden });
    if (photo.status !== 'pending_upload' && photo.status !== 'failed') throw conflict('This photograph has already been uploaded');
    return { uploadUrl: await ctx.storage.presignUpload(photo.originalKey, photo.contentType) };
  });

  app.post('/events/:id/uploads/complete', { preHandler: guard.user }, async (req) => {
    const { photoIds } = parse(z.object({ photoIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH) }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    requireUploadRight(req, { cover: req.eventAccess === 'manage' });
    const contributing = req.eventAccess === 'contribute';
    const rows = await ctx.db.select().from(photos).where(and(eq(photos.eventId, ev.id), inArray(photos.id, photoIds), ...(contributing ? [eq(photos.uploaderId, req.user!.id)] : [])));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const results = await Promise.all(
      photoIds.map(async (id) => {
        const p = byId.get(id);
        if (!p) return { photoId: id, ok: false, error: 'Unknown photograph' };
        if (p.status !== 'pending_upload' && p.status !== 'failed') return { photoId: id, ok: true, status: p.status }; // idempotent
        const head = await ctx.storage.head(p.originalKey);
        if (!head) return { photoId: id, ok: false, error: 'File was not received; upload it again' };
        if (head.size !== p.sizeBytes) {
          await ctx.storage.delete([p.originalKey]);
          return { photoId: id, ok: false, error: 'Upload was incomplete; upload it again' };
        }
        await enqueuePhoto(ctx, p.id);
        return { photoId: id, ok: true, status: 'uploaded' };
      }),
    );
    return { results };
  });

  // ---------- retry ----------

  app.post('/photos/:id/retry', { preHandler: guard.perm('images:upload') }, async (req) => {
    const { photo } = await loadPhoto(req, (req.params as { id: string }).id, 'contribute');
    ownUploadOnly(req, photo);
    if (photo.status !== 'failed') throw conflict('Only failed photographs can be retried');
    // The original was retained, so reprocessing never needs another upload.
    await enqueuePhoto(ctx, photo.id);
    return { ok: true };
  });

  app.post('/events/:id/photos/retry-failed', { preHandler: guard.perm('images:upload') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    const failed = await ctx.db.select({ id: photos.id }).from(photos).where(and(eq(photos.eventId, ev.id), eq(photos.status, 'failed'), ...(req.eventAccess === 'contribute' ? [eq(photos.uploaderId, req.user!.id)] : [])));
    for (const f of failed) await enqueuePhoto(ctx, f.id);
    return { retried: failed.length };
  });

  // ---------- read ----------

  app.get('/events/:id/photos', { preHandler: guard.perm('events:view') }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['pending_upload', 'uploaded', 'processing', 'ready', 'failed']).optional(),
        galleryId: z.string().uuid().optional(),
        hidden: z.enum(['true', 'false']).optional(),
        type: z.enum(['image', 'video']).optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    const { limit, offset, page, pageSize } = pageParams({ ...q, pageSize: q.pageSize ?? 60 });
    const conds: SQL[] = [eq(photos.eventId, ev.id)];
    if (q.status) conds.push(eq(photos.status, q.status));
    if (q.galleryId) conds.push(eq(photos.galleryId, q.galleryId));
    if (q.hidden) conds.push(eq(photos.isHidden, q.hidden === 'true'));
    if (q.type) conds.push(eq(photos.mediaType, q.type));
    const where = and(...conds);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select().from(photos).where(where).orderBy(asc(photos.sortOrder), asc(photos.takenAt), desc(photos.createdAt)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(photos).where(where),
    ]);
    return { items: await Promise.all(rows.map(photoView)), total, page, pageSize };
  });

  app.get('/events/:id/upload-summary', { preHandler: guard.perm('events:view') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    const rows = await ctx.db.select({ status: photos.status, n: count() }).from(photos).where(eq(photos.eventId, ev.id)).groupBy(photos.status);
    const summary = { pending_upload: 0, uploaded: 0, processing: 0, ready: 0, failed: 0 };
    for (const r of rows) summary[r.status] = r.n;
    return { ...summary, total: Object.values(summary).reduce((a, b) => a + b, 0) };
  });

  // ---------- organise ----------

  app.patch('/photos/:id', { preHandler: guard.user }, async (req) => {
    const body = parse(
      z.object({
        // Descriptive metadata (needs media:edit)
        title: z.string().trim().max(200).nullable().optional(),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string().max(200)).max(60).optional(),
        // Organisation (needs galleries:manage)
        galleryId: z.string().uuid().nullable().optional(),
        isHidden: z.boolean().optional(),
        downloadPolicy: z.enum(['disabled', 'preview', 'full']).nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    const touchesMeta = body.title !== undefined || body.description !== undefined || body.tags !== undefined;
    const touchesOrg = body.galleryId !== undefined || body.isHidden !== undefined || body.downloadPolicy !== undefined || body.sortOrder !== undefined;
    if (touchesMeta && !req.perms!.has('media:edit')) throw forbidden('Missing permission: media:edit');
    if (touchesOrg && !req.perms!.has('galleries:manage')) throw forbidden('Missing permission: galleries:manage');
    if (!touchesMeta && !touchesOrg) throw badRequest('Nothing to update');

    const { photo } = await loadPhoto(req, (req.params as { id: string }).id, 'contribute');
    // Invited photographers may describe their own uploads; organising the event's media is for owners and editors.
    if (req.eventAccess === 'contribute') {
      ownUploadOnly(req, photo);
      if (touchesOrg) throw forbidden('Only the event owner or an editor can organise the gallery');
    }
    if (body.galleryId) {
      const [g] = await ctx.db.select({ id: galleries.id }).from(galleries).where(and(eq(galleries.id, body.galleryId), eq(galleries.eventId, photo.eventId)));
      if (!g) throw badRequest('Gallery does not belong to this event');
    }
    const patch = { ...body, ...(body.title !== undefined && { title: body.title || null }), ...(body.tags !== undefined && { tags: normalizeTags(body.tags) }) };
    const row = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx.update(photos).set(patch).where(eq(photos.id, photo.id)).returning();
      if (touchesMeta) {
        await audit(tx, actorFromRequest(req), {
          action: 'media.updated',
          entityType: 'photo',
          entityId: photo.id,
          eventId: photo.eventId,
          before: { title: photo.title, description: photo.description, tags: photo.tags },
          after: { title: updated!.title, description: updated!.description, tags: updated!.tags },
        });
      }
      return updated!;
    });
    return { photo: await photoView(row) };
  });

  app.post('/events/:id/photos/bulk', { preHandler: guard.perm('galleries:manage') }, async (req) => {
    const body = parse(
      z.object({
        photoIds: z.array(z.string().uuid()).min(1).max(1000),
        galleryId: z.string().uuid().nullable().optional(),
        isHidden: z.boolean().optional(),
      }),
      req.body,
    );
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    if (body.galleryId) {
      const [g] = await ctx.db.select({ id: galleries.id }).from(galleries).where(and(eq(galleries.id, body.galleryId), eq(galleries.eventId, ev.id)));
      if (!g) throw badRequest('Gallery does not belong to this event');
    }
    const patch = { ...(body.galleryId !== undefined && { galleryId: body.galleryId }), ...(body.isHidden !== undefined && { isHidden: body.isHidden }) };
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');
    const updated = await ctx.db.update(photos).set(patch).where(and(eq(photos.eventId, ev.id), inArray(photos.id, body.photoIds))).returning({ id: photos.id });
    return { updated: updated.length };
  });

  // ---------- original download for the owner / admin ----------

  app.get('/photos/:id/original', { preHandler: guard.perm('images:download') }, async (req) => {
    const { photo } = await loadPhoto(req, (req.params as { id: string }).id, 'contribute');
    ownUploadOnly(req, photo);
    if (photo.status === 'pending_upload') throw conflict('Not uploaded yet');
    return { url: await ctx.storage.presignDownload(photo.originalKey, { filename: downloadName(photo), inline: false }) };
  });

  // ---------- permanent deletion: administrators only ----------

  const adminDelete = guard.perm('images:delete');

  async function permanentlyDelete(req: FastifyRequest, list: Photo[]) {
    for (const p of list) {
      // Audit first, atomically with the row removal; object deletion follows.
      await ctx.db.transaction(async (tx) => {
        await audit(tx, actorFromRequest(req), {
          action: 'photo.deleted',
          entityType: 'photo',
          entityId: p.id,
          eventId: p.eventId,
          before: { filename: p.filename, sizeBytes: p.sizeBytes, status: p.status },
        });
        await tx.delete(photos).where(eq(photos.id, p.id));
      });
      await ctx.storage.delete(photoKeys(p));
    }
  }

  app.delete('/photos/:id', { preHandler: adminDelete }, async (req, reply) => {
    const { photo } = await loadPhoto(req, (req.params as { id: string }).id);
    await permanentlyDelete(req, [photo]);
    reply.code(204);
  });

  app.post('/events/:id/photos/delete', { preHandler: adminDelete }, async (req) => {
    const { photoIds } = parse(z.object({ photoIds: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id, 'contribute');
    const contributing = req.eventAccess === 'contribute';
    const rows = await ctx.db.select().from(photos).where(and(eq(photos.eventId, ev.id), inArray(photos.id, photoIds), ...(contributing ? [eq(photos.uploaderId, req.user!.id)] : [])));
    await permanentlyDelete(req, rows);
    return { deleted: rows.length };
  });
};

