import { count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { analyticsEvents, events, photos } from '../db/schema.js';
import { makeGuards } from '../http/guards.js';

/** Photographer-facing statistics, always scoped to the caller's own events. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  app.get('/stats/me', { preHandler: guard.perm('stats:view') }, async (req) => {
    const uid = req.user!.id;
    const [[ev], [ph], [an]] = await Promise.all([
      ctx.db.select({ n: count() }).from(events).where(sql`(${events.ownerId} = ${uid} or exists (select 1 from event_members m where m.event_id = ${events.id} and m.user_id = ${uid}))`),
      ctx.db
        .select({
          n: count(),
          bytes: sql<number>`coalesce(sum(${photos.sizeBytes} + ${photos.previewSizeBytes} + ${photos.thumbSizeBytes}), 0)::float8`,
          failed: sql<number>`count(*) filter (where ${photos.status} = 'failed')::int`,
          processing: sql<number>`count(*) filter (where ${photos.status} in ('uploaded','processing'))::int`,
        })
        .from(photos)
        .where(eq(photos.uploaderId, uid)),
      ctx.db
        .select({
          views: sql<number>`count(*) filter (where ${analyticsEvents.type} = 'event_view')::int`,
          downloads: sql<number>`count(*) filter (where ${analyticsEvents.type} = 'download')::int`,
        })
        .from(analyticsEvents)
        .innerJoin(events, eq(events.id, analyticsEvents.eventId))
        .where(eq(events.ownerId, uid)),
    ]);
    return {
      events: ev?.n ?? 0,
      photos: ph?.n ?? 0,
      storageBytes: ph?.bytes ?? 0,
      quotaBytes: req.user!.storageQuotaBytes,
      failedPhotos: ph?.failed ?? 0,
      processingPhotos: ph?.processing ?? 0,
      galleryViews: an?.views ?? 0,
      downloads: an?.downloads ?? 0,
    };
  });
};
