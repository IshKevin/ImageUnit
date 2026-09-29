'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { post } from './api';

export type UploadStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'failed';
export interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  error?: string;
  photoId?: string;
  uploadUrl?: string;
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif'];
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

function putFile(url: string, file: File, onProgress: (p: number) => void, register: (x: XMLHttpRequest) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
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

  const addFiles = useCallback((files: File[]) => {
    const fresh: UploadItem[] = files.map((file) => {
      const bad = !ACCEPTED.includes(file.type);
      return { id: `u${idSeq.current++}`, file, status: bad ? 'failed' : 'queued', progress: 0, error: bad ? `Unsupported type ${file.type || 'unknown'}` : undefined };
    });
    sync([...itemsRef.current, ...fresh]);
  }, []);

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
            files: chunk.map((c) => ({ filename: c.file.name, contentType: c.file.type, sizeBytes: c.file.size })),
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
            await putFile(item.uploadUrl!, item.file, (p) => patch(item.id, { progress: p }), (x) => xhrs.current.add(x));
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
      } else if (ACCEPTED.includes(f.file.type)) patch(f.id, { status: 'queued', error: undefined, progress: 0 });
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
  return { items, addFiles, start: run, retryFailed, cancel, clearDone, inFlight, counts: { total: items.length, done: count('done'), failed: count('failed'), remaining: items.length - count('done') - count('failed') } };
}
