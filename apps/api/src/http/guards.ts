import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { events, sessions, users, type Event, type User } from '../db/schema.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { effectivePermissions, type Permission } from '../lib/permissions.js';

export const SESSION_COOKIE = 'iu_session';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated, state-changing requests must originate from our own web app.
 * SameSite=Lax already blocks cross-site cookies; this is defence in depth.
 */
function assertSameOrigin(ctx: AppContext, req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== new URL(ctx.config.PUBLIC_WEB_URL).origin) throw forbidden('Cross-origin request rejected');
}

export async function loadSession(ctx: AppContext, req: FastifyRequest): Promise<User | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await ctx.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)));
  if (!row || row.session.expiresAt < new Date()) return null;
  // Suspension takes effect immediately: a suspended user's live sessions stop working.
  if (row.user.status !== 'active') return null;
  req.sessionId = row.session.id;
  // Sliding expiry: renew once half the lifetime is consumed.
  if (row.session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(sessions.id, row.session.id));
  }
  return row.user;
}

export function makeGuards(ctx: AppContext) {
  const user = async (req: FastifyRequest, _reply: FastifyReply) => {
    assertSameOrigin(ctx, req);
    const u = await loadSession(ctx, req);
    if (!u) throw unauthorized();
    req.user = u;
    req.perms = effectivePermissions(u);
  };

  const perm = (...needed: Permission[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    await user(req, reply);
    for (const p of needed) if (!req.perms!.has(p)) throw forbidden(`Missing permission: ${p}`);
  };

  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    await user(req, reply);
    if (req.user!.role !== 'admin') throw forbidden('Administrator access required');
  };

  return { user, perm, admin };
}

export type Guards = ReturnType<typeof makeGuards>;

/**
 * Loads an event the caller may manage. Photographers only ever see their own;
 * anything else is reported as 404 so event existence is not leaked.
 */
export async function loadManagedEvent(ctx: AppContext, req: FastifyRequest, eventId: string): Promise<Event> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw notFound('Event not found');
  const [ev] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw notFound('Event not found');
  const u = req.user!;
  if (u.role !== 'admin' && ev.ownerId !== u.id) throw notFound('Event not found');
  return ev;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
