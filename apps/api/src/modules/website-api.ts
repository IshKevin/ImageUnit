import { and, asc, count, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/sql.js';
import type { UsageRecorder } from '../lib/usage.js';
import { apiClients, events, galleries, photos, type ApiClient, type Event } from '../db/schema.js';
import { isUuid } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { effectiveDownloadPolicy, isPubliclyAvailable } from '../lib/access.js';
import { hashApiKey, signMedia, verifyMedia, type Scope } from '../lib/api-keys.js';
import { AppError, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { downloadName } from '../lib/media.js';
import { track } from '../lib/public-access.js';
import { createWebsiteViews } from '../lib/website-views.js';

const memoryWindows = new Map<string, number>();

/**
 * Programmatic access for the company's websites. Authenticated with a revocable bearer key;
 * only active, non-expired, non-private events are ever exposed, whatever the key's scopes.
 */
export const websiteApiRoutes: FastifyPluginAsync<{ usage: UsageRecorder }> = async (app, { usage }) => {
  const ctx = app.ctx;

  async function rateLimit(client: ApiClient) {
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:client:${client.id}:${window}`;
    let hits: number;
    if (ctx.redis) {
      hits = await ctx.redis.incr(key);
      if (hits === 1) await ctx.redis.expire(key, 90);
    } else {
      hits = (memoryWindows.get(key) ?? 0) + 1;
      memoryWindows.set(key, hits);
    }
    if (hits > client.rateLimitPerMinute) throw new AppError(429, 'rate_limited', 'Rate limit exceeded');
  }

  function checkOrigin(client: ApiClient, req: FastifyRequest) {
    const origin = req.headers.origin;
    if (origin && client.allowedOrigins.length > 0 && !client.allowedOrigins.includes(origin)) throw forbidden('Origin not allowed for this credential');
  }

  const authenticate = (scope: Scope) => async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] as string | undefined);
    if (!raw) throw unauthorized('API key required');
    const [client] = await ctx.db.select().from(apiClients).where(eq(apiClients.keyHash, hashApiKey(raw)));
    if (!client) throw unauthorized('Invalid API key');
    // Checked against the database on every request, so revocation is immediate.
    if (client.status !== 'active') throw forbidden(`This credential is ${client.status}`);
    if (!client.scopes.includes(scope)) throw forbidden(`Missing scope: ${scope}`);
    checkOrigin(client, req);
    await rateLimit(client);
    req.apiClient = client;
    usage.record(client.id);
  };

  app.addHook('onResponse', async (req, reply) => {
    if (req.apiClient && reply.statusCode >= 400) usage.recordError(req.apiClient.id);
  });

  // CORS: bearer keys are not ambient credentials, so reflecting the origin is safe; the allow-list is enforced per key above.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-headers', 'authorization, content-type, x-api-key');
      reply.header('access-control-allow-methods', 'GET, OPTIONS');
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });

  const views = createWebsiteViews(ctx);
  const { visibleEvents, loadEvent } = views;

  app.get('/v1/events', { preHandler: authenticate('events:read') }, async (req) => {
    const query = parse(z.object({ page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query);
    return views.listEvents(req.apiClient!, query);
  });

  app.get('/v1/events/:id', { preHandler: authenticate('events:read') }, async (req) => ({
    event: await views.eventJson(await loadEvent(req.apiClient!, (req.params as { id: string }).id), req.apiClient!),
  }));

  app.get('/v1/events/:id/galleries', { preHandler: authenticate('galleries:read') }, async (req) => {
    const ev = await loadEvent(req.apiClient!, (req.params as { id: string }).id);
    return views.galleriesOf(ev);
  });

  const mediaQuery = z.object({
    type: z.enum(['image', 'video']).optional(),
    q: z.string().trim().max(100).optional(),
    tag: z.string().trim().max(60).optional(),
    galleryId: z.string().uuid().optional(),
    page: z.coerce.number().optional(),
    pageSize: z.coerce.number().optional(),
  });

  // `/photos` is kept as an alias of `/media` for existing integrations; both return images and videos.
  for (const path of ['media', 'photos']) {
    app.get(`/v1/events/:id/${path}`, { preHandler: authenticate('images:read') }, async (req) => {
      const client = req.apiClient!;
      const query = parse(mediaQuery, req.query);
      const ev = await loadEvent(client, (req.params as { id: string }).id);
      return views.photosOf(client, ev, query);
    });
  }

  /** Search across everything the credential may see: `?q=` words, `?type=video`, `?tag=`. */
  app.get('/v1/media', { preHandler: authenticate('images:read') }, async (req) => views.mediaOf(req.apiClient!, parse(mediaQuery, req.query)));

  app.get('/v1/media/:id', { preHandler: authenticate('images:read') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await views.mediaOf(req.apiClient!, { id, pageSize: 1 });
    if (!r.items[0]) throw notFound('Media not found');
    return { media: r.items[0] };
  });

  // ---- collections: curated sets of media, possibly spanning many events ----
  app.get('/v1/collections', { preHandler: authenticate('collections:read') }, async (req) =>
    views.listCollections(req.apiClient!, parse(z.object({ page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query)),
  );

  app.get('/v1/collections/:id', { preHandler: authenticate('collections:read') }, async (req) => {
    const c = await views.loadCollection((req.params as { id: string }).id);
    const { total } = await views.mediaOf(req.apiClient!, { collectionId: c.id, pageSize: 1 });
    return { collection: { id: c.id, slug: c.slug, name: c.name, description: c.description, mediaCount: total } };
  });

  app.get('/v1/collections/:id/media', { preHandler: authenticate('collections:read') }, async (req) => {
    const c = await views.loadCollection((req.params as { id: string }).id);
    return views.mediaOf(req.apiClient!, { ...parse(mediaQuery, req.query), collectionId: c.id });
  });

  // Media is delivered through signed, expiring URLs. Each hit re-validates the credential, the event and the download policy.
  app.get('/v1/media/:id/:kind', async (req, reply) => {
    const { id, kind } = parse(z.object({ id: z.string().uuid(), kind: z.enum(['thumbnail', 'preview', 'download']) }), req.params);
    const q = parse(z.object({ c: z.string().uuid(), exp: z.coerce.number(), sig: z.string().min(10).max(100) }), req.query);
    if (!verifyMedia(ctx.config.SESSION_SECRET, { photoId: id, kind, clientId: q.c, exp: q.exp }, q.sig)) throw forbidden('Invalid or expired media link');

    const [client] = await ctx.db.select().from(apiClients).where(eq(apiClients.id, q.c));
    if (!client || client.status !== 'active') throw forbidden('Access revoked');
    const needed: Scope = kind === 'download' ? 'downloads:read' : 'images:read';
    if (!client.scopes.includes(needed)) throw forbidden(`Missing scope: ${needed}`);
    await rateLimit(client);
    usage.record(client.id);

    const [row] = await ctx.db
      .select({ p: photos, ev: events, g: galleries })
      .from(photos)
      .innerJoin(events, eq(events.id, photos.eventId))
      .leftJoin(galleries, eq(galleries.id, photos.galleryId))
      .where(and(eq(photos.id, id), eq(photos.status, 'ready'), sql`(${photos.isHidden} = false or ${events.coverPhotoId} = ${photos.id})`, ...visibleEvents(client, false)));
    if (!row || !isPubliclyAvailable(row.ev) || (row.g && !row.g.isVisible)) throw notFound('Photograph not found');

    let key: string | null;
    let policyIsFull = false;
    if (kind === 'download') {
      const policy = effectiveDownloadPolicy(row.ev, row.g, row.p);
      policyIsFull = policy === 'full';
      if (policy === 'disabled') throw forbidden('Downloads are disabled for this event');
      key = policy === 'full' ? row.p.originalKey : row.p.previewKey;
      await track(ctx, req, { eventId: row.ev.id, photoId: id, type: 'download', source: 'api' });
      usage.record(client.id, { bytes: policy === 'full' ? row.p.sizeBytes : row.p.previewSizeBytes });
    } else {
      key = kind === 'thumbnail' ? row.p.thumbKey : row.p.previewKey;
    }
    if (!key) throw notFound('File unavailable');
    const url = await ctx.storage.presignDownload(key, { ttlSeconds: 120, ...(kind === 'download' && { filename: downloadName(row.p, policyIsFull ? undefined : row.p.mediaType === 'video' ? 'mp4' : 'jpg'), inline: false }) });
    reply.header('cache-control', 'private, max-age=60');
    return reply.redirect(url, 302);
  });
};
