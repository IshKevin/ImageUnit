import { and, asc, count, eq, ilike, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/sql.js';
import { galleries, photos } from '../db/schema.js';
import { pageParams, parse } from '../http/validate.js';
import { effectiveDownloadPolicy } from '../lib/access.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { issueGrant, resolvePublicEvent, resolvePublicPhoto, track } from '../lib/public-access.js';

// Verified against for events without a password so response timing is uniform.
const DUMMY = await hashPassword('timing-equaliser');

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const mediaPath = (photoId: string, kind: string) => `/api/public/photos/${photoId}/${kind}`;

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
    // Explicit cover if set and still visible, otherwise the first visible photograph.
    const visible = and(eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false));
    const [chosen] = ev.coverPhotoId ? await ctx.db.select({ id: photos.id }).from(photos).where(and(eq(photos.id, ev.coverPhotoId), visible)) : [];
    const [first] = chosen ? [] : await ctx.db.select({ id: photos.id }).from(photos).where(visible).orderBy(asc(photos.sortOrder), asc(photos.takenAt), asc(photos.createdAt)).limit(1);
    const cover = chosen ?? first;
    return {
      event: {
        name: ev.name,
        slug: ev.slug,
        description: ev.description,
        eventDate: ev.eventDate,
        location: ev.location,
        expiresAt: ev.expiresAt,
        downloadPolicy: ev.downloadPolicy,
        coverUrl: cover ? mediaPath(cover.id, 'preview') : null,
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
    if (q.q) conds.push(ilike(photos.filename, `%${q.q.replace(/[%_]/g, '\\$&')}%`));
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
        filename: p.filename,
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
      const ext = useOriginal ? photo.originalKey.split('.').pop() : 'jpg';
      const name = photo.filename.replace(/\.[^.]+$/, '') + `.${ext}`;
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

  app.post('/public/photos/:id/view', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { photo, event } = await resolvePublicPhoto(ctx, req, (req.params as { id: string }).id);
    await track(ctx, req, { eventId: event.id, photoId: photo.id, type: 'photo_view' });
    reply.code(204);
  });
};

