import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import exifr from 'exifr';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata } from 'sharp';
import type { AppContext } from '../context.js';
import { events, photos } from '../db/schema.js';
import { ALLOWED_TYPES } from '../lib/media.js';
import { notify } from '../lib/notify.js';

sharp.cache(false);

const PREVIEW_EDGE = 2560;
const THUMB_EDGE = 480;
const MAX_PIXELS = 300_000_000;

/** Thrown for problems retrying cannot fix (corrupt or unsupported file). */
export class PermanentProcessingError extends Error {}

/** Routes a freshly uploaded item to the image or video pipeline. Idempotent. */
export async function processMedia(ctx: AppContext, photoId: string): Promise<'ready' | 'skipped'> {
  const [row] = await ctx.db.select({ type: photos.mediaType }).from(photos).where(eq(photos.id, photoId));
  if (row?.type === 'video') return (await import('./process-video.js')).processVideo(ctx, photoId);
  return processPhoto(ctx, photoId);
}

export async function processPhoto(ctx: AppContext, photoId: string): Promise<'ready' | 'skipped'> {
  const [photo] = await ctx.db.select().from(photos).where(eq(photos.id, photoId));
  // Idempotent: duplicate or late jobs for finished/absent photos are no-ops.
  if (!photo || photo.status === 'ready' || photo.status === 'pending_upload') return 'skipped';

  await ctx.db.update(photos).set({ status: 'processing' }).where(eq(photos.id, photoId));

  let original: Buffer;
  try {
    original = await ctx.storage.get(photo.originalKey);
  } catch {
    throw new PermanentProcessingError('Original file is missing from storage; upload it again');
  }

  // Trust the bytes, not the declared content type or extension.
  const detected = await fileTypeFromBuffer(original);
  if (!detected || !(detected.mime in ALLOWED_TYPES)) throw new PermanentProcessingError('File is not a supported image');

  let meta: Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch (err) {
    throw new PermanentProcessingError(`Image could not be read: ${(err as Error).message}`);
  }
  if (!meta.width || !meta.height) throw new PermanentProcessingError('Image has no dimensions');
  const swap = (meta.orientation ?? 1) >= 5;

  let exif: Record<string, unknown> | null = null;
  let takenAt: Date | null = null;
  try {
    // Deliberately excludes GPS: location data is never stored or republished.
    const parsed = await exifr.parse(original, ['DateTimeOriginal', 'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength']);
    if (parsed) {
      exif = JSON.parse(JSON.stringify(parsed));
      if (parsed.DateTimeOriginal instanceof Date && !Number.isNaN(parsed.DateTimeOriginal.getTime())) takenAt = parsed.DateTimeOriginal;
    }
  } catch {
    // EXIF is optional metadata.
  }

  const pipeline = () => sharp(original, { limitInputPixels: MAX_PIXELS }).rotate().toColorspace('srgb');
  let preview: Buffer;
  let thumb: Buffer;
  try {
    [preview, thumb] = await Promise.all([
      pipeline().resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer(),
      pipeline().resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer(),
    ]);
  } catch (err) {
    throw new PermanentProcessingError(`Image could not be processed: ${(err as Error).message}`);
  }

  const previewKey = `events/${photo.eventId}/previews/${photo.id}.jpg`;
  const thumbKey = `events/${photo.eventId}/thumbs/${photo.id}.webp`;
  // Derived files are written before the row flips to ready; the original is never modified.
  await Promise.all([ctx.storage.put(previewKey, preview, 'image/jpeg'), ctx.storage.put(thumbKey, thumb, 'image/webp')]);

  await ctx.db
    .update(photos)
    .set({
      status: 'ready',
      error: null,
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      format: detected.ext,
      checksum: createHash('sha256').update(original).digest('hex'),
      previewKey,
      thumbKey,
      previewSizeBytes: preview.length,
      thumbSizeBytes: thumb.length,
      exif,
      takenAt,
    })
    .where(eq(photos.id, photoId));

  await notifyIfBatchDone(ctx, photo.eventId);
  return 'ready';
}

export async function markFailed(ctx: AppContext, photoId: string, message: string) {
  const [p] = await ctx.db.update(photos).set({ status: 'failed', error: message.slice(0, 500) }).where(eq(photos.id, photoId)).returning();
  if (!p) return;
  const [ev] = await ctx.db.select().from(events).where(eq(events.id, p.eventId));
  const hour = Math.floor(Date.now() / 3_600_000);
  if (ev) {
    await notify(ctx.db, { userId: ev.ownerId, type: 'processing.failed', severity: 'warning', title: `Some photos failed processing in “${ev.name}”`, body: 'Open the event to review and retry them.', dedupeKey: `procfail:${ev.id}:${hour}` });
  }
  await notify(ctx.db, { type: 'processing.failed', severity: 'warning', title: 'Photo processing failures', body: `Failures detected${ev ? ` in “${ev.name}”` : ''}. Check the system health page.`, dedupeKey: `procfail-admin:${hour}` });
}

/** One summary notification per finished batch rather than one per photo. */
export async function notifyIfBatchDone(ctx: AppContext, eventId: string) {
  const [{ pending } = { pending: 0 }] = await ctx.db
    .select({ pending: sql<number>`count(*)::int` })
    .from(photos)
    .where(and(eq(photos.eventId, eventId), inArray(photos.status, ['uploaded', 'processing'])));
  if (pending > 0) return;
  const [ev] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!ev) return;
  const [{ ready } = { ready: 0 }] = await ctx.db.select({ ready: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.eventId, eventId), eq(photos.status, 'ready')));
  const bucket = Math.floor(Date.now() / 600_000);
  await notify(ctx.db, { userId: ev.ownerId, type: 'processing.completed', title: `Processing finished for “${ev.name}”`, body: `${ready} photographs are ready to review.`, dedupeKey: `proc:${eventId}:${bucket}` });
}
