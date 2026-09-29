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
import { track } from '../lib/public-access.js';

const MEDIA_URL_TTL = 3600;
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

  /** Events a client may see: available now, never private, and within the client's allow-list. */
  function visibleEvents(client: ApiClient, listing: boolean): SQL[] {
    const conds: SQL[] = [
      eq(events.status, 'active'),
      sql`(${events.expiresAt} is null or ${events.expiresAt} > now())`,
      ne(events.visibility, 'private'),
    ];
    if (client.allowedEventIds?.length) conds.push(inArray(events.id, client.allowedEventIds));
    // Unlisted events are reachable by id but never enumerated, unless explicitly allow-listed.
    else if (listing) conds.push(eq(events.visibility, 'public'));
    return conds;
  }

  async function loadEvent(client: ApiClient, idOrSlug: string): Promise<Event> {
    const where = isUuid(idOrSlug) ? eq(events.id, idOrSlug) : eq(events.slug, idOrSlug.toLowerCase());
    const [ev] = await ctx.db.select().from(events).where(and(where, ...visibleEvents(client, false)));
    if (!ev || !isPubliclyAvailable(ev)) throw notFound('Event not found');
    return ev;
  }

  const mediaUrl = (client: ApiClient, photoId: string, kind: 'thumbnail' | 'preview' | 'download') => {
    const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL;
    const sig = signMedia(ctx.config.SESSION_SECRET, { photoId, kind, clientId: client.id, exp });
    return `${ctx.config.API_PUBLIC_URL}/api/v1/media/${photoId}/${kind}?c=${client.id}&exp=${exp}&sig=${sig}`;
  };

  const eventJson = (e: Event) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    date: e.eventDate,
    location: e.location,
    downloadPolicy: e.downloadPolicy,
    expiresAt: e.expiresAt,
    publicUrl: `${ctx.config.PUBLIC_WEB_URL}/e/${e.slug}`,
  });

  app.get('/v1/events', { preHandler: authenticate('events:read') }, async (req) => {
    const client = req.apiClient!;
    const q = parse(z.object({ page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query);
    const { limit, offset, page, pageSize } = pageParams(q);
    const where = and(...visibleEvents(client, true));
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select().from(events).where(where).orderBy(sql`${events.eventDate} desc nulls last`, asc(events.id)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(events).where(where),
    ]);
    return { items: rows.map(eventJson), total, page, pageSize };
  });

  app.get('/v1/events/:id', { preHandler: authenticate('events:read') }, async (req) => ({
    event: eventJson(await loadEvent(req.apiClient!, (req.params as { id: string }).id)),
  }));

  app.get('/v1/events/:id/galleries', { preHandler: authenticate('galleries:read') }, async (req) => {
    const ev = await loadEvent(req.apiClient!, (req.params as { id: string }).id);
    const rows = await ctx.db
      .select({
        g: galleries,
        n: sql<number>`(select count(*) from ${photos} where ${photos.galleryId} = ${q(galleries.id)} and ${photos.status} = 'ready' and ${photos.isHidden} = false)::int`,
      })
      .from(galleries)
      .where(and(eq(galleries.eventId, ev.id), eq(galleries.isVisible, true)))
      .orderBy(asc(galleries.sortOrder));
    return { items: rows.map(({ g, n }) => ({ id: g.id, name: g.name, description: g.description, photoCount: n })) };
  });

  app.get('/v1/events/:id/photos', { preHandler: authenticate('images:read') }, async (req) => {
    const client = req.apiClient!;
    const q = parse(z.object({ galleryId: z.string().uuid().optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query);
    const ev = await loadEvent(client, (req.params as { id: string }).id);
    const { limit, offset, page, pageSize } = pageParams(q);
    const conds: SQL[] = [eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false), sql`(${photos.galleryId} is null or ${galleries.isVisible})`];
    if (q.galleryId) conds.push(eq(photos.galleryId, q.galleryId));
    const where = and(...conds);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select({ p: photos, g: galleries }).from(photos).leftJoin(galleries, eq(galleries.id, photos.galleryId)).where(where)
        .orderBy(asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt), asc(photos.id)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(photos).leftJoin(galleries, eq(galleries.id, photos.galleryId)).where(where),
    ]);
    const canDownload = client.scopes.includes('downloads:read');
    return {
      items: rows.map(({ p, g }) => ({
        id: p.id,
        galleryId: p.galleryId,
        filename: p.filename,
        width: p.width,
        height: p.height,
        takenAt: p.takenAt,
        urls: {
          thumbnail: mediaUrl(client, p.id, 'thumbnail'),
          preview: mediaUrl(client, p.id, 'preview'),
          download: canDownload && effectiveDownloadPolicy(ev, g, p) !== 'disabled' ? mediaUrl(client, p.id, 'download') : null,
        },
      })),
      total,
      page,
      pageSize,
    };
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
      .where(and(eq(photos.id, id), eq(photos.status, 'ready'), eq(photos.isHidden, false), ...visibleEvents(client, false)));
    if (!row || !isPubliclyAvailable(row.ev) || (row.g && !row.g.isVisible)) throw notFound('Photograph not found');

    let key: string | null;
    if (kind === 'download') {
      const policy = effectiveDownloadPolicy(row.ev, row.g, row.p);
      if (policy === 'disabled') throw forbidden('Downloads are disabled for this event');
      key = policy === 'full' ? row.p.originalKey : row.p.previewKey;
      await track(ctx, req, { eventId: row.ev.id, photoId: id, type: 'download', source: 'api' });
      usage.record(client.id, { bytes: policy === 'full' ? row.p.sizeBytes : row.p.previewSizeBytes });
    } else {
      key = kind === 'thumbnail' ? row.p.thumbKey : row.p.previewKey;
    }
    if (!key) throw notFound('File unavailable');
    const url = await ctx.storage.presignDownload(key, { ttlSeconds: 120, ...(kind === 'download' && { filename: row.p.filename, inline: false }) });
    reply.header('cache-control', 'private, max-age=60');
    return reply.redirect(url, 302);
  });
};
