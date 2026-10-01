import { and, asc, count, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { collectionItems, collections, users } from '../db/schema.js';
import { hasTag, publiclyVisibleMedia, textSearch } from './media-query.js';
import { downloadName } from './media.js';
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

  const eventContext = (e: Event) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    date: e.eventDate,
    location: e.location,
    publicUrl: `${ctx.config.PUBLIC_WEB_URL}/e/${e.slug}`,
  });

  interface MediaFilters {
    eventId?: string;
    galleryId?: string;
    collectionId?: string;
    id?: string;
    type?: 'image' | 'video';
    q?: string;
    tag?: string;
    page?: number;
    pageSize?: number;
  }

  /**
   * The single place that turns rows into what a website receives, so event pages, search, single lookups and
   * collections can never disagree. Every item carries its event's name, description, date and location.
   */
  async function mediaOf(client: ApiClient, f: MediaFilters = {}) {
    const { limit, offset, page, pageSize } = pageParams(f);
    const conds: SQL[] = [...publiclyVisibleMedia(sql`${galleries.isVisible}`)];
    if (client.allowedEventIds?.length) conds.push(inArray(events.id, client.allowedEventIds));
    if (f.eventId) conds.push(eq(events.id, f.eventId));
    if (f.id) conds.push(eq(photos.id, f.id));
    if (f.galleryId) conds.push(eq(photos.galleryId, f.galleryId));
    if (f.type) conds.push(eq(photos.mediaType, f.type));
    if (f.tag) conds.push(hasTag(f.tag));
    const text = f.q ? textSearch(f.q, { withEvent: true }) : undefined;
    if (text) conds.push(text);
    if (f.collectionId) conds.push(sql`exists (select 1 from ${collectionItems} ci where ci.photo_id = ${photos.id} and ci.collection_id = ${f.collectionId})`);
    const where = and(...conds);
    const base = () =>
      ctx.db.select({ p: photos, g: galleries, e: events, owner: users.name }).from(photos)
        .innerJoin(events, eq(events.id, photos.eventId))
        .innerJoin(users, eq(users.id, events.ownerId))
        .leftJoin(galleries, eq(galleries.id, photos.galleryId));
    const order = f.collectionId
      ? [sql`(select ci.sort_order from ${collectionItems} ci where ci.photo_id = ${photos.id} and ci.collection_id = ${f.collectionId})`, asc(photos.id)]
      : [asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt), asc(photos.id)];
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      base().where(where).orderBy(...order).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(photos)
        .innerJoin(events, eq(events.id, photos.eventId))
        .leftJoin(galleries, eq(galleries.id, photos.galleryId))
        .where(where),
    ]);
    const canImages = client.scopes.includes('images:read');
    const canDownload = client.scopes.includes('downloads:read');
    return {
      items: rows.map(({ p, g, e, owner }) => ({
        id: p.id,
        type: p.mediaType,
        title: p.title ?? p.filename.replace(/\.[^.]+$/, ''),
        filename: p.filename,
        description: p.description,
        tags: p.tags,
        width: p.width,
        height: p.height,
        durationSeconds: p.durationSeconds,
        takenAt: p.takenAt,
        galleryId: p.galleryId,
        event: eventContext(e),
        photographer: owner,
        downloadName: downloadName(p),
        urls: canImages
          ? {
              thumbnail: mediaUrl(client, p.id, 'thumbnail'),
              preview: mediaUrl(client, p.id, 'preview'),
              download: canDownload && effectiveDownloadPolicy(e, g, p) !== 'disabled' ? mediaUrl(client, p.id, 'download') : null,
            }
          : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  // ---- collections ----
  async function loadCollection(idOrSlug: string) {
    const where = isUuid(idOrSlug) ? eq(collections.id, idOrSlug) : eq(collections.slug, idOrSlug.toLowerCase());
    const [c] = await ctx.db.select().from(collections).where(and(where, eq(collections.status, 'published')));
    if (!c) throw notFound('Collection not found');
    return c;
  }

  async function listCollections(client: ApiClient, query: { page?: number; pageSize?: number }) {
    const { limit, offset, page, pageSize } = pageParams(query);
    const rows = await ctx.db.select().from(collections).where(eq(collections.status, 'published')).orderBy(asc(collections.name)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(collections).where(eq(collections.status, 'published'));
    // Counts only include what this credential may actually see.
    const items = await Promise.all(rows.map(async (c) => ({ id: c.id, slug: c.slug, name: c.name, description: c.description, mediaCount: (await mediaOf(client, { collectionId: c.id, pageSize: 1 })).total })));
    return { items, total, page, pageSize };
  }

  const photosOf = (client: ApiClient, ev: Event, f: Omit<MediaFilters, 'eventId'> = {}) => mediaOf(client, { ...f, eventId: ev.id });

  return { visibleEvents, loadEvent, mediaUrl, eventJson, eventContext, listEvents, galleriesOf, photosOf, mediaOf, loadCollection, listCollections };
}
export type WebsiteViews = ReturnType<typeof createWebsiteViews>;
