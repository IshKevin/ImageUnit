import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { QUEUES } from '../context.js';
import { analyticsEvents, apiClients, apiUsageDaily, auditLogs, events, notifications, photos, users } from '../db/schema.js';
import { makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { getSettings, platformSettingsSchema, saveSettings } from '../lib/settings.js';

const BYTES = sql<number>`coalesce(sum(${photos.sizeBytes} + ${photos.previewSizeBytes} + ${photos.thumbSizeBytes}), 0)::float8`;

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  // ---------- platform statistics ----------

  app.get('/admin/stats', { preHandler: guard.admin }, async () => {
    const [[u], evRows, [ph], [an], [visitors]] = await Promise.all([
      ctx.db.select({ total: count(), photographers: sql<number>`count(*) filter (where role = 'photographer')::int`, active: sql<number>`count(*) filter (where status = 'active')::int` }).from(users),
      ctx.db.select({ status: events.status, n: count() }).from(events).groupBy(events.status),
      ctx.db.select({ n: count(), bytes: BYTES, failed: sql<number>`count(*) filter (where status = 'failed')::int`, processing: sql<number>`count(*) filter (where status in ('uploaded','processing'))::int` }).from(photos),
      ctx.db.select({ views: sql<number>`count(*) filter (where type = 'event_view')::int`, photoViews: sql<number>`count(*) filter (where type = 'photo_view')::int`, downloads: sql<number>`count(*) filter (where type = 'download')::int` }).from(analyticsEvents),
      ctx.db.select({ n: sql<number>`count(distinct visitor_hash)::int` }).from(analyticsEvents).where(gte(analyticsEvents.createdAt, new Date(Date.now() - 30 * 864e5))),
    ]);
    const byStatus = Object.fromEntries(evRows.map((r) => [r.status, r.n]));
    return {
      users: u?.total ?? 0,
      activeUsers: u?.active ?? 0,
      photographers: u?.photographers ?? 0,
      events: evRows.reduce((s, r) => s + r.n, 0),
      eventsByStatus: byStatus,
      activeGalleries: byStatus.active ?? 0,
      expiredGalleries: byStatus.expired ?? 0,
      photos: ph?.n ?? 0,
      failedPhotos: ph?.failed ?? 0,
      processingPhotos: ph?.processing ?? 0,
      storageBytes: ph?.bytes ?? 0,
      eventViews: an?.views ?? 0,
      photoViews: an?.photoViews ?? 0,
      downloads: an?.downloads ?? 0,
      visitorsLast30Days: visitors?.n ?? 0,
    };
  });

  app.get('/admin/stats/timeseries', { preHandler: guard.admin }, async () => {
    const r = await ctx.db.execute(sql`
      select to_char(d, 'YYYY-MM-DD') as day,
             coalesce(sum((a.type = 'event_view')::int), 0)::int as views,
             coalesce(sum((a.type = 'download')::int), 0)::int as downloads,
             (select count(*) from photos p where p.created_at::date = d::date)::int as uploads
      from generate_series(current_date - 29, current_date, interval '1 day') d
      left join analytics_events a on a.created_at::date = d::date
      group by d order by d`);
    return { items: r.rows };
  });

  app.get('/admin/storage', { preHandler: guard.admin }, async () => {
    const [[used], byPhotographer, byEvent, byWebsite] = await Promise.all([
      ctx.db.select({ bytes: BYTES }).from(photos),
      ctx.db
        .select({ userId: users.id, name: users.name, email: users.email, quota: users.storageQuotaBytes, bytes: BYTES, photos: count(photos.id) })
        .from(users)
        .leftJoin(events, eq(events.ownerId, users.id))
        .leftJoin(photos, eq(photos.eventId, events.id))
        .where(eq(users.role, 'photographer'))
        .groupBy(users.id)
        .orderBy(desc(BYTES))
        .limit(100),
      ctx.db
        .select({ eventId: events.id, name: events.name, status: events.status, bytes: BYTES, photos: count(photos.id) })
        .from(events)
        .leftJoin(photos, eq(photos.eventId, events.id))
        .groupBy(events.id)
        .orderBy(desc(BYTES))
        .limit(50),
      ctx.db
        .select({ clientId: apiClients.id, name: apiClients.name, requests: sql<number>`coalesce(sum(${apiUsageDaily.requests}), 0)::float8`, bytesServed: sql<number>`coalesce(sum(${apiUsageDaily.bytesServed}), 0)::float8` })
        .from(apiClients)
        .leftJoin(apiUsageDaily, eq(apiUsageDaily.clientId, apiClients.id))
        .groupBy(apiClients.id)
        .orderBy(desc(sql`coalesce(sum(${apiUsageDaily.bytesServed}), 0)`)),
    ]);
    const usedBytes = used?.bytes ?? 0;
    return { totalBytes: ctx.config.STORAGE_TOTAL_BYTES, usedBytes, availableBytes: Math.max(ctx.config.STORAGE_TOTAL_BYTES - usedBytes, 0), byPhotographer, byEvent, byWebsite };
  });

  // ---------- audit log ----------

  app.get('/admin/audit', { preHandler: guard.perm('audit:view') }, async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(80).optional(),
        actorId: z.string().max(80).optional(),
        eventId: z.string().uuid().optional(),
        entityType: z.string().max(40).optional(),
        q: z.string().max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const { limit, offset, page, pageSize } = pageParams({ ...q, pageSize: q.pageSize ?? 50 });
    const conds: SQL[] = [];
    if (q.action) conds.push(ilike(auditLogs.action, `${q.action.replace(/[%_]/g, '\\$&')}%`));
    if (q.actorId) conds.push(eq(auditLogs.actorId, q.actorId));
    if (q.eventId) conds.push(eq(auditLogs.eventId, q.eventId));
    if (q.entityType) conds.push(eq(auditLogs.entityType, q.entityType));
    if (q.from) conds.push(gte(auditLogs.createdAt, q.from));
    if (q.to) conds.push(lte(auditLogs.createdAt, q.to));
    if (q.q) conds.push(or(ilike(auditLogs.actorLabel, `%${q.q}%`), ilike(auditLogs.action, `%${q.q}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const [items, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(auditLogs).where(where),
    ]);
    return { items, total, page, pageSize };
  });

  // ---------- settings ----------

  app.get('/admin/settings', { preHandler: guard.perm('settings:manage') }, async () => ({ settings: await getSettings(ctx.db) }));

  app.put('/admin/settings', { preHandler: guard.perm('settings:manage') }, async (req) => {
    const next = parse(platformSettingsSchema, req.body);
    const before = await getSettings(ctx.db);
    await ctx.db.transaction(async (tx) => {
      await saveSettings(tx, next);
      await audit(tx, actorFromRequest(req), { action: 'settings.changed', entityType: 'settings', entityId: 'platform', before, after: next });
    });
    return { settings: next };
  });

  // ---------- operational health ----------

  app.get('/admin/health', { preHandler: guard.admin }, async () => {
    const started = Date.now();
    const [dbOk, storageOk, redisOk] = await Promise.all([
      ctx.db.execute(sql`select 1`).then(() => true, () => false),
      ctx.storage.ping(),
      ctx.redis ? ctx.redis.ping().then(() => true, () => false) : Promise.resolve(false),
    ]);
    const [photoQueue, maintenance] = await Promise.all([ctx.queues.photos.getJobCounts(), ctx.queues.maintenance.getJobCounts()]).catch(() => [null, null]);
    const [row] = await ctx.db
      .select({
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
        stuck: sql<number>`count(*) filter (where status in ('uploaded','processing') and updated_at < now() - interval '15 minutes')::int`,
        abandoned: sql<number>`count(*) filter (where status = 'pending_upload' and created_at < now() - interval '24 hours')::int`,
      })
      .from(photos);
    const [lockedUsers] = await ctx.db.select({ n: count() }).from(users).where(sql`locked_until > now()`);
    const failedLogins24h = await ctx.db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, 'auth.account_locked'), gte(auditLogs.createdAt, new Date(Date.now() - 864e5))));
    return {
      status: dbOk && storageOk && redisOk ? 'ok' : 'degraded',
      checks: { database: dbOk, storage: storageOk, redis: redisOk },
      latencyMs: Date.now() - started,
      queues: { [QUEUES.photos]: photoQueue, [QUEUES.maintenance]: maintenance },
      photos: { failed: row?.failed ?? 0, stuck: row?.stuck ?? 0, abandonedUploads: row?.abandoned ?? 0 },
      security: { lockedAccounts: lockedUsers?.n ?? 0, lockoutsLast24h: failedLogins24h[0]?.n ?? 0 },
    };
  });

  // ---------- notifications (photographers and admins) ----------

  const visibleTo = (u: { id: string; role: string }) => (u.role === 'admin' ? or(eq(notifications.userId, u.id), sql`${notifications.userId} is null`)! : eq(notifications.userId, u.id));

  app.get('/notifications', { preHandler: guard.user }, async (req) => {
    const where = visibleTo(req.user!);
    const [items, [unread]] = await Promise.all([
      ctx.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(50),
      ctx.db.select({ n: count() }).from(notifications).where(and(where, sql`${notifications.readAt} is null`)),
    ]);
    return { items, unread: unread?.n ?? 0 };
  });

  // Broadcast (admin-wide) notifications have a single shared read flag; acceptable for a small admin team.
  app.post('/notifications/read', { preHandler: guard.user }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(200).optional() }), req.body ?? {});
    const conds = [visibleTo(req.user!), sql`${notifications.readAt} is null`];
    if (ids?.length) conds.push(sql`${notifications.id} = any(${ids})`);
    await ctx.db.update(notifications).set({ readAt: new Date() }).where(and(...conds));
    return { ok: true };
  });
};
