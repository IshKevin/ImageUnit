import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { q as col } from '../lib/sql.js';
import { analyticsEvents, events, galleries, photos, users, type Event } from '../db/schema.js';
import { loadManagedEvent, makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { assertTransition } from '../lib/lifecycle.js';
import { photoKeys } from '../lib/media.js';
import { getSettings } from '../lib/settings.js';
import { seesAllEvents } from '../lib/permissions.js';
import { slugify } from '../lib/slug.js';
import { eventDto } from './event-dto.js';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const futureDate = z.coerce.date().refine((d) => d.getTime() > Date.now(), 'Must be in the future');

const eventFields = {
  name: z.string().trim().min(2).max(160),
  description: z.string().max(5000),
  eventDate: dateOnly.nullable(),
  location: z.string().trim().max(200).nullable(),
  visibility: z.enum(['public', 'unlisted', 'private']),
  downloadPolicy: z.enum(['disabled', 'preview', 'full']),
  password: z.string().min(6).max(100).nullable(),
};

const ACCESS_FIELDS = ['visibility', 'downloadPolicy', 'expiresAt', 'accessPasswordHash'] as const;

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const dto = (e: Event, extra?: Record<string, unknown>) => eventDto(e, ctx.config.PUBLIC_WEB_URL, extra);

  async function uniqueSlug(name: string) {
    const base = slugify(name);
    for (let i = 0; i < 6; i++) {
      const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const [hit] = await ctx.db.select({ id: events.id }).from(events).where(eq(events.slug, candidate));
      if (!hit) return candidate;
    }
    throw conflict('Could not allocate a unique link for this event');
  }

  async function setStatus(req: Parameters<typeof loadManagedEvent>[1], ev: Event, to: Event['status'], action: string, patch: Partial<Event> = {}) {
    assertTransition(ev.status, to);
    return ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(events).set({ status: to, ...patch }).where(eq(events.id, ev.id)).returning();
      await audit(tx, actorFromRequest(req), {
        action,
        entityType: 'event',
        entityId: ev.id,
        eventId: ev.id,
        before: { status: ev.status, expiresAt: ev.expiresAt },
        after: { status: to, expiresAt: row!.expiresAt },
      });
      return row!;
    });
  }

  // ---------- list / create ----------

  app.get('/events', { preHandler: guard.perm('events:view') }, async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        status: z.enum(['draft', 'active', 'expired', 'archived', 'scheduled_for_deletion']).optional(),
        ownerId: z.string().uuid().optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const u = req.user!;
    const { limit, offset, page, pageSize } = pageParams(q);
    const conds: SQL[] = [];
    if (!seesAllEvents(u)) conds.push(eq(events.ownerId, u.id));
    else if (q.ownerId) conds.push(eq(events.ownerId, q.ownerId));
    if (q.status) conds.push(eq(events.status, q.status));
    if (q.q) conds.push(or(ilike(events.name, `%${q.q}%`), ilike(events.location, `%${q.q}%`))!);
    const where = conds.length ? and(...conds) : undefined;

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db
        .select({
          event: events,
          ownerName: users.name,
          photoCount: sql<number>`(select count(*) from ${photos} where ${photos.eventId} = ${col(events.id)})::int`,
          readyCount: sql<number>`(select count(*) from ${photos} where ${photos.eventId} = ${col(events.id)} and ${photos.status} = 'ready')::int`,
          storageBytes: sql<number>`(select coalesce(sum(size_bytes + preview_size_bytes + thumb_size_bytes), 0) from ${photos} where ${photos.eventId} = ${col(events.id)})::float8`,
        })
        .from(events)
        .innerJoin(users, eq(users.id, events.ownerId))
        .where(where)
        .orderBy(desc(events.createdAt))
        .limit(limit)
        .offset(offset),
      ctx.db.select({ total: count() }).from(events).where(where),
    ]);
    return {
      items: rows.map((r) => dto(r.event, { ownerName: r.ownerName, photoCount: r.photoCount, readyCount: r.readyCount, storageBytes: r.storageBytes })),
      total,
      page,
      pageSize,
    };
  });

  app.post('/events', { preHandler: guard.perm('events:create') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: eventFields.name,
        description: eventFields.description.default(''),
        eventDate: eventFields.eventDate.optional(),
        location: eventFields.location.optional(),
        visibility: eventFields.visibility.default('public'),
        downloadPolicy: eventFields.downloadPolicy.default('preview'),
        password: eventFields.password.optional(),
        expiresAt: futureDate.optional(),
        ownerId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const u = req.user!;
    if (body.ownerId && body.ownerId !== u.id && u.role !== 'admin') throw forbidden('Only administrators can create events for other users');
    if (body.visibility === 'private' && !body.password) throw badRequest('Private events require an access password');
    const ownerId = body.ownerId ?? u.id;
    if (ownerId !== u.id) {
      const [owner] = await ctx.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, ownerId));
      if (!owner || owner.status !== 'active') throw badRequest('Owner must be an active user');
    }

    const slug = await uniqueSlug(body.name);
    const created = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({
          ownerId,
          slug,
          name: body.name,
          description: body.description,
          eventDate: body.eventDate ?? null,
          location: body.location ?? null,
          visibility: body.visibility,
          downloadPolicy: body.downloadPolicy,
          accessPasswordHash: body.password ? await hashPassword(body.password) : null,
          expiresAt: body.expiresAt ?? null,
        })
        .returning();
      // Every event starts with a default gallery so uploads always have a home.
      await tx.insert(galleries).values({ eventId: row!.id, name: 'General', sortOrder: 0 });
      await audit(tx, actorFromRequest(req), { action: 'event.created', entityType: 'event', entityId: row!.id, eventId: row!.id, after: dto(row!) });
      return row!;
    });
    reply.code(201);
    return { event: dto(created) };
  });

  // ---------- read / update ----------

  app.get('/events/:id', { preHandler: guard.perm('events:view') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    return { event: dto(ev) };
  });

  app.patch('/events/:id', { preHandler: guard.perm('events:edit') }, async (req) => {
    const body = parse(
      z
        .object({
          name: eventFields.name,
          description: eventFields.description,
          eventDate: eventFields.eventDate,
          location: eventFields.location,
          visibility: eventFields.visibility,
          downloadPolicy: eventFields.downloadPolicy,
          password: eventFields.password,
          expiresAt: z.coerce.date().nullable(),
          coverPhotoId: z.string().uuid().nullable(),
          slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(3).max(80),
          ownerId: z.string().uuid(),
        })
        .partial(),
      req.body,
    );
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const isAdmin = req.user!.role === 'admin';
    // Someone curating another person's event (an editor) may fix names and descriptions, but access rules
    // (visibility, downloads, password, expiry) stay with owners, publishers and administrators.
    const touchesAccess = ['visibility', 'downloadPolicy', 'password', 'expiresAt'].some((k) => k in body);
    if (touchesAccess && !isAdmin && ev.ownerId !== req.user!.id && !req.perms!.has('events:publish')) {
      throw forbidden('You can edit names and descriptions, but not access settings, of events you do not own');
    }

    if (['archived', 'scheduled_for_deletion'].includes(ev.status) && !isAdmin) throw forbidden('Archived events are read-only');
    // Photographers may schedule expiry while drafting; extending a live event is an administrator decision.
    if (body.expiresAt !== undefined && !isAdmin && ev.status !== 'draft') throw forbidden('Only administrators can change access expiry after publishing');
    if (body.ownerId !== undefined && !isAdmin) throw forbidden('Only administrators can transfer events');
    if (body.slug !== undefined && ev.status !== 'draft' && !isAdmin) throw forbidden('The link cannot change after publishing');
    if (body.expiresAt && body.expiresAt.getTime() <= Date.now() && ev.status === 'draft') throw badRequest('Expiry must be in the future');

    if (body.coverPhotoId) {
      const [p] = await ctx.db.select({ id: photos.id }).from(photos).where(and(eq(photos.id, body.coverPhotoId), eq(photos.eventId, ev.id), eq(photos.status, 'ready')));
      if (!p) throw badRequest('Cover photo must be a ready photo of this event');
    }
    if (body.slug && body.slug !== ev.slug) {
      const [hit] = await ctx.db.select({ id: events.id }).from(events).where(eq(events.slug, body.slug));
      if (hit) throw conflict('That link is already taken');
    }
    if (body.ownerId) {
      const [owner] = await ctx.db.select({ status: users.status }).from(users).where(eq(users.id, body.ownerId));
      if (owner?.status !== 'active') throw badRequest('Owner must be an active user');
    }

    const { password, ...plain } = body;
    const patch: Partial<Event> = { ...plain };
    if (password !== undefined) patch.accessPasswordHash = password ? await hashPassword(password) : null;
    const nextVisibility = body.visibility ?? ev.visibility;
    const nextHasPassword = password !== undefined ? !!password : !!ev.accessPasswordHash;
    if (nextVisibility === 'private' && !nextHasPassword) throw badRequest('Private events require an access password');

    const accessChanged = ACCESS_FIELDS.some((f) => f in patch && JSON.stringify(patch[f]) !== JSON.stringify(ev[f]));
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(events).set(patch).where(eq(events.id, ev.id)).returning();
      await audit(tx, actorFromRequest(req), {
        action: accessChanged ? 'event.access_settings_changed' : 'event.updated',
        entityType: 'event',
        entityId: ev.id,
        eventId: ev.id,
        before: dto(ev),
        after: dto(row!),
      });
      return row!;
    });
    return { event: dto(updated) };
  });

  // ---------- lifecycle ----------

  app.post('/events/:id/publish', { preHandler: guard.perm('events:publish') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    assertTransition(ev.status, 'active');
    const [{ n } = { n: 0 }] = await ctx.db.select({ n: count() }).from(photos).where(and(eq(photos.eventId, ev.id), eq(photos.status, 'ready'), eq(photos.isHidden, false)));
    if (n === 0) throw conflict('Upload and process at least one photograph before publishing');
    const { defaultAccessDays } = await getSettings(ctx.db);
    const expiresAt = ev.expiresAt && ev.expiresAt.getTime() > Date.now() ? ev.expiresAt : new Date(Date.now() + defaultAccessDays * 864e5);
    const row = await setStatus(req, ev, 'active', 'event.published', { publishedAt: ev.publishedAt ?? new Date(), expiresAt });
    return { event: dto(row) };
  });

  app.post('/events/:id/unpublish', { preHandler: guard.perm('events:publish') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    return { event: dto(await setStatus(req, ev, 'draft', 'event.unpublished')) };
  });

  const adminOnly = guard.perm('events:delete'); // admin-only permission; covers archive/extend/reactivate/delete

  app.post('/events/:id/extend', { preHandler: adminOnly }, async (req) => {
    const { expiresAt } = parse(z.object({ expiresAt: futureDate }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    if (!['active', 'expired'].includes(ev.status)) throw conflict('Only active or expired events can be extended');
    const row = ev.status === 'expired' ? await setStatus(req, ev, 'active', 'event.extended', { expiresAt }) : await ctx.db.transaction(async (tx) => {
      const [r] = await tx.update(events).set({ expiresAt }).where(eq(events.id, ev.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'event.extended', entityType: 'event', entityId: ev.id, eventId: ev.id, before: { expiresAt: ev.expiresAt }, after: { expiresAt } });
      return r!;
    });
    return { event: dto(row) };
  });

  app.post('/events/:id/reactivate', { preHandler: adminOnly }, async (req) => {
    const body = parse(z.object({ expiresAt: futureDate.optional() }), req.body ?? {});
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const { defaultAccessDays } = await getSettings(ctx.db);
    const expiresAt = body.expiresAt ?? new Date(Date.now() + defaultAccessDays * 864e5);
    return { event: dto(await setStatus(req, ev, 'active', 'event.reactivated', { expiresAt, archivedAt: null, retentionReviewAt: null })) };
  });

  app.post('/events/:id/archive', { preHandler: adminOnly }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const { archiveRetentionMonths } = await getSettings(ctx.db);
    const review = new Date();
    review.setMonth(review.getMonth() + archiveRetentionMonths);
    return { event: dto(await setStatus(req, ev, 'archived', 'event.archived', { archivedAt: new Date(), retentionReviewAt: review })) };
  });

  app.delete('/events/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { confirm } = parse(z.object({ confirm: z.string() }), req.query);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    if (!['archived', 'scheduled_for_deletion'].includes(ev.status)) throw conflict('Archive the event before permanently deleting it');
    if (confirm !== ev.slug) throw badRequest('Confirmation does not match the event link');

    const rows = await ctx.db.select().from(photos).where(eq(photos.eventId, ev.id));
    // Write the audit record first: if storage cleanup fails midway, the intent is on record and the delete can be re-run.
    await audit(ctx.db, actorFromRequest(req), {
      action: 'event.deleted',
      entityType: 'event',
      entityId: ev.id,
      eventId: ev.id,
      before: dto(ev),
      meta: { photoCount: rows.length },
    });
    await ctx.storage.delete(rows.flatMap(photoKeys));
    await ctx.db.delete(events).where(eq(events.id, ev.id));
    reply.code(204);
  });

  // ---------- sharing ----------

  app.get('/events/:id/qr', { preHandler: guard.perm('events:view') }, async (req, reply) => {
    const q = parse(z.object({ format: z.enum(['svg', 'png']).default('svg'), size: z.coerce.number().int().min(128).max(2048).default(512), download: z.coerce.boolean().optional() }), req.query);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const url = `${ctx.config.PUBLIC_WEB_URL}/e/${ev.slug}`;
    if (q.download) reply.header('content-disposition', `attachment; filename="${ev.slug}-qr.${q.format}"`);
    if (q.format === 'png') {
      reply.type('image/png');
      return QRCode.toBuffer(url, { width: q.size, margin: 2, errorCorrectionLevel: 'M' });
    }
    reply.type('image/svg+xml');
    return QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  });

  // ---------- per-event statistics ----------

  app.get('/events/:id/stats', { preHandler: guard.perm('stats:view') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const [counts, [media], daily] = await Promise.all([
      ctx.db
        .select({ type: analyticsEvents.type, n: count(), visitors: sql<number>`count(distinct ${analyticsEvents.visitorHash})::int` })
        .from(analyticsEvents)
        .where(eq(analyticsEvents.eventId, ev.id))
        .groupBy(analyticsEvents.type),
      ctx.db
        .select({
          photos: count(),
          ready: sql<number>`count(*) filter (where ${photos.status} = 'ready')::int`,
          failed: sql<number>`count(*) filter (where ${photos.status} = 'failed')::int`,
          bytes: sql<number>`coalesce(sum(size_bytes + preview_size_bytes + thumb_size_bytes), 0)::float8`,
        })
        .from(photos)
        .where(eq(photos.eventId, ev.id)),
      ctx.db.execute(sql`
        select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, type, count(*)::int as n
        from analytics_events where event_id = ${ev.id} and created_at > now() - interval '30 days'
        group by 1, 2 order by 1`),
    ]);
    const by = Object.fromEntries(counts.map((c) => [c.type, c]));
    return {
      views: by.event_view?.n ?? 0,
      uniqueVisitors: by.event_view?.visitors ?? 0,
      photoViews: by.photo_view?.n ?? 0,
      downloads: by.download?.n ?? 0,
      photos: media?.photos ?? 0,
      readyPhotos: media?.ready ?? 0,
      failedPhotos: media?.failed ?? 0,
      storageBytes: media?.bytes ?? 0,
      daily: daily.rows,
    };
  });
};

