import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import type { CoverCrop, Event, Photo } from '../db/schema.js';
import { badRequest } from './errors.js';

const PREVIEW_EDGE = 2560;
const THUMB_EDGE = 480;
const MAX_PIXELS = 300_000_000;

/** Storage keys of an event's cropped cover renditions (empty when no crop is set). */
export function coverCropKeys(e: Pick<Event, 'coverPreviewKey' | 'coverThumbKey'>): string[] {
  return [e.coverPreviewKey, e.coverThumbKey].filter((k): k is string => !!k);
}

/** The cropped rendition to serve, but only while the crop still belongs to a usable cover photo. */
export function croppedCoverKey(e: Pick<Event, 'coverPhotoId' | 'coverPreviewKey' | 'coverThumbKey'>, coverId: string | null | undefined, size: 'thumb' | 'preview') {
  if (!coverId || coverId !== e.coverPhotoId) return null;
  return size === 'thumb' ? e.coverThumbKey : e.coverPreviewKey;
}

/**
 * Renders the cropped cover from the untouched original. The crop is expressed as fractions of the
 * upright (EXIF-rotated) image, so it is independent of the size of the file the editor displayed.
 */
export async function renderCoverCrop(ctx: AppContext, photo: Pick<Photo, 'id' | 'eventId' | 'originalKey' | 'width' | 'height'>, crop: CoverCrop) {
  if (!photo.width || !photo.height) throw badRequest('This photograph has no known dimensions');
  const left = Math.max(0, Math.min(photo.width - 1, Math.round(crop.x * photo.width)));
  const top = Math.max(0, Math.min(photo.height - 1, Math.round(crop.y * photo.height)));
  const width = Math.max(1, Math.min(photo.width - left, Math.round(crop.width * photo.width)));
  const height = Math.max(1, Math.min(photo.height - top, Math.round(crop.height * photo.height)));
  if (width < 64 || height < 64) throw badRequest('The crop is too small; select a larger area');

  const original = await ctx.storage.get(photo.originalKey);
  // rotate() before extract() makes sharp crop the upright image, matching what the editor showed.
  const base = () => sharp(original, { limitInputPixels: MAX_PIXELS }).rotate().extract({ left, top, width, height }).toColorspace('srgb');
  const [preview, thumb] = await Promise.all([
    base().resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toBuffer(),
    base().resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
  ]);
  // A fresh name per crop, so browsers and websites never see a stale cached cover.
  const stamp = `${photo.id}-${randomBytes(4).toString('hex')}`;
  const previewKey = `events/${photo.eventId}/cover/${stamp}.jpg`;
  const thumbKey = `events/${photo.eventId}/cover/${stamp}.webp`;
  await Promise.all([ctx.storage.put(previewKey, preview, 'image/jpeg'), ctx.storage.put(thumbKey, thumb, 'image/webp')]);
  return { previewKey, thumbKey };
}
