import { and, asc, eq, ilike, notExists, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eventMembers, users } from '../db/schema.js';
import { isUuid, loadManagedEvent, makeGuards } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { seesAllEvents } from '../lib/permissions.js';

/**
 * Inviting photographers to contribute to an event. Typical flow: an editor creates the event, invites the
 * photographers who will cover it, and they upload photos and videos into it.
 */
export const memberRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const preHandler = guard.perm('events:edit');

  const requireInviter = (req: { user?: { role: 'admin' | 'editor' | 'photographer' } }) => {
    if (!req.user || !seesAllEvents(req.user)) throw forbidden('Only editors and administrators can invite photographers');
  };

  app.get('/events/:id/members', { preHandler: guard.perm('events:view') }, async (req) => {
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const rows = await ctx.db
      .select({ userId: users.id, name: users.name, email: users.email, status: users.status, invitedAt: eventMembers.createdAt })
      .from(eventMembers)
      .innerJoin(users, eq(users.id, eventMembers.userId))
      .where(eq(eventMembers.eventId, ev.id))
      .orderBy(asc(users.name));
    const [owner] = await ctx.db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.id, ev.ownerId));
    return { owner, items: rows };
  });

  /** Photographers who can still be invited (active, not the owner, not already invited). */
  app.get('/events/:id/member-candidates', { preHandler }, async (req) => {
    requireInviter(req);
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.role, 'photographer'),
          eq(users.status, 'active'),
          sql`${users.id} <> ${ev.ownerId}`,
          notExists(ctx.db.select({ one: sql`1` }).from(eventMembers).where(and(eq(eventMembers.eventId, ev.id), eq(eventMembers.userId, users.id)))),
          like ? or(ilike(users.name, like), ilike(users.email, like)) : undefined,
        ),
      )
      .orderBy(asc(users.name))
      .limit(20);
    return { items: rows };
  });

  app.post('/events/:id/members', { preHandler }, async (req, reply) => {
    requireInviter(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    const ev = await loadManagedEvent(ctx, req, (req.params as { id: string }).id);
    if (['archived', 'scheduled_for_deletion'].includes(ev.status)) throw conflict('Archived events cannot take new contributors');
    const [target] = await ctx.db.select().from(users).where(eq(users.id, userId));
    if (!target) throw notFound('User not found');
    if (target.role !== 'photographer') throw badRequest('Only photographers can be invited to contribute');
    if (target.status !== 'active') throw badRequest('That account is not active');
    if (target.id === ev.ownerId) throw badRequest('That person already owns this event');

    const inserted = await ctx.db.transaction(async (tx) => {
      const rows = await tx.insert(eventMembers).values({ eventId: ev.id, userId, invitedBy: req.user!.id }).onConflictDoNothing().returning();
      if (rows.length) {
        await audit(tx, actorFromRequest(req), { action: 'event.member_added', entityType: 'event', entityId: ev.id, eventId: ev.id, targetUserId: userId, after: { email: target.email } });
      }
      return rows.length > 0;
    });
    if (inserted) {
      await notify(ctx.db, {
        userId,
        type: 'event.invited',
        title: `You were invited to “${ev.name}”`,
        body: `${req.user!.name} added you as a photographer. Open the event to upload photos and videos.`,
        dedupeKey: `invited:${ev.id}:${userId}:${Math.floor(Date.now() / 60_000)}`,
      });
    }
    reply.code(inserted ? 201 : 200);
    return { added: inserted, member: { userId: target.id, name: target.name, email: target.email } };
  });

  app.delete('/events/:id/members/:userId', { preHandler }, async (req, reply) => {
    requireInviter(req);
    const { id, userId } = req.params as { id: string; userId: string };
    if (!isUuid(userId)) throw notFound('Member not found');
    const ev = await loadManagedEvent(ctx, req, id);
    await ctx.db.transaction(async (tx) => {
      const removed = await tx.delete(eventMembers).where(and(eq(eventMembers.eventId, ev.id), eq(eventMembers.userId, userId))).returning();
      if (!removed.length) throw notFound('Member not found');
      // Their uploads stay with the event; only their access ends.
      await audit(tx, actorFromRequest(req), { action: 'event.member_removed', entityType: 'event', entityId: ev.id, eventId: ev.id, targetUserId: userId });
    });
    reply.code(204);
  });
};
