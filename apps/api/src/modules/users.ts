import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { auditLogs, events, photos, sessions, users } from '../db/schema.js';
import { isUuid, makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isGrantable, PERMISSIONS } from '../lib/permissions.js';
import { passwordSchema } from './auth.js';
import { userDto } from './dto.js';

const tempPassword = () => `${randomBytes(9).toString('base64url')}aA1`;

const permissionList = z.array(z.string()).max(PERMISSIONS.length);

export const userRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  const preHandler = guard.perm('users:manage');

  async function getUser(id: string) {
    if (!isUuid(id)) throw notFound('User not found');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!u) throw notFound('User not found');
    return u;
  }

  function validatePermissions(role: 'admin' | 'photographer', lists: string[][]) {
    if (role === 'admin') return; // admins always hold everything; lists are irrelevant
    for (const list of lists) {
      for (const p of list) {
        if (!(PERMISSIONS as readonly string[]).includes(p)) throw badRequest(`Unknown permission: ${p}`);
        if (!isGrantable(p)) throw badRequest(`Permission "${p}" is reserved for administrators and cannot be granted`);
      }
    }
  }

  async function assertNotLastAdmin(userId: string) {
    const [{ n } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), sql`${users.id} <> ${userId}`));
    if (n === 0) throw conflict('This is the last active administrator');
  }

  app.get('/admin/users', { preHandler }, async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        role: z.enum(['admin', 'photographer']).optional(),
        status: z.enum(['active', 'suspended', 'inactive']).optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    const { limit, offset, page, pageSize } = pageParams(q);
    const conds: SQL[] = [];
    if (q.q) conds.push(or(ilike(users.email, `%${q.q}%`), ilike(users.name, `%${q.q}%`))!);
    if (q.role) conds.push(eq(users.role, q.role));
    if (q.status) conds.push(eq(users.status, q.status));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(users).where(where),
    ]);
    return { items: rows.map(userDto), total, page, pageSize };
  });

  app.post('/admin/users', { preHandler }, async (req, reply) => {
    const body = parse(
      z.object({
        email: z.string().email().max(200),
        name: z.string().trim().min(1).max(120),
        role: z.enum(['admin', 'photographer']).default('photographer'),
        password: passwordSchema.optional(),
        grantedPermissions: permissionList.default([]),
        revokedPermissions: permissionList.default([]),
        storageQuotaBytes: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    validatePermissions(body.role, [body.grantedPermissions, body.revokedPermissions]);
    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    if (existing) throw conflict('A user with this email already exists');

    const password = body.password ?? tempPassword();
    const [created] = await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .insert(users)
        .values({
          email: body.email.toLowerCase(),
          name: body.name,
          role: body.role,
          passwordHash: await hashPassword(password),
          permissions: body.role === 'admin' ? [] : body.grantedPermissions,
          revokedPermissions: body.role === 'admin' ? [] : body.revokedPermissions,
          storageQuotaBytes: body.storageQuotaBytes ?? null,
        })
        .returning();
      await audit(tx, actorFromRequest(req), { action: 'user.created', entityType: 'user', entityId: rows[0]!.id, targetUserId: rows[0]!.id, after: userDto(rows[0]!) });
      return rows;
    });
    reply.code(201);
    return { user: userDto(created!), temporaryPassword: body.password ? undefined : password };
  });

  app.get('/admin/users/:id', { preHandler }, async (req) => {
    const u = await getUser((req.params as { id: string }).id);
    const [[ev], [ph]] = await Promise.all([
      ctx.db.select({ n: count() }).from(events).where(eq(events.ownerId, u.id)),
      ctx.db
        .select({
          n: count(),
          bytes: sql<number>`coalesce(sum(${photos.sizeBytes} + ${photos.previewSizeBytes} + ${photos.thumbSizeBytes}), 0)::float8`,
        })
        .from(photos)
        .where(eq(photos.uploaderId, u.id)),
    ]);
    return { user: userDto(u), stats: { events: ev?.n ?? 0, photos: ph?.n ?? 0, storageBytes: ph?.bytes ?? 0 } };
  });

  app.patch('/admin/users/:id', { preHandler }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        role: z.enum(['admin', 'photographer']).optional(),
        grantedPermissions: permissionList.optional(),
        revokedPermissions: permissionList.optional(),
        storageQuotaBytes: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    const target = await getUser((req.params as { id: string }).id);
    const role = body.role ?? target.role;
    if (body.role && body.role !== target.role) {
      if (target.id === req.user!.id) throw badRequest('You cannot change your own role');
      if (target.role === 'admin') await assertNotLastAdmin(target.id);
    }
    validatePermissions(role, [body.grantedPermissions ?? [], body.revokedPermissions ?? []]);

    const patch = {
      ...(body.name !== undefined && { name: body.name }),
      role,
      permissions: role === 'admin' ? [] : (body.grantedPermissions ?? target.permissions),
      revokedPermissions: role === 'admin' ? [] : (body.revokedPermissions ?? target.revokedPermissions),
      ...(body.storageQuotaBytes !== undefined && { storageQuotaBytes: body.storageQuotaBytes }),
    };
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(users).set(patch).where(eq(users.id, target.id)).returning();
      const roleChanged = role !== target.role;
      const permsChanged =
        JSON.stringify([patch.permissions, patch.revokedPermissions]) !== JSON.stringify([target.permissions, target.revokedPermissions]);
      await audit(tx, actorFromRequest(req), {
        action: roleChanged ? 'user.role_changed' : permsChanged ? 'user.permissions_changed' : 'user.updated',
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        before: userDto(target),
        after: userDto(row!),
      });
      if (roleChanged) await tx.delete(sessions).where(eq(sessions.userId, target.id));
      return row!;
    });
    return { user: userDto(updated) };
  });

  app.post('/admin/users/:id/status', { preHandler }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'inactive']) }), req.body);
    const target = await getUser((req.params as { id: string }).id);
    if (target.id === req.user!.id && status !== 'active') throw badRequest('You cannot deactivate your own account');
    if (target.role === 'admin' && status !== 'active') await assertNotLastAdmin(target.id);
    if (target.status === status) return { user: userDto(target) };

    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(users).set({ status, failedLogins: 0, lockedUntil: null }).where(eq(users.id, target.id)).returning();
      // Cut off live sessions so suspension is effective immediately.
      if (status !== 'active') await tx.delete(sessions).where(eq(sessions.userId, target.id));
      await audit(tx, actorFromRequest(req), {
        action: status === 'active' ? 'user.activated' : status === 'suspended' ? 'user.suspended' : 'user.deactivated',
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        before: { status: target.status },
        after: { status },
      });
      return row!;
    });
    return { user: userDto(updated) };
  });

  app.post('/admin/users/:id/reset-password', { preHandler }, async (req) => {
    const body = parse(z.object({ password: passwordSchema.optional() }), req.body ?? {});
    const target = await getUser((req.params as { id: string }).id);
    const password = body.password ?? tempPassword();
    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null }).where(eq(users.id, target.id));
      await tx.delete(sessions).where(eq(sessions.userId, target.id));
      await audit(tx, actorFromRequest(req), { action: 'user.password_reset', entityType: 'user', entityId: target.id, targetUserId: target.id });
    });
    return { temporaryPassword: body.password ? undefined : password };
  });

  app.get('/admin/users/:id/activity', { preHandler }, async (req) => {
    const u = await getUser((req.params as { id: string }).id);
    const items = await ctx.db
      .select()
      .from(auditLogs)
      .where(or(eq(auditLogs.actorId, u.id), eq(auditLogs.targetUserId, u.id)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);
    return { items };
  });

  app.get('/admin/users/:id/events', { preHandler }, async (req) => {
    const u = await getUser((req.params as { id: string }).id);
    const items = await ctx.db.select().from(events).where(eq(events.ownerId, u.id)).orderBy(desc(events.createdAt)).limit(200);
    return { items };
  });
};

