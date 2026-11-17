import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiClients, collectionItems, collectionWebsites, collections, events, photos, type Collection } from '../db/schema.js';
import type { Tx } from '../db/client.js';
import { isUuid, makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { assertCoverUpload, COVER_UPLOAD_TYPES, coverCropKeys, cropSchema, MAX_COVER_UPLOAD_BYTES, renderCover } from '../lib/cover.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { filterSchema, libraryConds, resolveSelection, selectionSchema, sortSchema } from '../lib/library.js';
import { createItemView } from '../lib/library-view.js';
import { slugify } from '../lib/slug.js';
import { uuidSet } from '../lib/sql.js';

const websiteIdsSchema = z.array(z.string().uuid()).refine((ids) => new Set(ids).size === ids.length, 'Website IDs must be unique');

/** Collections: curated, named sets of media (any mix of events) that company websites can fetch by slug. */
export const collectionRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const preHandler = guard.perm('collections:manage');
  const itemView = createItemView(ctx);

  const dto = (c: Collection, extra: Record<string, unknown> = {}) => ({
    id: c.id, slug: c.slug, name: c.name, description: c.description, status: c.status, coverPhotoId: c.coverPhotoId,
    coverCrop: c.coverCrop, coverUploaded: !!c.coverOriginalKey, createdAt: c.createdAt, updatedAt: c.updatedAt, ...extra,
  });
  /** Every stored file that belongs to the collection's cover (uploaded original and renditions). */
  const coverFiles = (c: Collection) => [...coverCropKeys(c), ...(c.coverOriginalKey ? [c.coverOriginalKey] : [])];
  const noCover = { coverOriginalKey: null, coverCrop: null, coverPreviewKey: null, coverThumbKey: null } as const;

  async function load(id: string) {
    if (!isUuid(id)) throw notFound('Collection not found');
    const [c] = await ctx.db.select().from(collections).where(eq(collections.id, id));
    if (!c) throw notFound('Collection not found');
    return c;
  }

  /**
   * Cover precedence: an uploaded cover, then the chosen photo (cropped when a crop is set), then the
   * first item. coverUrl is what everyone sees; coverSource is the uncropped picture for the crop editor.
   */
  async function coverInfo(c: Collection) {
    const sign = (key: string) => ctx.storage.presignDownload(key, { ttlSeconds: 900 });
    if (c.coverOriginalKey && c.coverPreviewKey) {
      return { coverUrl: await sign(c.coverPreviewKey), coverSource: { kind: 'upload' as const, photoId: null, url: await sign(c.coverOriginalKey), croppable: true } };
    }
    const cols = { id: photos.id, previewKey: photos.previewKey, mediaType: photos.mediaType };
    let src = c.coverPhotoId ? (await ctx.db.select(cols).from(photos).where(and(eq(photos.id, c.coverPhotoId), eq(photos.status, 'ready'))))[0] : undefined;
    if (!src?.previewKey) {
      src = (await ctx.db
        .select(cols)
        .from(photos)
        .innerJoin(collectionItems, eq(collectionItems.photoId, photos.id))
        .where(and(eq(collectionItems.collectionId, c.id), eq(photos.status, 'ready'), eq(photos.isHidden, false)))
        .orderBy(asc(collectionItems.sortOrder), asc(collectionItems.addedAt))
        .limit(1))[0];
    }
    if (!src?.previewKey) return { coverUrl: null, coverSource: null };
    const sourceUrl = await sign(src.previewKey);
    const cropped = src.id === c.coverPhotoId ? c.coverPreviewKey : null;
    return {
      coverUrl: cropped ? await sign(cropped) : sourceUrl,
      coverSource: { kind: 'photo' as const, photoId: src.id, url: sourceUrl, croppable: src.mediaType === 'image' },
    };
  }

  /** Applies a new cover state, audits it, and removes the files the old state no longer uses. */
  async function saveCover(req: Parameters<typeof actorFromRequest>[0], c: Collection, patch: Partial<Collection>) {
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(collections).set(patch).where(eq(collections.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), {
        action: 'collection.updated', entityType: 'collection', entityId: c.id,
        before: { coverPhotoId: c.coverPhotoId, coverCrop: c.coverCrop, coverUploaded: !!c.coverOriginalKey },
        after: { coverPhotoId: row!.coverPhotoId, coverCrop: row!.coverCrop, coverUploaded: !!row!.coverOriginalKey },
      });
      return row!;
    });
    const keep = new Set(coverFiles(updated));
    const stale = coverFiles(c).filter((k) => !keep.has(k));
    await ctx.storage.delete(stale).catch((err) => ctx.log.warn({ err }, 'collection cover cleanup failed'));
    return updated;
  }

  async function uniqueSlug(name: string) {
    const base = slugify(name);
    for (let i = 0; i < 6; i++) {
      const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const [hit] = await ctx.db.select({ id: collections.id }).from(collections).where(eq(collections.slug, candidate));
      if (!hit) return candidate;
    }
    throw conflict('Could not allocate a unique link for this collection');
  }

  async function validateWebsites(tx: Tx, websiteIds: string[]) {
    if (websiteIds.length === 0) return;
    const uniqueIds = [...new Set(websiteIds)];
    const found = await tx.select().from(apiClients).where(inArray(apiClients.id, uniqueIds));
    if (found.length !== uniqueIds.length) {
      throw badRequest('One or more websites do not exist');
    }
    for (const w of found) {
      if (w.status !== 'active') throw badRequest('Website is not active');
      if (!w.scopes.includes('collections:read')) throw badRequest('Website does not have collections:read scope');
    }
  }

  app.get('/collections', { preHandler }, async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), websiteId: z.string().uuid().optional() }), req.query);
    const whereConds = [];
    if (q.q) whereConds.push(ilike(collections.name, `%${q.q.replace(/[\\%_]/g, '\\$&')}%`));
    if (q.websiteId) {
      whereConds.push(sql`exists (select 1 from ${collectionWebsites} cw where cw.collection_id = ${collections.id} and cw.client_id = ${q.websiteId})`);
    }
    const where = whereConds.length ? and(...whereConds) : undefined;
    const rows = await ctx.db
      .select({
        c: collections,
        n: sql<number>`(select count(*) from ${collectionItems} ci where ci.collection_id = ${collections.id})::int`,
        thumb: sql<string | null>`coalesce(${collections.coverThumbKey}, (select p.thumb_key from ${photos} p where p.id = coalesce(${collections.coverPhotoId}, (select ci.photo_id from ${collectionItems} ci where ci.collection_id = ${collections.id} order by ci.sort_order, ci.added_at limit 1))))`,
      })
      .from(collections)
      .where(where)
      .orderBy(desc(collections.updatedAt));
    return { items: await Promise.all(rows.map(async (r) => dto(r.c, { itemCount: r.n, coverUrl: r.thumb ? await ctx.storage.presignDownload(r.thumb, { ttlSeconds: 900 }) : null }))) };
  });

  app.post('/collections', { preHandler }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160),
        description: z.string().max(5000).default(''),
        websiteId: z.string().uuid().nullable().optional(),
        websiteIds: websiteIdsSchema.optional(),
      }),
      req.body,
    );
    const finalWebsiteIds = body.websiteId !== undefined
      ? (body.websiteId ? [body.websiteId] : [])
      : (body.websiteIds ?? []);

    const slug = await uniqueSlug(body.name);
    const created = await ctx.db.transaction(async (tx) => {
      await validateWebsites(tx, finalWebsiteIds);
      const { websiteId, websiteIds, ...collectionData } = body;
      const [row] = await tx.insert(collections).values({ ...collectionData, slug, createdBy: req.user!.id }).returning();
      if (finalWebsiteIds.length > 0) {
        await tx.insert(collectionWebsites).values(
          finalWebsiteIds.map((clientId) => ({
            collectionId: row!.id,
            clientId,
          })),
        );
      }
      await audit(tx, actorFromRequest(req), { action: 'collection.created', entityType: 'collection', entityId: row!.id, after: dto(row!) });
      return row!;
    });
    reply.code(201);
    const primaryWebsiteId = finalWebsiteIds[0] ?? null;
    return { collection: dto(created, { itemCount: 0, websiteId: primaryWebsiteId, websiteIds: finalWebsiteIds, coverUrl: null }) };
  });

  app.get('/collections/:id', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    const [[{ n } = { n: 0 }], websites, cover] = await Promise.all([
      ctx.db.select({ n: count() }).from(collectionItems).where(eq(collectionItems.collectionId, c.id)),
      ctx.db.select({ clientId: collectionWebsites.clientId }).from(collectionWebsites).where(eq(collectionWebsites.collectionId, c.id)),
      coverInfo(c),
    ]);
    const websiteIdList = websites.map(({ clientId }) => clientId);
    return {
      collection: dto(c, {
        itemCount: n,
        websiteId: websiteIdList[0] ?? null,
        websiteIds: websiteIdList,
        ...cover,
        apiUrl: `${ctx.config.API_PUBLIC_URL}/api/v1/collections/${c.slug}`,
      }),
    };
  });

  app.patch('/collections/:id', { preHandler }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160),
        description: z.string().max(5000),
        status: z.enum(['draft', 'published']),
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(2).max(80),
        coverPhotoId: z.string().uuid().nullable(),
        websiteId: z.string().uuid().nullable().optional(),
        websiteIds: websiteIdsSchema.optional(),
      }).partial(),
      req.body,
    );
    const c = await load((req.params as { id: string }).id);
    if (body.slug && body.slug !== c.slug) {
      if (c.status === 'published') throw conflict('Unpublish the collection before changing its link');
      const [hit] = await ctx.db.select({ id: collections.id }).from(collections).where(eq(collections.slug, body.slug));
      if (hit) throw conflict('That link is already taken');
    }
    if (body.coverPhotoId) {
      const [m] = await ctx.db.select({ id: collectionItems.photoId }).from(collectionItems).where(and(eq(collectionItems.collectionId, c.id), eq(collectionItems.photoId, body.coverPhotoId)));
      const [readyCover] = await ctx.db.select({ id: photos.id }).from(photos).where(and(eq(photos.id, body.coverPhotoId), eq(photos.status, 'ready')));
      if (!m && !readyCover) throw badRequest('The cover photo is not found or not ready');
    }
    const finalWebsiteIds = body.websiteId !== undefined
      ? (body.websiteId ? [body.websiteId] : [])
      : body.websiteIds;
    const dropsCover = body.coverPhotoId !== undefined && (body.coverPhotoId !== c.coverPhotoId || !!c.coverOriginalKey) && coverFiles(c).length > 0;

    const updated = await ctx.db.transaction(async (tx) => {
      if (finalWebsiteIds !== undefined) {
        await validateWebsites(tx, finalWebsiteIds);
      }
      const { websiteId, websiteIds, ...rest } = body;
      // Choosing a cover photo (or automatic) replaces an uploaded cover and any crop.
      const collectionUpdates: Partial<Collection> = { ...rest, ...(dropsCover && noCover) };
      const [row] = Object.keys(collectionUpdates).length > 0
        ? await tx.update(collections).set(collectionUpdates).where(eq(collections.id, c.id)).returning()
        : [c];

      if (finalWebsiteIds !== undefined) {
        await tx.delete(collectionWebsites).where(eq(collectionWebsites.collectionId, c.id));
        if (finalWebsiteIds.length > 0) {
          await tx.insert(collectionWebsites).values(
            finalWebsiteIds.map((clientId) => ({
              collectionId: c.id,
              clientId,
            })),
          );
        }
      }

      await audit(tx, actorFromRequest(req), {
        action: body.status && body.status !== c.status ? (body.status === 'published' ? 'collection.published' : 'collection.unpublished') : 'collection.updated',
        entityType: 'collection', entityId: c.id, before: dto(c), after: dto(row!),
      });
      return row!;
    });
    if (dropsCover) await ctx.storage.delete(coverFiles(c)).catch((err) => req.log.warn({ err }, 'collection cover cleanup failed'));
    const [websites, cover, [{ n } = { n: 0 }]] = await Promise.all([
      ctx.db.select({ clientId: collectionWebsites.clientId }).from(collectionWebsites).where(eq(collectionWebsites.collectionId, c.id)),
      coverInfo(updated),
      ctx.db.select({ n: count() }).from(collectionItems).where(eq(collectionItems.collectionId, c.id)),
    ]);
    const websiteIdList = websites.map(({ clientId }) => clientId);
    return {
      collection: dto(updated, {
        itemCount: n,
        websiteId: websiteIdList[0] ?? null,
        websiteIds: websiteIdList,
        ...cover,
      }),
    };
  });

  // ---------- cover: upload your own image, crop ----------

  /** Step 1 of uploading a cover image: a short-lived URL to send the file to. */
  app.post('/collections/:id/cover-upload', { preHandler }, async (req) => {
    const body = parse(z.object({ contentType: z.enum(COVER_UPLOAD_TYPES), sizeBytes: z.number().int().positive().max(MAX_COVER_UPLOAD_BYTES, 'The cover image must be 20 MB or smaller') }), req.body);
    const c = await load((req.params as { id: string }).id);
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[body.contentType];
    const key = `collections/${c.id}/cover/upload-${randomBytes(8).toString('hex')}.${ext}`;
    return { key, uploadUrl: await ctx.storage.presignUpload(key, body.contentType, 900) };
  });

  /** Step 2: checks the uploaded file and makes it the cover, replacing any chosen photo or crop. */
  app.post('/collections/:id/cover-upload/complete', { preHandler }, async (req) => {
    const { key } = parse(z.object({ key: z.string().max(300) }), req.body);
    const c = await load((req.params as { id: string }).id);
    if (!/^collections\/[0-9a-f-]{36}\/cover\/upload-[0-9a-f]{16}\.(jpg|png|webp)$/.test(key) || !key.startsWith(`collections/${c.id}/`)) throw badRequest('Unknown upload');
    try {
      await assertCoverUpload(ctx, key);
    } catch (err) {
      await ctx.storage.delete([key]).catch(() => undefined);
      throw err;
    }
    const files = await renderCover(ctx, key, null, `collections/${c.id}/cover`);
    const updated = await saveCover(req, c, { coverPhotoId: null, coverOriginalKey: key, coverCrop: null, coverPreviewKey: files.previewKey, coverThumbKey: files.thumbKey });
    return { collection: dto(updated, await coverInfo(updated)) };
  });

  /**
   * Crops the cover. With photoId, crops that photo and makes it the cover; without, crops the uploaded
   * cover image. A null crop shows the whole picture again.
   */
  app.put('/collections/:id/cover-crop', { preHandler }, async (req) => {
    const body = parse(z.object({ photoId: z.string().uuid().optional(), crop: cropSchema.nullable() }), req.body);
    const c = await load((req.params as { id: string }).id);
    const prefix = `collections/${c.id}/cover`;
    let patch: Partial<Collection>;
    if (body.photoId) {
      const [photo] = await ctx.db.select().from(photos).where(and(eq(photos.id, body.photoId), eq(photos.status, 'ready')));
      const [member] = await ctx.db.select({ id: collectionItems.photoId }).from(collectionItems).where(and(eq(collectionItems.collectionId, c.id), eq(collectionItems.photoId, body.photoId)));
      if (!photo || (!member && photo.id !== c.coverPhotoId)) throw badRequest('The cover must be a ready item of this collection');
      if (photo.mediaType !== 'image') throw badRequest('Only photographs can be cropped');
      const files = body.crop ? await renderCover(ctx, photo.originalKey, body.crop, prefix) : null;
      patch = { ...noCover, coverPhotoId: photo.id, coverCrop: body.crop, coverPreviewKey: files?.previewKey ?? null, coverThumbKey: files?.thumbKey ?? null };
    } else {
      if (!c.coverOriginalKey) throw badRequest('Choose a cover photo or upload a cover image first');
      const files = await renderCover(ctx, c.coverOriginalKey, body.crop, prefix);
      patch = { coverCrop: body.crop, coverPreviewKey: files.previewKey, coverThumbKey: files.thumbKey };
    }
    const updated = await saveCover(req, c, patch);
    return { collection: dto(updated, await coverInfo(updated)) };
  });

  app.delete('/collections/:id', { preHandler }, async (req, reply) => {
    const c = await load((req.params as { id: string }).id);
    await ctx.db.transaction(async (tx) => {
      await tx.delete(collections).where(eq(collections.id, c.id));
      await audit(tx, actorFromRequest(req), { action: 'collection.deleted', entityType: 'collection', entityId: c.id, before: dto(c) });
    });
    await ctx.storage.delete(coverFiles(c)).catch((err) => req.log.warn({ err }, 'collection cover cleanup failed'));
    reply.code(204);
  });

  app.get('/collections/:id/items', { preHandler }, async (req) => {
    const q = parse(filterSchema.extend({ sort: sortSchema.optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query);
    const c = await load((req.params as { id: string }).id);
    const { limit, offset, page, pageSize } = pageParams({ page: q.page, pageSize: q.pageSize ?? 60 });
    const where = and(...libraryConds(req.user!, { ...q, collectionId: c.id }));
    const order = q.sort
      ? undefined
      : [sql`(select ci.sort_order from ${collectionItems} ci where ci.photo_id = ${photos.id} and ci.collection_id = ${c.id})`, asc(photos.id)];
    const base = ctx.db.select({ p: photos, e: events }).from(photos).innerJoin(events, eq(events.id, photos.eventId)).where(where);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      (order ? base.orderBy(...order) : base.orderBy(desc(photos.createdAt))).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(photos).innerJoin(events, eq(events.id, photos.eventId)).where(where),
    ]);
    return { items: await Promise.all(rows.map(({ p, e }) => itemView(p, e))), total, page, pageSize };
  });

  app.post('/collections/:id/items', { preHandler }, async (req) => {
    const { selection } = parse(z.object({ selection: selectionSchema }), req.body);
    const c = await load((req.params as { id: string }).id);
    const ids = await resolveSelection(ctx, req.user!, selection);
    if (ids.length === 0) return { added: 0, alreadyIn: 0 };
    const added = await ctx.db.transaction(async (tx) => {
      const [{ next } = { next: 0 }] = await tx.select({ next: sql<number>`coalesce(max(${collectionItems.sortOrder}), -1) + 1` }).from(collectionItems).where(eq(collectionItems.collectionId, c.id));
      let inserted = 0;
      for (let i = 0; i < ids.length; i += 2000) {
        const chunk = ids.slice(i, i + 2000);
        const r = await tx.execute(sql`
          insert into collection_items (collection_id, photo_id, sort_order, added_by)
          select ${c.id}::uuid, x.id::uuid, ${next + i} + x.ord, ${req.user!.id}::uuid
          from jsonb_array_elements_text(${JSON.stringify(chunk)}::jsonb) with ordinality as x(id, ord)
          on conflict do nothing`);
        inserted += r.rowCount ?? 0;
      }
      await tx.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, c.id));
      await audit(tx, actorFromRequest(req), { action: 'collection.items_added', entityType: 'collection', entityId: c.id, meta: { requested: ids.length, added: inserted } });
      return inserted;
    });
    return { added, alreadyIn: ids.length - added };
  });

  app.post('/collections/:id/items/remove', { preHandler }, async (req) => {
    const { selection } = parse(z.object({ selection: selectionSchema }), req.body);
    const c = await load((req.params as { id: string }).id);
    const ids = await resolveSelection(ctx, req.user!, selection);
    if (ids.length === 0) return { removed: 0 };
    const removed = await ctx.db.transaction(async (tx) => {
      const r = await tx.execute(sql`delete from collection_items where collection_id = ${c.id} and photo_id in ${uuidSet(ids)}`);
      await tx.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, c.id));
      await audit(tx, actorFromRequest(req), { action: 'collection.items_removed', entityType: 'collection', entityId: c.id, meta: { removed: r.rowCount ?? 0 } });
      return r.rowCount ?? 0;
    });
    return { removed };
  });

  app.post('/collections/:id/items/reorder', { preHandler }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) }), req.body);
    const c = await load((req.params as { id: string }).id);
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`update collection_items set sort_order = sort_order + ${ids.length} where collection_id = ${c.id}`);
      await tx.execute(sql`
        update collection_items ci set sort_order = x.ord - 1
        from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) with ordinality as x(id, ord)
        where ci.collection_id = ${c.id} and ci.photo_id = x.id::uuid`);
    });
    return { ok: true };
  });
};