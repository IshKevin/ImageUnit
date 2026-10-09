import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiClients, apiUsageDaily, events } from '../db/schema.js';
import { isUuid, makeGuards } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { generateApiKey, SCOPES } from '../lib/api-keys.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { clientDto } from './dto.js';

const scopeList = z.array(z.enum(SCOPES)).min(1);
const origins = z.array(z.string().url().transform((u) => new URL(u).origin)).max(20);

export const clientRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);
  // Website registration and API credentials are separate permissions, both administrator-only.
  const preHandler = guard.perm('websites:manage', 'api:manage');

  async function load(id: string) {
    if (!isUuid(id)) throw notFound('Website not found');
    const [c] = await ctx.db.select().from(apiClients).where(eq(apiClients.id, id));
    if (!c) throw notFound('Website not found');
    return c;
  }

  async function validateEventIds(ids: string[] | null | undefined) {
    if (!ids?.length) return;
    const found = await ctx.db.select({ id: events.id }).from(events).where(inArray(events.id, ids));
    if (found.length !== new Set(ids).size) throw badRequest('One or more events do not exist');
  }

  app.get('/admin/websites', { preHandler }, async () => {
    const rows = await ctx.db.select().from(apiClients).orderBy(desc(apiClients.createdAt));
    return { items: rows.map(clientDto) };
  });

  app.post('/admin/websites', { preHandler }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(500).default(''),
        scopes: scopeList.default(['events:read', 'galleries:read', 'images:read', 'collections:read']),
        allowedEventIds: z.array(z.string().uuid()).nullable().default(null),
        allowedOrigins: origins.default([]),
        rateLimitPerMinute: z.number().int().min(10).max(100_000).default(600),
      }),
      req.body,
    );
    await validateEventIds(body.allowedEventIds);
    const { key, keyPrefix, keyHash } = generateApiKey();
    const created = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.insert(apiClients).values({ ...body, keyPrefix, keyHash, createdBy: req.user!.id }).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.created', entityType: 'api_client', entityId: row!.id, after: clientDto(row!) });
      return row!;
    });
    reply.code(201);
    // The secret is shown exactly once; only its hash is stored.
    return { website: clientDto(created), apiKey: key };
  });

  app.get('/admin/websites/:id', { preHandler }, async (req) => ({ website: clientDto(await load((req.params as { id: string }).id)) }));

  app.patch('/admin/websites/:id', { preHandler }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(500),
        scopes: scopeList,
        allowedEventIds: z.array(z.string().uuid()).nullable(),
        allowedOrigins: origins,
        rateLimitPerMinute: z.number().int().min(10).max(100_000),
        status: z.enum(['active', 'disabled']),
      }).partial(),
      req.body,
    );
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') throw conflict('Revoked access cannot be modified; create a new website credential');
    await validateEventIds(body.allowedEventIds);
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(apiClients).set(body).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), {
        action: body.status && body.status !== c.status ? (body.status === 'active' ? 'api_client.enabled' : 'api_client.disabled') : 'api_client.updated',
        entityType: 'api_client',
        entityId: c.id,
        before: clientDto(c),
        after: clientDto(row!),
      });
      return row!;
    });
    return { website: clientDto(updated) };
  });

  app.post('/admin/websites/:id/revoke', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') return { website: clientDto(c) };
    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.update(apiClients).set({ status: 'revoked', revokedAt: new Date() }).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.revoked', entityType: 'api_client', entityId: c.id, before: { status: c.status }, after: { status: 'revoked' } });
      return row!;
    });
    return { website: clientDto(updated) };
  });

  app.post('/admin/websites/:id/rotate-key', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    if (c.status === 'revoked') throw conflict('Revoked access cannot be rotated');
    const { key, keyPrefix, keyHash } = generateApiKey();
    const [row] = await ctx.db.transaction(async (tx) => {
      const rows = await tx.update(apiClients).set({ keyPrefix, keyHash }).where(eq(apiClients.id, c.id)).returning();
      await audit(tx, actorFromRequest(req), { action: 'api_client.key_rotated', entityType: 'api_client', entityId: c.id });
      return rows;
    });
    return { website: clientDto(row!), apiKey: key };
  });

  app.get('/admin/websites/:id/usage', { preHandler }, async (req) => {
    const c = await load((req.params as { id: string }).id);
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const rows = await ctx.db.select().from(apiUsageDaily).where(and(eq(apiUsageDaily.clientId, c.id), gte(apiUsageDaily.day, since))).orderBy(apiUsageDaily.day);
    return { items: rows };
  });
};
