import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { photos } from '../db/schema.js';
import { photoJobId } from './queue.js';

export interface ProcessPhotoJob {
  photoId: string;
}

/** Marks a photo as queued and adds the job. Safe to call again for retries. */
export async function enqueuePhoto(ctx: AppContext, photoId: string) {
  const [row] = await ctx.db
    .update(photos)
    .set({ status: 'uploaded', error: null, attempts: sql`${photos.attempts} + 1` })
    .where(eq(photos.id, photoId))
    .returning({ attempts: photos.attempts, mediaType: photos.mediaType });
  if (!row) return;
  const queue = row.mediaType === 'video' ? ctx.queues.videos : ctx.queues.photos;
  await queue.add('process', { photoId } satisfies ProcessPhotoJob, { jobId: photoJobId(photoId, row.attempts) });
}
