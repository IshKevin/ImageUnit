import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { eventMembers, events, sessions, users, type Event, type User } from '../db/schema.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { effectivePermissions, seesAllEvents, type Permission } from '../lib/permissions.js';

export const SESSION_COOKIE = 'iu_session';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated, state-changing requests must not come from another website (CSRF). SameSite=Lax already stops
 * browsers sending the cookie cross-site; this is defence in depth, controlled by ORIGIN_CHECK:
 *  - host:   the Origin must be the host the browser used to reach us (X-Forwarded-Host from the proxy chain, else Host).
 *            This needs no configuration, so a mis-set PUBLIC_WEB_URL can never lock everyone out.
 *  - strict: the Origin must equal PUBLIC_WEB_URL or a site listed in CORS_ORIGINS.
 *  - off:    no check.
 * Requests without an Origin header (non-browser clients) are not subject to it.
 */
function assertSameOrigin(ctx: AppContext, req: FastifyRequest) {
  const mode = ctx.config.ORIGIN_CHECK;
  if (mode === 'off' || SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw forbidden('Cross-origin request rejected: malformed Origin header');
  }
  const trusted = ctx.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o && o !== '*').map((o) => new URL(o).origin);
  const configured = new URL(ctx.config.PUBLIC_WEB_URL).origin;
  if (origin === configured || trusted.includes(origin)) return;

  if (mode === 'host') {
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim();
    const seen = (forwarded || req.headers.host || '').toLowerCase();
    if (seen && originUrl.host.toLowerCase() === seen) return;
    req.log.warn({ origin, host: seen }, 'cross-origin request rejected: Origin is not the host the request was sent to');
    throw forbidden(`Cross-origin request rejected: this request came from ${origin} but was sent to ${seen || 'an unknown host'}.`);
  }
  req.log.warn({ origin, configured }, 'cross-origin request rejected: Origin does not match PUBLIC_WEB_URL');
  throw forbidden(`Cross-origin request rejected: this request came from ${origin}, but the site is configured as ${configured}. Set PUBLIC_WEB_URL to the address you open in the browser.`);
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
 * Loads an event for the caller, at the level they need:
 *  - 'manage'     owner, editors and administrators (settings, galleries, publishing, inviting);
 *  - 'contribute' additionally photographers invited to the event (view it, upload, edit their own uploads).
 * Anyone else gets 404 so an event's existence is not leaked. The level granted is recorded in req.eventAccess.
 */
export async function loadManagedEvent(ctx: AppContext, req: FastifyRequest, eventId: string, level: 'manage' | 'contribute' = 'manage'): Promise<Event> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw notFound('Event not found');
  const [ev] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw notFound('Event not found');
  const u = req.user!;
  if (seesAllEvents(u) || ev.ownerId === u.id) {
    req.eventAccess = 'manage';
    return ev;
  }
  const [member] = await ctx.db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(eq(eventMembers.eventId, ev.id), eq(eventMembers.userId, u.id)));
  if (!member) throw notFound('Event not found');
  if (level === 'manage') throw forbidden('Only the event owner or an editor can do that');
  req.eventAccess = 'contribute';
  return ev;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
