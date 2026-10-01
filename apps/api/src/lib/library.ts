import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { collectionItems, events, photos, type User } from '../db/schema.js';
import { badRequest } from './errors.js';
import { uuidSet } from './sql.js';
import { hasTag, textSearch } from './media-query.js';
import { seesAllEvents } from './permissions.js';

export const MAX_SELECTION = 20_000;

export const filterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['image', 'video']).optional(),
  eventId: z.string().uuid().optional(),
  galleryId: z.string().uuid().optional(),
  tag: z.string().trim().max(60).optional(),
  status: z.enum(['pending_upload', 'uploaded', 'processing', 'ready', 'failed']).optional(),
  hidden: z.enum(['true', 'false']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  collectionId: z.string().uuid().optional(),
  notInCollectionId: z.string().uuid().optional(),
});
export type LibraryFilter = z.infer<typeof filterSchema>;

export const sortSchema = z.enum(['newest', 'oldest', 'name', 'taken']).default('newest');

/** Media a user may work with: everything for admins and editors, only their own events' media for photographers. */
export function libraryConds(user: Pick<User, 'id' | 'role'>, f: LibraryFilter): SQL[] {
  const c: SQL[] = [];
  // Photographers work with their own events and with whatever they uploaded to events they were invited to.
  if (!seesAllEvents(user)) c.push(sql`(${events.ownerId} = ${user.id} or ${photos.uploaderId} = ${user.id})`);
  if (f.eventId) c.push(eq(photos.eventId, f.eventId));
  if (f.galleryId) c.push(eq(photos.galleryId, f.galleryId));
  if (f.type) c.push(eq(photos.mediaType, f.type));
  if (f.status) c.push(eq(photos.status, f.status));
  if (f.hidden) c.push(eq(photos.isHidden, f.hidden === 'true'));
  if (f.tag) c.push(hasTag(f.tag));
  // Date range applies to when it was shot, falling back to when it was uploaded.
  if (f.from) c.push(sql`coalesce(${photos.takenAt}, ${photos.createdAt}) >= ${f.from}::date`);
  if (f.to) c.push(sql`coalesce(${photos.takenAt}, ${photos.createdAt}) < (${f.to}::date + 1)`);
  const text = f.q ? textSearch(f.q, { withEvent: true }) : undefined;
  if (text) c.push(text);
  if (f.collectionId) c.push(sql`exists (select 1 from ${collectionItems} ci where ci.photo_id = ${photos.id} and ci.collection_id = ${f.collectionId})`);
  if (f.notInCollectionId) c.push(sql`not exists (select 1 from ${collectionItems} ci where ci.photo_id = ${photos.id} and ci.collection_id = ${f.notInCollectionId})`);
  return c;
}

export const orderFor = (sort: z.infer<typeof sortSchema>): SQL[] =>
  sort === 'oldest' ? [sql`${photos.createdAt} asc`, sql`${photos.id} asc`]
  : sort === 'name' ? [sql`lower(coalesce(${photos.title}, ${photos.filename})) asc`, sql`${photos.id} asc`]
  : sort === 'taken' ? [sql`coalesce(${photos.takenAt}, ${photos.createdAt}) desc`, sql`${photos.id} asc`]
  : [sql`${photos.createdAt} desc`, sql`${photos.id} asc`];

export const selectionSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ filter: filterSchema, excludeIds: z.array(z.string().uuid()).max(5000).default([]) }),
]);
export type Selection = z.infer<typeof selectionSchema>;

/**
 * Turns "these items" or "everything matching this search (except these)" into concrete ids, always limited to media the
 * caller may access, so a crafted selection can never reach another photographer's media.
 */
export async function resolveSelection(ctx: AppContext, user: Pick<User, 'id' | 'role'>, selection: Selection): Promise<string[]> {
  const base = () => ctx.db.select({ id: photos.id }).from(photos).innerJoin(events, eq(events.id, photos.eventId));
  if ('ids' in selection) {
    const rows = await base().where(and(...libraryConds(user, {}), sql`${photos.id} in ${uuidSet(selection.ids)}`));
    // Keep the order the caller chose (it becomes the curated order of a collection), dropping duplicates and anything inaccessible.
    const allowed = new Set(rows.map((r) => r.id));
    return [...new Set(selection.ids)].filter((id) => allowed.has(id));
  }
  const conds = libraryConds(user, selection.filter);
  if (selection.excludeIds.length) conds.push(sql`${photos.id} not in ${uuidSet(selection.excludeIds)}`);
  // "Everything matching" is added in shooting order (when taken, else when uploaded).
  const rows = await base().where(and(...conds)).orderBy(sql`coalesce(${photos.takenAt}, ${photos.createdAt}) asc`, photos.id).limit(MAX_SELECTION + 1);
  if (rows.length > MAX_SELECTION) throw badRequest(`That selection has more than ${MAX_SELECTION.toLocaleString()} items. Narrow the search and try again.`);
  return rows.map((r) => r.id);
}

