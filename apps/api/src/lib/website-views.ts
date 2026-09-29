import { and, asc, count, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { events, galleries, photos, type ApiClient, type Event } from '../db/schema.js';
import { isUuid } from '../http/guards.js';
import { pageParams } from '../http/validate.js';
import { effectiveDownloadPolicy, isPubliclyAvailable } from './access.js';
import { signMedia } from './api-keys.js';
import { notFound } from './errors.js';
import { q } from './sql.js';

const MEDIA_URL_TTL = 3600;

/**
 * What a website credential is allowed to see. Shared by the live /v1 API and the administrator's
 * Developer preview so the preview can never drift from what websites really receive.
 */
export function createWebsiteViews(ctx: AppContext) {
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

  async function listEvents(client: ApiClient, query: { page?: number; pageSize?: number }) {
    const { limit, offset, page, pageSize } = pageParams(query);
    const where = and(...visibleEvents(client, true));
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select().from(events).where(where).orderBy(sql`${events.eventDate} desc nulls last`, asc(events.id)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(events).where(where),
    ]);
    return { items: rows.map(eventJson), total, page, pageSize };
  }

  async function galleriesOf(ev: Event) {
    const rows = await ctx.db
      .select({
        g: galleries,
        n: sql<number>`(select count(*) from ${photos} where ${photos.galleryId} = ${q(galleries.id)} and ${photos.status} = 'ready' and ${photos.isHidden} = false)::int`,
      })
      .from(galleries)
      .where(and(eq(galleries.eventId, ev.id), eq(galleries.isVisible, true)))
      .orderBy(asc(galleries.sortOrder));
    return { items: rows.map(({ g, n }) => ({ id: g.id, name: g.name, description: g.description, photoCount: n })) };
  }

  async function photosOf(client: ApiClient, ev: Event, query: { galleryId?: string; page?: number; pageSize?: number }) {
    const { limit, offset, page, pageSize } = pageParams(query);
    const conds: SQL[] = [eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false), sql`(${photos.galleryId} is null or ${galleries.isVisible})`];
    if (query.galleryId) conds.push(eq(photos.galleryId, query.galleryId));
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
  }

  return { visibleEvents, loadEvent, mediaUrl, eventJson, listEvents, galleriesOf, photosOf };
}
export type WebsiteViews = ReturnType<typeof createWebsiteViews>;
