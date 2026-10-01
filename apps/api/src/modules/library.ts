import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { events, photos } from '../db/schema.js';
import { makeGuards } from '../http/guards.js';
import { pageParams, parse } from '../http/validate.js';
import { actorFromRequest, audit } from '../lib/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { filterSchema, libraryConds, orderFor, resolveSelection, selectionSchema, sortSchema } from '../lib/library.js';
import { createItemView } from '../lib/library-view.js';
import { normalizeTags } from '../lib/media.js';
import { textArray, uuidSet } from '../lib/sql.js';

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  const itemView = createItemView(ctx);

  app.get('/library/media', { preHandler: guard.perm('events:view') }, async (req) => {
    const q = parse(filterSchema.extend({ sort: sortSchema, page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }), req.query);
    const { limit, offset, page, pageSize } = pageParams({ page: q.page, pageSize: q.pageSize ?? 60 });
    const where = and(...libraryConds(req.user!, q));
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      ctx.db.select({ p: photos, e: events }).from(photos).innerJoin(events, eq(events.id, photos.eventId)).where(where).orderBy(...orderFor(q.sort)).limit(limit).offset(offset),
      ctx.db.select({ total: count() }).from(photos).innerJoin(events, eq(events.id, photos.eventId)).where(where),
    ]);
    return { items: await Promise.all(rows.map(({ p, e }) => itemView(p, e))), total, page, pageSize };
  });

  /** Tag suggestions / facets, restricted to media the caller can see. */
  app.get('/library/tags', { preHandler: guard.perm('events:view') }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(40).optional() }), req.query);
    const conds = libraryConds(req.user!, {});
    const rows = await ctx.db.execute<{ tag: string; n: number }>(sql`
      select t.tag, count(*)::int as n
      from ${photos} inner join ${events} on ${events.id} = ${photos.eventId}
      cross join lateral unnest(${photos.tags}) as t(tag)
      where ${conds.length ? and(...conds) : sql`true`} ${q ? sql`and t.tag like ${q.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'}` : sql``}
      group by t.tag order by n desc, t.tag asc limit 40`);
    return { items: rows.rows };
  });

  /**
   * Bulk edits over a selection: pick items by id, or "everything matching this search".
   * Tags, descriptions and renames need media:edit; hiding needs galleries:manage.
   */
  app.post('/library/bulk', { preHandler: guard.user }, async (req) => {
    const body = parse(
      z.object({
        selection: selectionSchema,
        addTags: z.array(z.string().max(200)).max(30).optional(),
        removeTags: z.array(z.string().max(200)).max(30).optional(),
        description: z.string().max(5000).optional(),
        isHidden: z.boolean().optional(),
        /** Tokens: {event} {n} {filename} {date} {type}. Numbers follow event date, then shooting time. */
        rename: z.object({ template: z.string().trim().min(1).max(200), start: z.number().int().min(0).max(1_000_000).default(1), pad: z.number().int().min(1).max(6).default(3) }).optional(),
      }),
      req.body,
    );
    const metaEdit = !!(body.addTags?.length || body.removeTags?.length || body.description !== undefined || body.rename);
    if (metaEdit && !req.perms!.has('media:edit')) throw forbidden('Missing permission: media:edit');
    if (body.isHidden !== undefined && !req.perms!.has('galleries:manage')) throw forbidden('Missing permission: galleries:manage');
    if (!metaEdit && body.isHidden === undefined) throw badRequest('Nothing to change');

    const ids = await resolveSelection(ctx, req.user!, body.selection);
    if (ids.length === 0) return { updated: 0 };

    await ctx.db.transaction(async (tx) => {
      const inSet = sql`in ${uuidSet(ids)}`;
      if (body.addTags?.length) {
        const add = normalizeTags(body.addTags);
        await tx.execute(sql`update photos set tags = (select coalesce(array_agg(t), '{}') from (select distinct t from unnest(tags || ${textArray(add)}) as t order by t limit 30) x), updated_at = now() where id ${inSet}`);
      }
      if (body.removeTags?.length) {
        const rem = normalizeTags(body.removeTags);
        await tx.execute(sql`update photos set tags = array(select t from unnest(tags) as t where t <> all(${textArray(rem)})), updated_at = now() where id ${inSet}`);
      }
      if (body.description !== undefined) await tx.execute(sql`update photos set description = ${body.description}, updated_at = now() where id ${inSet}`);
      if (body.isHidden !== undefined) await tx.execute(sql`update photos set is_hidden = ${body.isHidden}, updated_at = now() where id ${inSet}`);
      if (body.rename) {
        const rows = await tx
          .select({ id: photos.id, filename: photos.filename, mediaType: photos.mediaType, takenAt: photos.takenAt, createdAt: photos.createdAt, event: events.name, eventDate: events.eventDate })
          .from(photos).innerJoin(events, eq(events.id, photos.eventId))
          .where(sql`${photos.id} ${inSet}`)
          .orderBy(sql`${events.eventDate} asc nulls last`, events.name, sql`coalesce(${photos.takenAt}, ${photos.createdAt}) asc`, photos.id);
        const titled = rows.map((r, i) => {
          const date = (r.takenAt ?? r.createdAt).toISOString().slice(0, 10);
          const title = body.rename!.template
            .replaceAll('{event}', r.event)
            .replaceAll('{n}', String(body.rename!.start + i).padStart(body.rename!.pad, '0'))
            .replaceAll('{filename}', r.filename.replace(/\.[^.]+$/, ''))
            .replaceAll('{date}', r.eventDate ?? date)
            .replaceAll('{type}', r.mediaType)
            .slice(0, 200);
          return { id: r.id, title };
        });
        for (let i = 0; i < titled.length; i += 1000) {
          const chunk = titled.slice(i, i + 1000);
          await tx.execute(sql`update photos set title = v.title, updated_at = now() from (values ${sql.join(chunk.map((c) => sql`(${c.id}::uuid, ${c.title})`), sql`, `)}) as v(id, title) where photos.id = v.id`);
        }
      }
      await audit(tx, actorFromRequest(req), {
        action: 'media.bulk_updated',
        entityType: 'photo',
        meta: { count: ids.length, addTags: body.addTags, removeTags: body.removeTags, description: body.description !== undefined, isHidden: body.isHidden, rename: body.rename?.template },
      });
    });
    return { updated: ids.length };
  });
};
