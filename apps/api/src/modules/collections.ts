import { and, asc, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiClients, collectionItems, collectionWebsites, collections, events, photos, type Collection } from '../db/schema.js';
import type { Tx } from '../db/client.js';
import { isUuid, makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
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
    id: c.id, slug: c.slug, name: c.name, description: c.description, status: c.status, coverPhotoId: c.coverPhotoId, createdAt: c.createdAt, updatedAt: c.updatedAt, ...extra,
  });

  async function load(id: string) {
    if (!isUuid(id)) throw notFound('Collection not found');
    const [c] = await ctx.db.select().from(collections).where(eq(collections.id, id));
    if (!c) throw notFound('Collection not found');
    return c;
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
    const q = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    const rows = await ctx.db
      .select({
        c: collections,
        n: sql<number>`(select count(*) from ${collectionItems} ci where ci.collection_id = ${collections.id})::int`,
        thumb: sql<string | null>`(select p.thumb_key from ${photos} p where p.id = coalesce(${collections.coverPhotoId}, (select ci.photo_id from ${collectionItems} ci where ci.collection_id = ${collections.id} order by ci.sort_order, ci.added_at limit 1)))`,
      })
      .from(collections)
      .where(q.q ? ilike(collections.name, `%${q.q.replace(/[\\%_]/g, '\\$&')}%`) : undefined)
      .orderBy(desc(collections.updatedAt));
    return { items: await Promise.all(rows.map(async (r) => dto(r.c, { itemCount: r.n, coverUrl: r.thumb ? await ctx.storage.presignDownload(r.thumb, { ttlSeconds: 900 }) : null }))) };
  });

  app.post('/collections', { preHandler }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(160),
        description: z.string().max(5000).default(''),
        websiteIds: websiteIdsSchema.default([]),
      }),
      req.body,
    );
    const slug = await uniqueSlug(body.name);
    const created = await ctx.db.transaction(async (tx) => {
      await validateWebsites(tx, body.websiteIds);
      const { websiteIds, ...collectionData } = body;
      const [row] = await tx.insert(collections).values({ ...collectionData, slug, createdBy: req.user!.id }).returning();
      if (websiteIds.length > 0) {
        await tx.insert(collectionWebsites).values(
          websiteIds.map((clientId) => ({
            collectionId: row!.id,
            clientId,
          })),
        );
      }
      await audit(tx, actorFromRequest(req), { action: 'collection.created', entityType: 'collection', entityId: row!.id, after: dto(row!) });
      return row!;
    });
    reply.code(201);
    return { collection: dto(created, { itemCount: 0 }) };
  });

  app.get('/collections/:id', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    const [[{ n } = { n: 0 }], websites] = await Promise.all([
      ctx.db.select({ n: count() }).from(collectionItems).where(eq(collectionItems.collectionId, c.id)),
      ctx.db.select({ clientId: collectionWebsites.clientId }).from(collectionWebsites).where(eq(collectionWebsites.collectionId, c.id)),
    ]);
    return {
      collection: dto(c, {
        itemCount: n,
        websiteIds: websites.map(({ clientId }) => clientId),
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
      if (!m) throw badRequest('The cover must be an item of this collection');
    }
    const updated = await ctx.db.transaction(async (tx) => {
      if (body.websiteIds !== undefined) {
        await validateWebsites(tx, body.websiteIds);
      }
      const { websiteIds, ...collectionUpdates } = body;
      const [row] = Object.keys(collectionUpdates).length > 0
        ? await tx.update(collections).set(collectionUpdates).where(eq(collections.id, c.id)).returning()
        : [c];

      if (websiteIds !== undefined) {
        await tx.delete(collectionWebsites).where(eq(collectionWebsites.collectionId, c.id));
        if (websiteIds.length > 0) {
          await tx.insert(collectionWebsites).values(
            websiteIds.map((clientId) => ({
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
    return { collection: dto(updated) };
  });

  app.delete('/collections/:id', { preHandler }, async (req, reply) => {
    const c = await load((req.params as { id: string }).id);
    await ctx.db.transaction(async (tx) => {
      await tx.delete(collections).where(eq(collections.id, c.id));
      await audit(tx, actorFromRequest(req), { action: 'collection.deleted', entityType: 'collection', entityId: c.id, before: dto(c) });
    });
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