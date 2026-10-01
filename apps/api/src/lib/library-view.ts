import type { AppContext } from '../context.js';
import type { Photo } from '../db/schema.js';

/** One row of the library / a collection: the item plus the event it belongs to and a short-lived thumbnail link. */
export function createItemView(ctx: AppContext) {
  return async (p: Photo, e: { id: string; name: string; eventDate: string | null }) => ({
    id: p.id,
    mediaType: p.mediaType,
    title: p.title,
    filename: p.filename,
    description: p.description,
    tags: p.tags,
    status: p.status,
    error: p.error,
    isHidden: p.isHidden,
    width: p.width,
    height: p.height,
    durationSeconds: p.durationSeconds,
    sizeBytes: p.sizeBytes,
    takenAt: p.takenAt,
    createdAt: p.createdAt,
    galleryId: p.galleryId,
    event: { id: e.id, name: e.name, date: e.eventDate },
    thumbUrl: p.status === 'ready' && p.thumbKey ? await ctx.storage.presignDownload(p.thumbKey, { ttlSeconds: 900 }) : null,
    // Playable MP4 for videos (a JPEG for photos); only needed when an item is opened, but cheap to sign.
    previewUrl: p.status === 'ready' && p.previewKey ? await ctx.storage.presignDownload(p.previewKey, { ttlSeconds: 900 }) : null,
  });
}
