import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/sql.js';
import { galleries, photos, type Event } from '../db/schema.js';
import { pageParams, parse } from '../http/validate.js';
import { effectiveDownloadPolicy } from '../lib/access.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { croppedCoverKey } from '../lib/cover.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { downloadName } from '../lib/media.js';
import { textSearch } from '../lib/media-query.js';
import { issueGrant, resolvePublicEvent, resolvePublicPhoto, track, trackDownloads } from '../lib/public-access.js';
import { safeZipName, zipStream, type ZipEntry } from '../lib/zip.js';

// Verified against for events without a password so response timing is uniform.
const DUMMY = await hashPassword('timing-equaliser');

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const mediaPath = (photoId: string, kind: string) => `/api/public/photos/${photoId}/${kind}`;

  async function findCover(ev: Pick<Event, 'id' | 'coverPhotoId' | 'coverPreviewKey' | 'coverThumbKey'>) {
    const eventId = ev.id;
    if (ev.coverPhotoId) {
      const [chosen] = await ctx.db.select({ id: photos.id, key: photos.previewKey }).from(photos).where(and(eq(photos.id, ev.coverPhotoId), eq(photos.eventId, eventId), eq(photos.status, 'ready')));
      // A cropped cover is served in place of the photo's own preview.
      if (chosen?.key) return { id: chosen.id, key: croppedCoverKey(ev, chosen.id, 'preview') ?? chosen.key };
    }
    const [first] = await ctx.db
      .select({ id: photos.id, key: photos.previewKey })
      .from(photos)
      .where(and(eq(photos.eventId, eventId), eq(photos.status, 'ready'), eq(photos.isHidden, false)))
      .orderBy(asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt))
      .limit(1);
    return first?.key ? first : null;
  }

  /** The event's cover image: redirects to a short-lived link, after the same access checks as the gallery. */
  app.get('/public/events/:slug/cover', async (req, reply) => {
    const ev = await resolvePublicEvent(ctx, req, (req.params as { slug: string }).slug);
    const cover = await findCover(ev);
    if (!cover?.key) throw new AppError(404, 'not_found', 'No cover image');
    reply.header('cache-control', 'private, max-age=120');
    return reply.redirect(await ctx.storage.presignDownload(cover.key, { ttlSeconds: 300 }), 302);
  });

  app.get('/public/events/:slug', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    // Private events reveal only their name until unlocked; everything else needs a grant.
    const ev = await resolvePublicEvent(ctx, req, slug);
    const gals = await ctx.db
      .select({
        g: galleries,
        n: sql<number>`(select count(*) from ${photos} where ${photos.galleryId} = ${q(galleries.id)} and ${photos.status} = 'ready' and ${photos.isHidden} = false)::int`,
      })
      .from(galleries)
      .where(and(eq(galleries.eventId, ev.id), eq(galleries.isVisible, true)))
      .orderBy(asc(galleries.sortOrder));
    // The chosen cover (it may be a hidden, cover-only image), otherwise the first visible photograph.
    const hasCover = !!(await findCover(ev));
    return {
      event: {
        name: ev.name,
        slug: ev.slug,
        description: ev.description,
        eventDate: ev.eventDate,
        location: ev.location,
        expiresAt: ev.expiresAt,
        downloadPolicy: ev.downloadPolicy,
        coverUrl: hasCover ? `/api/public/events/${ev.slug}/cover` : null,
        galleries: gals.filter((x) => x.n > 0).map((x) => ({ id: x.g.id, name: x.g.name, description: x.g.description, photoCount: x.n })),
      },
    };
  });

  app.post('/public/events/:slug/unlock', { config: { rateLimit: { max: ctx.config.LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const ev = await resolvePublicEvent(ctx, req, (req.params as { slug: string }).slug, { requireGrant: false });
    if (ev.visibility !== 'private') return { ok: true };
    const ok = await verifyPassword(ev.accessPasswordHash ?? DUMMY, password);
    if (!ok) throw unauthorized('Incorrect password');
    issueGrant(ctx, reply, ev);
    return { ok: true };
  });

  app.get('/public/events/:slug/photos', async (req) => {
    const q = parse(
      z.object({
        galleryId: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const ev = await resolvePublicEvent(ctx, req, (req.params as { slug: string }).slug);
    const { limit, offset, page, pageSize } = pageParams({ ...q, pageSize: q.pageSize ?? 60 });
    const conds: SQL[] = [eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false), sql`(${photos.galleryId} is null or ${galleries.isVisible})`];
    if (q.galleryId) conds.push(eq(photos.galleryId, q.galleryId));
    const text = q.q ? textSearch(q.q) : undefined;
    if (text) conds.push(text);
    const where = and(...conds);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db
        .select({ p: photos, g: galleries })
        .from(photos)
        .leftJoin(galleries, eq(galleries.id, photos.galleryId))
        .where(where)
        .orderBy(asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt), asc(photos.id))
        .limit(limit)
        .offset(offset),
      ctx.db.select({ total: count() }).from(photos).leftJoin(galleries, eq(galleries.id, photos.galleryId)).where(where),
    ]);
    return {
      items: rows.map(({ p, g }) => ({
        id: p.id,
        type: p.mediaType,
        filename: p.filename,
        title: p.title ?? p.filename.replace(/\.[^.]+$/, ''),
        description: p.description,
        tags: p.tags,
        durationSeconds: p.durationSeconds,
        width: p.width,
        height: p.height,
        galleryId: p.galleryId,
        thumbUrl: mediaPath(p.id, 'thumb'),
        previewUrl: mediaPath(p.id, 'preview'),
        downloadable: effectiveDownloadPolicy(ev, g, p) !== 'disabled',
      })),
      total,
      page,
      pageSize,
    };
  });

  app.post('/public/events/:slug/view', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ev = await resolvePublicEvent(ctx, req, (req.params as { slug: string }).slug);
    await track(ctx, req, { eventId: ev.id, type: 'event_view' });
    reply.code(204);
  });

  const redirect = async (req: Parameters<typeof resolvePublicPhoto>[1], photoId: string, kind: 'thumb' | 'preview' | 'download') => {
    const { photo, event, gallery } = await resolvePublicPhoto(ctx, req, photoId);
    if (kind === 'download') {
      const policy = effectiveDownloadPolicy(event, gallery, photo);
      if (policy === 'disabled') throw forbidden('Downloads are disabled for this gallery');
      await track(ctx, req, { eventId: event.id, photoId: photo.id, type: 'download' });
      const useOriginal = policy === 'full';
      const key = useOriginal ? photo.originalKey : photo.previewKey;
      if (!key) throw new AppError(404, 'not_found', 'File unavailable');
      const name = downloadName(photo, useOriginal ? undefined : photo.mediaType === 'video' ? 'mp4' : 'jpg');
      return ctx.storage.presignDownload(key, { filename: name, inline: false, ttlSeconds: 120 });
    }
    const key = kind === 'thumb' ? photo.thumbKey : photo.previewKey;
    if (!key) throw new AppError(404, 'not_found', 'File unavailable');
    return ctx.storage.presignDownload(key, { ttlSeconds: 300 });
  };

  for (const kind of ['thumb', 'preview', 'download'] as const) {
    app.get(`/public/photos/:id/${kind}`, async (req, reply) => {
      const url = await redirect(req, (req.params as { id: string }).id, kind);
      // Access is re-evaluated on every request, so expiry and revocation apply promptly.
      reply.header('cache-control', kind === 'download' ? 'no-store' : 'private, max-age=120');
      return reply.redirect(url, 302);
    });
  }

  /**
   * The whole gallery (or one of its galleries) as a single ZIP. Each item follows its own download
   * policy: originals where "full" applies, previews where "preview" applies, nothing where disabled.
   * Files stream from storage straight into the response, one at a time.
   */
  app.get('/public/events/:slug/download', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = parse(z.object({ galleryId: z.string().uuid().optional() }), req.query);
    const ev = await resolvePublicEvent(ctx, req, (req.params as { slug: string }).slug);
    if (ev.downloadPolicy === 'disabled') throw forbidden('Downloads are disabled for this gallery');
    const conds: SQL[] = [eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false), sql`(${photos.galleryId} is null or ${galleries.isVisible})`];
    if (q.galleryId) conds.push(eq(photos.galleryId, q.galleryId));
    const rows = await ctx.db
      .select({ p: photos, g: galleries })
      .from(photos)
      .leftJoin(galleries, eq(galleries.id, photos.galleryId))
      .where(and(...conds))
      .orderBy(asc(galleries.sortOrder), asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt), asc(photos.id));

    // One folder per gallery when the archive spans several of them.
    const folders = !q.galleryId && new Set(rows.map((r) => r.g?.id ?? '')).size > 1;
    const used = new Set<string>();
    const unique = (path: string) => {
      let candidate = path;
      const dot = path.lastIndexOf('.');
      const [stem, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
    const items = rows.flatMap(({ p, g }) => {
      const policy = effectiveDownloadPolicy(ev, g, p);
      if (policy === 'disabled') return [];
      const full = policy === 'full';
      const key = full ? p.originalKey : p.previewKey;
      if (!key) return [];
      const file = safeZipName(downloadName(p, full ? undefined : p.mediaType === 'video' ? 'mp4' : 'jpg'));
      return [{ id: p.id, key, name: unique(folders ? `${safeZipName(g?.name ?? 'Photos')}/${file}` : file), date: p.takenAt ?? p.createdAt }];
    });
    if (items.length === 0) throw forbidden('Nothing in this gallery can be downloaded');

    await trackDownloads(ctx, req, ev.id, items.map((i) => i.id));
    const gallery = q.galleryId ? rows[0]?.g?.name : null;
    const zipName = `${safeZipName(gallery ? `${ev.name} - ${gallery}` : ev.name)}.zip`;
    const entries: ZipEntry[] = items.map((i) => ({ name: i.name, date: i.date, open: () => ctx.storage.stream(i.key) }));
    const stream = zipStream(entries);
    // A failure mid-archive cannot become an error response any more; cut the connection so the
    // browser reports an incomplete download instead of saving a truncated file as if complete.
    stream.on('error', (err) => {
      req.log.error({ err, eventId: ev.id }, 'gallery zip failed');
      reply.raw.destroy(err);
    });
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${zipName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(zipName)}`)
      .header('cache-control', 'no-store');
    return reply.send(stream);
  });

  app.post('/public/photos/:id/view', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { photo, event } = await resolvePublicPhoto(ctx, req, (req.params as { id: string }).id);
    await track(ctx, req, { eventId: event.id, photoId: photo.id, type: 'photo_view' });
    reply.code(204);
  });
};

