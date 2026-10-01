'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { post } from './api';

export type UploadStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'failed';
export interface UploadItem {
  id: string;
  file: File;
  /** Effective MIME type (inferred from the extension when the browser gives none). */
  contentType: string;
  /** Relative path inside a dropped/selected folder, when applicable. */
  path?: string;
  /** Gallery the server should create/use for this file. */
  galleryName?: string;
  status: UploadStatus;
  progress: number;
  error?: string;
  photoId?: string;
  uploadUrl?: string;
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];
export const ACCEPT_ATTR = [...IMAGE_TYPES, ...VIDEO_TYPES].join(',');
const ACCEPTED = [...IMAGE_TYPES, ...VIDEO_TYPES];
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
};
/** MIME type for a file name based on its extension, or '' when it is not an accepted media type. */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : (EXT_TYPES[name.slice(dot + 1).toLowerCase()] ?? '');
}
/** The browser-reported type when it is an accepted one, otherwise inferred from the extension. */
export function mimeOf(file: File): string {
  if (ACCEPTED.includes(file.type)) return file.type;
  return mimeFromName(file.name) || file.type;
}
export const isVideoFile = (f: File) => VIDEO_TYPES.includes(mimeOf(f));

function validate(file: File): string | undefined {
  const type = mimeOf(file);
  if (!ACCEPTED.includes(type)) return `Unsupported type ${type || 'unknown'}`;
  if (file.size === 0) return 'File is empty';
  if (isVideoFile(file) && file.size > MAX_VIDEO_BYTES) return 'Video is larger than the 2 GB limit';
  if (!isVideoFile(file) && file.size > MAX_IMAGE_BYTES) return 'Photo is larger than the 100 MB limit';
  return undefined;
}
const CONCURRENCY = 4;
const INIT_BATCH = 100;
const COMPLETE_BATCH = 20;

interface InitResponse {
  uploads: { photoId: string; filename: string; uploadUrl: string }[];
  rejected: { filename: string; reason: string }[];
}
interface CompleteResponse {
  results: { photoId: string; ok: boolean; error?: string }[];
}

function putFile(url: string, file: File, contentType: string, onProgress: (p: number) => void, register: (x: XMLHttpRequest) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${xhr.status})`)));
    xhr.onerror = () => {
      let host = 'the storage server';
      try {
        host = new URL(url).host;
      } catch {
        /* keep the generic wording */
      }
      reject(new Error(`Could not reach the file storage (${host}). Check your connection. If it persists, ask an administrator to check the storage address and CORS settings.`));
    };
    xhr.onabort = () => reject(new Error('Cancelled'));
    xhr.send(file);
  });
}

/**
 * Bulk upload manager. Files go straight from the browser to object storage using presigned URLs,
 * so the API never proxies photograph bytes. Failures are tracked per file and can be retried individually.
 */
export function useUploader(eventId: string, galleryId: string | undefined, onSettled: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const cancelled = useRef(false);
  const xhrs = useRef(new Set<XMLHttpRequest>());
  const idSeq = useRef(0);

  const sync = (next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  const patch = useCallback((id: string, p: Partial<UploadItem>) => {
    sync(itemsRef.current.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  const addEntries = useCallback((entries: { file: File; path?: string; galleryName?: string }[]) => {
    const fresh: UploadItem[] = entries.map(({ file, path, galleryName }) => {
      const error = validate(file);
      return { id: `u${idSeq.current++}`, file, contentType: mimeOf(file), path, galleryName, status: error ? 'failed' : 'queued', progress: 0, error } as UploadItem;
    });
    sync([...itemsRef.current, ...fresh]);
  }, []);
  const addFiles = useCallback((files: File[]) => addEntries(files.map((file) => ({ file }))), [addEntries]);

  const finalize = useCallback(
    async (batch: UploadItem[]) => {
      if (!batch.length) return;
      try {
        const res = await post<CompleteResponse>(`/events/${eventId}/uploads/complete`, { photoIds: batch.map((b) => b.photoId) });
        const byId = new Map(res.results.map((r) => [r.photoId, r]));
        for (const b of batch) {
          const r = byId.get(b.photoId!);
          patch(b.id, r?.ok ? { status: 'done', progress: 1 } : { status: 'failed', error: r?.error ?? 'Could not finalize upload' });
        }
      } catch (e) {
        for (const b of batch) patch(b.id, { status: 'failed', error: (e as Error).message });
      }
    },
    [eventId, patch],
  );

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    try {
      // 1. Reserve photographs + presigned URLs in batches.
      const needInit = itemsRef.current.filter((i) => i.status === 'queued' && !i.uploadUrl);
      for (let i = 0; i < needInit.length && !cancelled.current; i += INIT_BATCH) {
        const chunk = needInit.slice(i, i + INIT_BATCH);
        try {
          const res = await post<InitResponse>(`/events/${eventId}/uploads`, {
            galleryId,
            files: chunk.map((c) => ({ filename: c.file.name, contentType: c.contentType, sizeBytes: c.file.size, ...(c.galleryName && { galleryName: c.galleryName }) })),
          });
          const rejected = new Map(res.rejected.map((r) => [r.filename, r.reason]));
          const accepted = [...res.uploads];
          for (const c of chunk) {
            const idx = accepted.findIndex((u) => u.filename === c.file.name);
            if (idx >= 0) {
              const [u] = accepted.splice(idx, 1);
              patch(c.id, { photoId: u!.photoId, uploadUrl: u!.uploadUrl });
            } else patch(c.id, { status: 'failed', error: rejected.get(c.file.name) ?? 'Rejected by server' });
          }
        } catch (e) {
          for (const c of chunk) patch(c.id, { status: 'failed', error: (e as Error).message });
        }
      }

      // 2. Upload with bounded concurrency; finalize in small batches.
      const pending: UploadItem[] = [];
      const queue = itemsRef.current.filter((i) => i.status === 'queued' && i.uploadUrl);
      let cursor = 0;
      const worker = async () => {
        while (!cancelled.current) {
          const item = queue[cursor++];
          if (!item) return;
          patch(item.id, { status: 'uploading', progress: 0, error: undefined });
          try {
            await putFile(item.uploadUrl!, item.file, item.contentType, (p) => patch(item.id, { progress: p }), (x) => xhrs.current.add(x));
            patch(item.id, { status: 'finalizing', progress: 1 });
            pending.push(item);
            if (pending.length >= COMPLETE_BATCH) await finalize(pending.splice(0));
          } catch (e) {
            patch(item.id, { status: 'failed', error: (e as Error).message });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      await finalize(pending.splice(0));
    } finally {
      xhrs.current.clear();
      running.current = false;
      onSettled();
    }
  }, [eventId, galleryId, patch, finalize, onSettled]);

  /** Re-queues failed files; the server issues fresh URLs for files it already knows about. */
  const retryFailed = useCallback(async () => {
    const failed = itemsRef.current.filter((i) => i.status === 'failed');
    for (const f of failed) {
      if (f.photoId) {
        try {
          const r = await post<{ uploadUrl: string }>(`/photos/${f.photoId}/upload-url`);
          patch(f.id, { status: 'queued', uploadUrl: r.uploadUrl, error: undefined, progress: 0 });
        } catch (e) {
          patch(f.id, { error: (e as Error).message });
        }
      } else if (!validate(f.file)) patch(f.id, { status: 'queued', error: undefined, progress: 0 });
    }
    void run();
  }, [patch, run]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    xhrs.current.forEach((x) => x.abort());
    sync(itemsRef.current.filter((i) => i.status !== 'queued'));
  }, []);

  const clearDone = useCallback(() => sync(itemsRef.current.filter((i) => i.status !== 'done')), []);

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (running.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const count = (s: UploadStatus) => items.filter((i) => i.status === s).length;
  const inFlight = items.some((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'finalizing');
  return { items, addFiles, addEntries, start: run, retryFailed, cancel, clearDone, inFlight, counts: { total: items.length, done: count('done'), failed: count('failed'), remaining: items.length - count('done') - count('failed') } };
}
