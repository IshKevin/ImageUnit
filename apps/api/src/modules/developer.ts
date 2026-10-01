import { eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiClients, type Event } from '../db/schema.js';
import { loadManagedEvent, makeGuards } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { isPubliclyAvailable } from '../lib/access.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { createWebsiteViews } from '../lib/website-views.js';
import { clientDto } from './dto.js';

const RESOURCES = {
  event: { scope: 'events:read', path: (id: string) => `/events/${id}` },
  galleries: { scope: 'galleries:read', path: (id: string) => `/events/${id}/galleries` },
  photos: { scope: 'images:read', path: (id: string) => `/events/${id}/media` },
} as const;

/** Why websites can or cannot currently see an event. */
function exposure(ev: Event): { exposed: boolean; reason: string } {
  if (ev.visibility === 'private') return { exposed: false, reason: 'Password-protected events are never exposed to websites.' };
  if (ev.status !== 'active') return { exposed: false, reason: `The event is "${ev.status.replace(/_/g, ' ')}". Only active events are exposed.` };
  if (!isPubliclyAvailable(ev)) return { exposed: false, reason: 'The event has passed its expiry date.' };
  return { exposed: true, reason: ev.visibility === 'unlisted' ? 'Exposed by id or slug; unlisted events are not included in list responses unless a website is allow-listed for it.' : 'Exposed to every website (subject to each website\'s scopes and allow-list).' };
}

/** Administrator-only developer tooling for an event: endpoints, access and a faithful API preview. */
export const developerRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const preHandler = guard.perm('api:manage'); // administrator-only permission
  const views = createWebsiteViews(ctx);
  const base = `${ctx.config.API_PUBLIC_URL}/api/v1`;

  app.get('/admin/events/:id/developer', { preHandler }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const clients = await ctx.db.select().from(apiClients).where(ne(apiClients.status, 'revoked'));
    const state = exposure(ev);
    return {
      apiBaseUrl: base,
      event: { id: ev.id, slug: ev.slug, name: ev.name, status: ev.status, visibility: ev.visibility },
      exposure: state,
      endpoints: [
        ...Object.entries(RESOURCES).map(([key, r]) => ({ key, method: 'GET', url: `${base}${r.path(ev.id)}`, scope: r.scope })),
        { key: 'search', method: 'GET', url: `${base}/media?q=&type=&tag=`, scope: 'images:read', note: 'Search every media item this credential may see.' },
        { key: 'collections', method: 'GET', url: `${base}/collections`, scope: 'collections:read', note: 'Curated sets of media; /collections/{slug}/media lists their items.' },
        { key: 'media', method: 'GET', url: `${base}/media/{photoId}/{thumbnail|preview|download}`, scope: 'images:read (downloads:read for download)', note: 'Use the signed urls returned by the photos endpoint; they expire after 1 hour.' },
      ],
      websites: clients.map((c) => ({
        ...clientDto(c),
        // Whether this credential can currently reach this event at all.
        canAccess: state.exposed && c.status === 'active' && (!c.allowedEventIds?.length || c.allowedEventIds.includes(ev.id)),
      })),
    };
  });

  app.get('/admin/events/:id/developer/preview', { preHandler }, async (req) => {
    const q = parse(
      z.object({
        clientId: z.string().uuid(),
        resource: z.enum(['event', 'galleries', 'photos']),
        galleryId: z.string().uuid().optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const [client] = await ctx.db.select().from(apiClients).where(eq(apiClients.id, q.clientId));
    if (!client) throw notFound('Website not found');
    if (client.status !== 'active') throw conflict(`This credential is ${client.status}, so it would receive 403 from the API.`);

    const r = RESOURCES[q.resource];
    const request = `GET ${base}${r.path(ev.id)}${q.resource === 'photos' ? '?pageSize=' + (q.pageSize ?? 25) : ''}`;
    if (!client.scopes.includes(r.scope)) {
      return { request, status: 403, body: { error: { code: 'forbidden', message: `Missing scope: ${r.scope}` } } };
    }
    try {
      const visible = await views.loadEvent(client, ev.id);
      const body =
        q.resource === 'event' ? { event: await views.eventJson(visible, client) }
        : q.resource === 'galleries' ? await views.galleriesOf(visible)
        : await views.photosOf(client, visible, { galleryId: q.galleryId, page: q.page, pageSize: q.pageSize ?? 25 });
      return { request, status: 200, body };
    } catch (err) {
      if (err instanceof AppError) return { request, status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
      throw err;
    }
  });
};

