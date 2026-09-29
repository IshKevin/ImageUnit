import { and, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notifications } from '../db/schema.js';

interface NotifyInput {
  /** Omit to notify every administrator. */
  userId?: string | null;
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body?: string;
  /** Prevents duplicate notifications for the same underlying condition. */
  dedupeKey?: string;
}

export async function notify(db: Db, n: NotifyInput) {
  await db
    .insert(notifications)
    .values({
      userId: n.userId ?? null,
      type: n.type,
      severity: n.severity ?? 'info',
      title: n.title,
      body: n.body ?? '',
      dedupeKey: n.dedupeKey,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
}

export async function pruneNotifications(db: Db, olderThanDays = 90) {
  await db.delete(notifications).where(and(lt(notifications.createdAt, new Date(Date.now() - olderThanDays * 864e5)), isNull(notifications.userId)));
}

