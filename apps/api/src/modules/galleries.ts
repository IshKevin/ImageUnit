import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/sql.js';
import { galleries, photos } from '../db/schema.js';
import { isUuid, loadManagedEvent, makeGuards } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  isVisible: z.boolean(),
  downloadPolicy: z.enum(['disabled', 'preview', 'full']).nullable(),
});

export const galleryRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  app.get('/events/:id/galleries', { preHandler: guard.perm('events:view') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const rows = await ctx.db
      .select({
        gallery: galleries,
        photoCount: sql<number>`(select count(*) from ${photos} where ${photos.galleryId} = ${q(galleries.id)})::int`,
        readyCount: sql<number>`(select count(*) from ${photos} where ${photos.galleryId} = ${q(galleries.id)} and ${photos.status} = 'ready')::int`,
      })
      .from(galleries)
      .where(eq(galleries.eventId, ev.id))
      .orderBy(asc(galleries.sortOrder), asc(galleries.createdAt));
    return { items: rows.map((r) => ({ ...r.gallery, photoCount: r.photoCount, readyCount: r.readyCount })) };
  });

  app.post('/events/:id/galleries', { preHandler: guard.perm('galleries:manage') }, async (req, reply) => {
    const body = parse(fields.partial({ description: true, isVisible: true, downloadPolicy: true }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const [{ next } = { next: 0 }] = await ctx.db
      .select({ next: sql<number>`coalesce(max(${galleries.sortOrder}), -1) + 1` })
      .from(galleries)
      .where(eq(galleries.eventId, ev.id));
    const created = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.insert(galleries).values({ ...body, eventId: ev.id, sortOrder: next }).returning();
      await audit(tx, actorFromRequest(req), { action: 'gallery.created', entityType: 'gallery', entityId: row!.id, eventId: ev.id, after: row });
      return row!;
    });
    reply.code(201);
    return { gallery: created };
  });

  async function loadGallery(req: Parameters<typeof loadManagedEvent>[1], id: string) {
    if (!isUuid(id)) throw notFound('Gallery not found');
    const [g] = await ctx.db.select().from(galleries).where(eq(galleries.id, id));
    if (!g) throw notFound('Gallery not found');
    await loadManagedEvent(ctx, req, g.eventId); // enforces ownership
    return g;
  }

  app.patch('/galleries/:gid', { preHandler: guard.perm('galleries:manage') }, async (req) => {
    const body = parse(fields.partial().extend({ sortOrder: z.number().int().min(0).optional() }), req.body);
    const g = await loadGallery(req, (req.params as { gid: string }).gid);
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(galleries).set(body).where(eq(galleries.id, g.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'gallery.updated', entityType: 'gallery', entityId: g.id, eventId: g.eventId, before: g, after: row });
      return row!;
    });
    return { gallery: updated };
  });

  app.post('/events/:id/galleries/reorder', { preHandler: guard.perm('galleries:manage') }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const existing = await ctx.db.select({ id: galleries.id }).from(galleries).where(eq(galleries.eventId, ev.id));
    const known = new Set(existing.map((g) => g.id));
    if (ids.length !== known.size || ids.some((i) => !known.has(i))) throw badRequest('Provide every gallery of this event exactly once');
    await ctx.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(galleries).set({ sortOrder: i }).where(and(eq(galleries.id, id), eq(galleries.eventId, ev.id)));
    });
    return { ok: true };
  });

  app.delete('/galleries/:gid', { preHandler: guard.perm('galleries:manage') }, async (req, reply) => {
    const g = await loadGallery(req, (req.params as { gid: string }).gid);
    const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(galleries).where(eq(galleries.eventId, g.eventId));
    if (n <= 1) throw conflict('An event needs at least one gallery');
    // Photographs are never destroyed by removing a gallery: they simply become ungrouped.
    await ctx.db.transaction(async (tx) => {
      await tx.delete(galleries).where(eq(galleries.id, g.id));
      await audit(tx, actorFromRequest(req), { action: 'gallery.deleted', entityType: 'gallery', entityId: g.id, eventId: g.eventId, before: g });
    });
    reply.code(204);
  });
};

