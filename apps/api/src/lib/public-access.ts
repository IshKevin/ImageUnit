import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { events, galleries, photos, type Event, type Gallery, type Photo } from '../db/schema.js';
import { isUuid } from '../http/guards.js';
import { isPubliclyAvailable } from './access.js';
import { signToken, verifyToken, visitorHash } from './crypto.js';
import { AppError, gone, notFound } from './errors.js';
import { analyticsEvents } from '../db/schema.js';

const grantCookie = (e: Pick<Event, 'id'>) => `iu_g_${e.id.slice(0, 8)}`;
const GRANT_TTL_SECONDS = 12 * 3600;

export function issueGrant(ctx: AppContext, reply: FastifyReply, event: Event) {
  reply.setCookie(grantCookie(event), signToken(ctx.config.SESSION_SECRET, { eventId: event.id, pv: event.accessPasswordHash?.slice(-12) }, GRANT_TTL_SECONDS), {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.COOKIE_SECURE,
    path: '/',
    maxAge: GRANT_TTL_SECONDS,
  });
}

function hasGrant(ctx: AppContext, req: FastifyRequest, event: Event) {
  const token = req.cookies[grantCookie(event)];
  if (!token) return false;
  const data = verifyToken<{ eventId: string; pv?: string }>(ctx.config.SESSION_SECRET, token);
  // Changing the password invalidates earlier grants via the `pv` marker.
  return !!data && data.eventId === event.id && data.pv === event.accessPasswordHash?.slice(-12);
}

/**
 * Resolves an event for public viewing, enforcing lifecycle, expiry and private-event access.
 * Drafts and unknown slugs are indistinguishable (404).
 */
export async function resolvePublicEvent(ctx: AppContext, req: FastifyRequest, slug: string, opts: { requireGrant?: boolean } = {}): Promise<Event> {
  const [ev] = await ctx.db.select().from(events).where(eq(events.slug, slug.toLowerCase()));
  return assertPublicEvent(ctx, req, ev, opts);
}

export function assertPublicEvent(ctx: AppContext, req: FastifyRequest, ev: Event | undefined, opts: { requireGrant?: boolean } = {}): Event {
  if (!ev || ev.status === 'draft' || ev.status === 'archived' || ev.status === 'scheduled_for_deletion') throw notFound('Gallery not found');
  if (!isPubliclyAvailable(ev)) throw gone('This gallery is no longer available');
  if (ev.visibility === 'private' && (opts.requireGrant ?? true) && !hasGrant(ctx, req, ev)) {
    throw new AppError(401, 'password_required', 'This gallery is protected by a password', { name: ev.name });
  }
  return ev;
}

export async function resolvePublicPhoto(ctx: AppContext, req: FastifyRequest, photoId: string) {
  if (!isUuid(photoId)) throw notFound('Photograph not found');
  const [row] = await ctx.db
    .select({ photo: photos, event: events, gallery: galleries })
    .from(photos)
    .innerJoin(events, eq(events.id, photos.eventId))
    .leftJoin(galleries, eq(galleries.id, photos.galleryId))
    .where(and(eq(photos.id, photoId), eq(photos.status, 'ready'), eq(photos.isHidden, false)));
  if (!row) throw notFound('Photograph not found');
  if (row.gallery && !row.gallery.isVisible) throw notFound('Photograph not found');
  assertPublicEvent(ctx, req, row.event);
  return row as { photo: Photo; event: Event; gallery: Gallery | null };
}

export async function track(ctx: AppContext, req: FastifyRequest, input: { eventId: string; photoId?: string; type: 'event_view' | 'photo_view' | 'download'; source?: 'web' | 'api' }) {
  try {
    await ctx.db.insert(analyticsEvents).values({
      eventId: input.eventId,
      photoId: input.photoId,
      type: input.type,
      source: input.source ?? 'web',
      visitorHash: visitorHash(ctx.config.SESSION_SECRET, req.ip, req.headers['user-agent'] ?? ''),
    });
  } catch (err) {
    // Analytics must never break media delivery.
    ctx.log.warn({ err }, 'analytics insert failed');
  }
}
