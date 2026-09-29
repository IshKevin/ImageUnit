import type { Photo } from '../db/schema.js';

export const photoKeys = (p: Pick<Photo, 'originalKey' | 'previewKey' | 'thumbKey'>): string[] =>
  [p.originalKey, p.previewKey, p.thumbKey].filter((k): k is string => !!k);

export const photoStorageBytes = (p: Pick<Photo, 'sizeBytes' | 'previewSizeBytes' | 'thumbSizeBytes'>) =>
  p.sizeBytes + p.previewSizeBytes + p.thumbSizeBytes;

export const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/avif': 'avif',
};

export const SQL_PHOTO_BYTES = 'size_bytes + preview_size_bytes + thumb_size_bytes';
