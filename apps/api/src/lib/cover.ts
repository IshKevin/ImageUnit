import { randomBytes } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata, type Region } from 'sharp';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { CoverCrop, Event } from '../db/schema.js';
import { badRequest } from './errors.js';

// The large cover keeps every pixel of the cropped area (up to 8K), so a crop never has a lower
// resolution than the part of the original it came from. Re-cropping a cover re-renders it.
const PREVIEW_EDGE = 7680;
const THUMB_EDGE = 1024;
const MAX_PIXELS = 300_000_000;
export const COVER_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_COVER_UPLOAD_BYTES = 20 * 1024 * 1024;

const unit = z.number().min(0).max(1);
/** Request schema for a crop: fractions of the upright image, inside its bounds. */
export const cropSchema = z
  .object({ x: unit, y: unit, width: unit.gt(0), height: unit.gt(0) })
  .refine((c) => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, 'The crop must lie inside the image');

/** Storage keys of rendered cover files (empty when there are none). */
export function coverCropKeys(e: { coverPreviewKey: string | null; coverThumbKey: string | null }): string[] {
  return [e.coverPreviewKey, e.coverThumbKey].filter((k): k is string => !!k);
}

/** The cropped rendition to serve, but only while the crop still belongs to the cover photo in use. */
export function croppedCoverKey(e: Pick<Event, 'coverPhotoId' | 'coverPreviewKey' | 'coverThumbKey'>, coverId: string | null | undefined, size: 'thumb' | 'preview') {
  if (!coverId || coverId !== e.coverPhotoId) return null;
  return size === 'thumb' ? e.coverThumbKey : e.coverPreviewKey;
}

/**
 * Renders cover files (a large JPEG and a small WebP) from an untouched original, optionally cropped.
 * The crop is in fractions of the upright (EXIF-rotated) image, so it does not depend on the size of
 * the picture the editor displayed. `prefix` is the storage folder; each render gets fresh names so
 * browsers and websites never see a stale cached cover.
 */
export async function renderCover(ctx: AppContext, originalKey: string, crop: CoverCrop | null, prefix: string) {
  const original = await ctx.storage.get(originalKey);
  let meta: Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw badRequest('The image could not be read');
  }
  if (!meta.width || !meta.height) throw badRequest('The image has no dimensions');
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;

  let region: Region | null = null;
  if (crop) {
    const left = Math.max(0, Math.min(W - 1, Math.round(crop.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(crop.y * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(crop.width * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(crop.height * H)));
    if (width < 64 || height < 64) throw badRequest('The crop is too small; select a larger area');
    region = { left, top, width, height };
  }

  // rotate() before extract() makes sharp crop the upright image, matching what the editor showed.
  const base = () => {
    const img = sharp(original, { limitInputPixels: MAX_PIXELS }).rotate();
    return (region ? img.extract(region) : img).toColorspace('srgb');
  };
  let preview: Buffer;
  let thumb: Buffer;
  try {
    [preview, thumb] = await Promise.all([
      base().resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4', optimiseCoding: true }).toBuffer(),
      base().resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86, smartSubsample: true }).toBuffer(),
    ]);
  } catch (err) {
    throw badRequest(`The image could not be processed: ${(err as Error).message}`);
  }
  const stamp = `${prefix}/${randomBytes(6).toString('hex')}`;
  const previewKey = `${stamp}.jpg`;
  const thumbKey = `${stamp}.webp`;
  await Promise.all([ctx.storage.put(previewKey, preview, 'image/jpeg'), ctx.storage.put(thumbKey, thumb, 'image/webp')]);
  return { previewKey, thumbKey };
}

/** Checks that an uploaded cover really is a supported image of an acceptable size. */
export async function assertCoverUpload(ctx: AppContext, key: string) {
  const info = await ctx.storage.head(key);
  if (!info) throw badRequest('The upload was not received; try again');
  if (info.size > MAX_COVER_UPLOAD_BYTES) throw badRequest('The cover image must be 20 MB or smaller');
  const detected = await fileTypeFromBuffer(await ctx.storage.get(key));
  if (!detected || !(COVER_UPLOAD_TYPES as readonly string[]).includes(detected.mime)) throw badRequest('Choose a JPEG, PNG or WebP image');
}
