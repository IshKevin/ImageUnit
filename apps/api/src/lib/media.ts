import type { Photo } from '../db/schema.js';

export const photoKeys = (p: Pick<Photo, 'originalKey' | 'previewKey' | 'thumbKey'>): string[] =>
  [p.originalKey, p.previewKey, p.thumbKey].filter((k): k is string => !!k);

export const photoStorageBytes = (p: Pick<Photo, 'sizeBytes' | 'previewSizeBytes' | 'thumbSizeBytes'>) =>
  p.sizeBytes + p.previewSizeBytes + p.thumbSizeBytes;

export type MediaKind = 'image' | 'video';

/** Accepted upload types -> stored file extension. */
export const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

export const mediaKindOf = (contentType: string): MediaKind => (contentType.startsWith('video/') ? 'video' : 'image');

/** Name offered on download: the editor-chosen title when there is one, otherwise the original file name. */
export function downloadName(p: Pick<Photo, 'title' | 'filename'>, ext?: string): string {
  const base = (p.title?.trim() || p.filename.replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'media';
  const original = p.filename.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase();
  return `${base}.${ext ?? original ?? 'bin'}`;
}

export const SQL_PHOTO_BYTES = 'size_bytes + preview_size_bytes + thumb_size_bytes';

/** Tags are free text: trimmed, lower-cased, de-duplicated, with sane limits so filters and indexes stay predictable. */
export function normalizeTags(tags: string[]): string[] {
  const out = new Set<string>();
  // "winner, podium" is two tags, whichever client sent it.
  for (const t of tags.flatMap((x) => x.split(','))) {
    const v = t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (v) out.add(v);
  }
  return [...out].slice(0, 30);
}
