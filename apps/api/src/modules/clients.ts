import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiClients, apiUsageDaily, collectionItems, collectionWebsites, collections, events, photos } from '../db/schema.js';
import { isUuid, makeGuards } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { generateApiKey, SCOPES } from '../lib/api-keys.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';
import { createWebsiteAuthenticator } from '../lib/website-auth.js';
import { createWebsiteViews } from '../lib/website-views.js';
import type { UsageRecorder } from '../lib/usage.js';
import { clientDto } from './dto.js';

const scopeList = z.array(z.enum(SCOPES)).min(1);
const origins = z.array(z.string().url().transform((u) => new URL(u).origin)).max(20);

export const clientRoutes: FastifyPluginAsync<{ usage: UsageRecorder }> = async (app, { usage }) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const websiteViews = createWebsiteViews(ctx);
  // Website registration and API credentials are separate permissions, both administrator-only.
  const preHandler = guard.perm('websites:manage', 'api:manage');
  const { authenticate } = createWebsiteAuthenticator(ctx, usage);

  app.addHook('onResponse', async (req, reply) => {
    if (req.apiClient && reply.statusCode >= 400) usage.recordError(req.apiClient.id);
  });

  async function load(id: string) {
    if (!isUuid(id)) throw notFound('Website not found');
    const [c] = await ctx.db.select().from(apiClients).where(eq(apiClients.id, id));
    if (!c) throw notFound('Website not found');
    return c;
  }

  async function uniqueCollectionSlug(name: string) {
    const base = slugify(name);
    for (let i = 0; i < 6; i++) {
      const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const [hit] = await ctx.db.select({ id: collections.id }).from(collections).where(eq(collections.slug, candidate));
      if (!hit) return candidate;
    }
    throw conflict('Could not allocate a unique link for this collection');
  }

  async function validateEventIds(ids: string[] | null | undefined) {
    if (!ids?.length) return;
    const found = await ctx.db.select({ id: events.id }).from(events).where(inArray(events.id, ids));
    if (found.length !== new Set(ids).size) throw badRequest('One or more events do not exist');
  }

  app.get('/admin/websites', { preHandler }, async () => {
    const rows = await ctx.db.select().from(apiClients).orderBy(desc(apiClients.createdAt));
    return { items: rows.map(clientDto) };
  });

  app.post('/admin/websites', { preHandler }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(500).default(''),
        scopes: scopeList.default(['events:read', 'galleries:read', 'images:read', 'collections:read']),
        allowedEventIds: z.array(z.string().uuid()).nullable().default(null),
        allowedOrigins: origins.default([]),
        rateLimitPerMinute: z.number().int().min(10).max(100_000).default(600),
      }),
      req.body,
    );
    await validateEventIds(body.allowedEventIds);
    const { key, keyPrefix, keyHash } = generateApiKey();
    const created = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.insert(apiClients).values({ ...body, keyPrefix, keyHash, createdBy: req.user!.id }).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.created', entityType: 'api_client', entityId: row!.id, after: clientDto(row!) });
      return row!;
    });
    reply.code(201);
    // The secret is shown exactly once; only its hash is stored.
    return { website: clientDto(created), apiKey: key };
  });

  app.get('/admin/websites/:id', { preHandler }, async (req) => ({ website: clientDto(await load((req.params as { id: string }).id)) }));

  app.patch('/admin/websites/:id', { preHandler }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(500),
        scopes: scopeList,
        allowedEventIds: z.array(z.string().uuid()).nullable(),
        allowedOrigins: origins,
        rateLimitPerMinute: z.number().int().min(10).max(100_000),
        status: z.enum(['active', 'disabled']),
      }).partial(),
      req.body,
    );
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') throw conflict('Revoked access cannot be modified; create a new website credential');
    await validateEventIds(body.allowedEventIds);
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(apiClients).set(body).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), {
        action: body.status && body.status !== c.status ? (body.status === 'active' ? 'api_client.enabled' : 'api_client.disabled') : 'api_client.updated',
        entityType: 'api_client',
        entityId: c.id,
        before: clientDto(c),
        after: clientDto(row!),
      });
      return row!;
    });
    return { website: clientDto(updated) };
  });

  app.post('/admin/websites/:id/revoke', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') return { website: clientDto(c) };
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(apiClients).set({ status: 'revoked', revokedAt: new Date() }).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.revoked', entityType: 'api_client', entityId: c.id, before: { status: c.status }, after: { status: 'revoked' } });
      return row!;
    });
    return { website: clientDto(updated) };
  });

  app.post('/admin/websites/:id/rotate-key', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') throw conflict('Revoked access cannot be rotated');
    const { key, keyPrefix, keyHash } = generateApiKey();
    const [row] = await ctx.db.transaction(async (tx) => {
      const rows = await tx.update(apiClients).set({ keyPrefix, keyHash }).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.key_rotated', entityType: 'api_client', entityId: c.id });
      return rows;
    });
    return { website: clientDto(row!), apiKey: key };
  });

  app.get('/admin/websites/:id/usage', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const rows = await ctx.db.select().from(apiUsageDaily).where(and(eq(apiUsageDaily.clientId, c.id), gte(apiUsageDaily.day, since))).orderBy(apiUsageDaily.day);
    return { items: rows };
  });

  app.get('/admin/websites/:id/collections', {
    preHandler: async (req, reply) => {
      if (req.headers.authorization !== undefined || req.headers['x-api-key'] !== undefined) {
        await authenticate('collections:read')(req);
        const id = (req.params as { id: string }).id;
        if (!isUuid(id) || req.apiClient!.id !== id) throw notFound('Website not found');
        return;
      }
      await preHandler(req, reply);
    },
  }, async (req) => {
    const id = (req.params as { id: string }).id;
    const client = req.apiClient ?? await load(id);
    const rows = await ctx.db
      .select({
        c: collections,
        itemCount: sql<number>`(select count(*) from ${collectionItems} ci where ci.collection_id = ${collections.id})::int`,
        thumb: sql<string | null>`(select p.thumb_key from ${photos} p where p.id = coalesce(${collections.coverPhotoId}, (select ci.photo_id from ${collectionItems} ci where ci.collection_id = ${collections.id} order by ci.sort_order, ci.added_at limit 1)))`,
      })
      .from(collections)
      .innerJoin(collectionWebsites, eq(collectionWebsites.collectionId, collections.id))
      .where(req.apiClient
        ? and(eq(collectionWebsites.clientId, client.id), eq(collections.status, 'published'))
        : eq(collectionWebsites.clientId, client.id))
      .orderBy(desc(collections.updatedAt));

    const items = await Promise.all(
      rows.map(async (r) => {
        const publicView = req.apiClient ? await websiteViews.loadCollection(client, r.c.slug) : null;
        return {
          id: r.c.id,
          slug: r.c.slug,
          name: r.c.name,
          description: r.c.description,
          status: req.apiClient ? 'published' : r.c.status,
          coverPhotoId: req.apiClient ? null : r.c.coverPhotoId,
          websiteId: client.id,
          websiteIds: [client.id],
          itemCount: req.apiClient ? publicView?.mediaCount ?? 0 : r.itemCount,
          coverUrl: req.apiClient
            ? publicView?.thumbnail ?? null
            : r.thumb
              ? await ctx.storage.presignDownload(r.thumb, { ttlSeconds: 900 })
              : null,
          createdAt: r.c.createdAt,
          updatedAt: r.c.updatedAt,
        };
      }),
    );
    return { items };
  });

  app.post('/admin/websites/:id/collections', { preHandler }, async (req, reply) => {
    const client = await load((req.params as { id: string }).id);
    if (client.status !== 'active') throw badRequest('Website is not active');
    if (!client.scopes.includes('collections:read')) throw badRequest('Website does not have collections:read scope');

    const body = parse(
      z.object({
        // Either link an existing collection:
        collectionId: z.string().uuid().optional(),
        // Or create a new collection directly:
        name: z.string().trim().min(2).max(160).optional(),
        description: z.string().max(5000).default(''),
      }),
      req.body,
    );

    if (body.collectionId) {
      const [existing] = await ctx.db.select().from(collections).where(eq(collections.id, body.collectionId));
      if (!existing) throw notFound('Collection not found');

      await ctx.db.transaction(async (tx) => {
        // Enforce 1 website per collection: remove any previous website assignments
        await tx.delete(collectionWebsites).where(eq(collectionWebsites.collectionId, existing.id));
        await tx.insert(collectionWebsites).values({
          collectionId: existing.id,
          clientId: client.id,
        });
        await tx.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, existing.id));
        await audit(tx, actorFromRequest(req), {
          action: 'collection.assigned_to_website',
          entityType: 'collection',
          entityId: existing.id,
          meta: { clientId: client.id, clientName: client.name },
        });
      });

      const [[{ n } = { n: 0 }], [photo]] = await Promise.all([
        ctx.db.select({ n: sql<number>`count(*)::int` }).from(collectionItems).where(eq(collectionItems.collectionId, existing.id)),
        existing.coverPhotoId ? ctx.db.select({ thumbKey: photos.thumbKey }).from(photos).where(eq(photos.id, existing.coverPhotoId)) : Promise.resolve([]),
      ]);
      const coverUrl = photo?.thumbKey ? await ctx.storage.presignDownload(photo.thumbKey, { ttlSeconds: 900 }) : null;

      reply.code(201);
      return {
        collection: {
          id: existing.id,
          slug: existing.slug,
          name: existing.name,
          description: existing.description,
          status: existing.status,
          coverPhotoId: existing.coverPhotoId,
          websiteId: client.id,
          websiteIds: [client.id],
          itemCount: n,
          coverUrl,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        },
      };
    }

    if (!body.name) {
      throw badRequest('Either collectionId or name is required');
    }

    const slug = await uniqueCollectionSlug(body.name);
    const created = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(collections)
        .values({
          name: body.name!,
          description: body.description,
          slug,
          createdBy: req.user!.id,
        })
        .returning();

      await tx.insert(collectionWebsites).values({
        collectionId: row!.id,
        clientId: client.id,
      });

      await audit(tx, actorFromRequest(req), {
        action: 'collection.created',
        entityType: 'collection',
        entityId: row!.id,
        after: row,
      });
      return row!;
    });

    reply.code(201);
    return {
      collection: {
        id: created.id,
        slug: created.slug,
        name: created.name,
        description: created.description,
        status: created.status,
        coverPhotoId: created.coverPhotoId,
        websiteId: client.id,
        websiteIds: [client.id],
        itemCount: 0,
        coverUrl: null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    };
  });
};
