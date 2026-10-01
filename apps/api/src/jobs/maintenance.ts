import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { events, notifications, photos, sessions, users } from '../db/schema.js';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';
import { enqueuePhoto } from '../lib/jobs.js';
import { notify, pruneNotifications } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { publicStorageProblem } from '../lib/storage-config.js';
import { markFailed } from './process-photo.js';

const MAX_AUTO_RECOVERIES = 6;

/** active → expired once the access period ends. Public access is also checked at read time, so this only keeps status honest. */
export async function expireEvents(ctx: AppContext) {
  const rows = await ctx.db
    .update(events)
    .set({ status: 'expired' })
    .where(and(eq(events.status, 'active'), isNotNull(events.expiresAt), lte(events.expiresAt, new Date())))
    .returning();
  for (const ev of rows) {
    await audit(ctx.db, SYSTEM_ACTOR, { action: 'event.expired', entityType: 'event', entityId: ev.id, eventId: ev.id, before: { status: 'active' }, after: { status: 'expired' } });
    await notify(ctx.db, { userId: ev.ownerId, type: 'event.expired', title: `“${ev.name}” has expired`, body: 'Public access has ended. Photographs are retained; contact an administrator to extend access.', dedupeKey: `expired:${ev.id}:${ev.expiresAt?.getTime()}` });
  }
  return rows.length;
}

export async function warnExpiringEvents(ctx: AppContext) {
  const { expiryWarningDays } = await getSettings(ctx.db);
  const horizon = new Date(Date.now() + expiryWarningDays * 864e5);
  const rows = await ctx.db.select().from(events).where(and(eq(events.status, 'active'), isNotNull(events.expiresAt), lte(events.expiresAt, horizon)));
  for (const ev of rows) {
    await notify(ctx.db, { userId: ev.ownerId, type: 'event.expiring', severity: 'warning', title: `“${ev.name}” expires soon`, body: `Public access ends on ${ev.expiresAt?.toISOString().slice(0, 10)}.`, dedupeKey: `expiring:${ev.id}:${ev.expiresAt?.getTime()}` });
  }
  return rows.length;
}

/** Archived events past their retention period are flagged for an administrator to review. Nothing is deleted automatically. */
export async function flagRetentionReviews(ctx: AppContext) {
  const rows = await ctx.db
    .update(events)
    .set({ status: 'scheduled_for_deletion' })
    .where(and(eq(events.status, 'archived'), isNotNull(events.retentionReviewAt), lte(events.retentionReviewAt, new Date())))
    .returning();
  for (const ev of rows) {
    await audit(ctx.db, SYSTEM_ACTOR, { action: 'event.scheduled_for_deletion', entityType: 'event', entityId: ev.id, eventId: ev.id, before: { status: 'archived' }, after: { status: 'scheduled_for_deletion' } });
    await notify(ctx.db, { type: 'retention.review', severity: 'warning', title: `“${ev.name}” is due for deletion review`, body: 'The archive retention period has ended. Review and permanently delete, or reactivate.', dedupeKey: `retention:${ev.id}` });
  }
  return rows.length;
}

export async function checkStorage(ctx: AppContext) {
  const addressProblem = publicStorageProblem(ctx.config);
  if (addressProblem) {
    await notify(ctx.db, { type: 'storage.misconfigured', severity: 'critical', title: 'Photo and video uploads cannot work', body: addressProblem, dedupeKey: `storage-address:${new Date().toISOString().slice(0, 10)}` });
  }
  const { storageAlertPercent, quotaAlertPercent } = await getSettings(ctx.db);
  const day = new Date().toISOString().slice(0, 10);
  const [total] = await ctx.db.select({ bytes: sql<number>`coalesce(sum(size_bytes + preview_size_bytes + thumb_size_bytes), 0)::float8` }).from(photos);
  const pct = ((total?.bytes ?? 0) / ctx.config.STORAGE_TOTAL_BYTES) * 100;
  if (pct >= storageAlertPercent) {
    await notify(ctx.db, { type: 'storage.threshold', severity: pct >= 95 ? 'critical' : 'warning', title: `Storage is ${pct.toFixed(0)}% full`, body: 'Review archived events or add capacity.', dedupeKey: `storage:${day}` });
  }
  const perUser = await ctx.db.execute<{ id: string; name: string; quota: number; used: number }>(sql`
    select u.id, u.name, u.storage_quota_bytes::float8 as quota,
           coalesce(sum(p.size_bytes + p.preview_size_bytes + p.thumb_size_bytes), 0)::float8 as used
    from users u join events e on e.owner_id = u.id join photos p on p.event_id = e.id
    where u.storage_quota_bytes is not null group by u.id`);
  for (const r of perUser.rows) {
    if ((r.used / r.quota) * 100 >= quotaAlertPercent) {
      await notify(ctx.db, { userId: r.id, type: 'storage.quota', severity: 'warning', title: 'You are close to your storage limit', body: `You have used ${Math.round((r.used / r.quota) * 100)}% of your allowance.`, dedupeKey: `quota:${r.id}:${day}` });
    }
  }
}

/** Recovers photos whose job was lost (worker crash, Redis flush) and closes out uploads that never completed. */
export async function recoverStuckPhotos(ctx: AppContext) {
  const stuck = await ctx.db
    .select({ id: photos.id, attempts: photos.attempts })
    .from(photos)
    .where(and(inArray(photos.status, ['uploaded', 'processing']), sql`${photos.updatedAt} < now() - (case when ${photos.mediaType} = 'video' then interval '3 hours' else interval '15 minutes' end)`))
    .limit(200);
  for (const p of stuck) {
    if (p.attempts >= MAX_AUTO_RECOVERIES) await markFailed(ctx, p.id, 'Processing did not complete; retry manually');
    else await enqueuePhoto(ctx, p.id);
  }
  const abandoned = await ctx.db
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.status, 'pending_upload'), sql`${photos.createdAt} < now() - interval '24 hours'`))
    .limit(500);
  for (const p of abandoned) await markFailed(ctx, p.id, 'Upload never completed; upload the file again');
  return { requeued: stuck.length, abandoned: abandoned.length };
}

export async function housekeeping(ctx: AppContext) {
  await ctx.db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  await pruneNotifications(ctx.db);
  // Read notifications older than 30 days add no value.
  await ctx.db.delete(notifications).where(and(isNotNull(notifications.readAt), lte(notifications.readAt, new Date(Date.now() - 30 * 864e5))));
  // Unlock accounts whose lock window has passed.
  await ctx.db.update(users).set({ lockedUntil: null, failedLogins: 0 }).where(and(isNotNull(users.lockedUntil), lte(users.lockedUntil, new Date())));
}

export async function runMaintenance(ctx: AppContext) {
  const steps: [string, () => Promise<unknown>][] = [
    ['expireEvents', () => expireEvents(ctx)],
    ['warnExpiringEvents', () => warnExpiringEvents(ctx)],
    ['flagRetentionReviews', () => flagRetentionReviews(ctx)],
    ['recoverStuckPhotos', () => recoverStuckPhotos(ctx)],
    ['checkStorage', () => checkStorage(ctx)],
    ['housekeeping', () => housekeeping(ctx)],
  ];
  // One failing step must not starve the others.
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      ctx.log.error({ err, step: name }, 'maintenance step failed');
    }
  }
}
