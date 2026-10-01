import { sql, type SQL } from 'drizzle-orm';
import { events, photos } from '../db/schema.js';

/** Must match the expression of the trigram index in the search migration so substring search stays fast. */
export const searchExpr = sql`lower(coalesce(${photos.title}, '') || ' ' || ${photos.filename} || ' ' || coalesce(${photos.description}, ''))`;

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Free-text search: every word must match the title / file name / description (substring), a tag, or - when the
 * query joins events - the event name. Multi-word queries are AND-ed so "marathon finish" narrows the results.
 */
export function textSearch(q: string, opts: { withEvent?: boolean } = {}): SQL | undefined {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return undefined;
  const perWord = words.map((w) => {
    const like = `%${escapeLike(w)}%`;
    const parts = [sql`${searchExpr} like ${like}`, sql`${photos.tags} @> array[${w}]::text[]`];
    if (opts.withEvent) parts.push(sql`lower(${events.name}) like ${like}`);
    return sql`(${sql.join(parts, sql` or `)})`;
  });
  return sql.join(perWord, sql` and `);
}

export const hasTag = (tag: string) => sql`${photos.tags} @> array[${tag.trim().toLowerCase()}]::text[]`;

/** Conditions for media that may be shown publicly: the event is live, public-ish and the item is ready and visible. */
export const publiclyVisibleMedia = (galleriesVisibleColumn: SQL): SQL[] => [
  sql`${events.status} = 'active'`,
  sql`(${events.expiresAt} is null or ${events.expiresAt} > now())`,
  sql`${events.visibility} <> 'private'`,
  sql`${photos.status} = 'ready'`,
  sql`${photos.isHidden} = false`,
  sql`(${photos.galleryId} is null or ${galleriesVisibleColumn})`,
];
