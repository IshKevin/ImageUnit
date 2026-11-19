'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, post } from './api';

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
  /** When uploadUrl was issued; links last an hour, so older ones are refreshed before use. */
  urlAt?: number;
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
/** Parallel file transfers. Browsers allow about six connections per host, so more would only queue. */
const CONCURRENCY = 6;
/** Files reserved (rows + upload links) per request. Reserved just ahead of the transfers, not all at the start. */
const INIT_BATCH = 100;
const COMPLETE_BATCH = 20;
/** Each file and each finalize request is tried this many times before it is shown as failed. */
const ATTEMPTS = 3;
/** Upload links are valid for an hour; anything older than this is replaced before the transfer starts. */
const URL_MAX_AGE_MS = 45 * 60 * 1000;
/** How often the list on screen is refreshed while uploading. Thousands of files would freeze the page if every progress tick re-rendered. */
const RENDER_INTERVAL_MS = 250;
/** Rows shown in the on-screen list; the counters cover the rest. */
const VISIBLE_ROWS = 50;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Errors worth trying again: lost connections, rate limits and server-side hiccups (not "you may not do this"). */
const isTransient = (e: unknown) => !(e instanceof ApiError) || e.status === 429 || e.status >= 500;

class UploadError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

interface InitResponse {
  uploads: { photoId: string; filename: string; uploadUrl: string }[];
  rejected: { filename: string; reason: string }[];
}
interface CompleteResponse {
  results: { photoId: string; ok: boolean; error?: string }[];
}

/** Retries a request on transient failures (lost connection, rate limit, 5xx). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= ATTEMPTS || !isTransient(e)) throw e;
      await wait(1500 * attempt);
    }
  }
}

function putFile(url: string, file: File, contentType: string, onProgress: (p: number) => void, register: (x: XMLHttpRequest) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    // 5xx/429 are storage hiccups; 403 is usually an upload link that expired while queued (a fresh link fixes both).
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError(`Storage rejected the upload (${xhr.status})`, xhr.status >= 500 || xhr.status === 429 || xhr.status === 403)));
    xhr.onerror = () => {
      let host = 'the storage server';
      try {
        host = new URL(url).host;
      } catch {
        /* keep the generic wording */
      }
      reject(new UploadError(`Could not reach the file storage (${host}). Check your connection. If it persists, ask an administrator to check the storage address and CORS settings.`, true));
    };
    xhr.onabort = () => reject(new UploadError('Cancelled', false));
    xhr.send(file);
  });
}

/**
 * Bulk upload manager. Files go straight from the browser to object storage using presigned URLs,
 * so the API never proxies photograph bytes. Failures are tracked per file and can be retried individually.
 *
 * Built for batches of 10,000+ files:
 *  - items live in a ref and are updated in place; the screen is refreshed a few times a second, not on every progress tick;
 *  - files are reserved on the server in batches just ahead of the transfers, so upload links never sit in a queue
 *    long enough to expire, and cancelling leaves few unused reservations behind;
 *  - files added while an upload is running join it instead of waiting for another start.
 */
export function useUploader(eventId: string, galleryId: string | undefined, onSettled: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const indexRef = useRef(new Map<string, number>());
  const running = useRef(false);
  const cancelled = useRef(false);
  const xhrs = useRef(new Set<XMLHttpRequest>());
  const idSeq = useRef(0);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = null;
    setItems(itemsRef.current.slice());
  }, []);
  const scheduleRender = useCallback(() => {
    if (!renderTimer.current) renderTimer.current = setTimeout(flush, RENDER_INTERVAL_MS);
  }, [flush]);
  /** Replaces the whole list (adding or removing items), and shows it right away. */
  const replaceAll = useCallback((next: UploadItem[]) => {
    itemsRef.current = next;
    indexRef.current = new Map(next.map((i, n) => [i.id, n]));
    flush();
  }, [flush]);
  useEffect(() => () => { if (renderTimer.current) clearTimeout(renderTimer.current); }, []);

  /** Updates one item in place: constant time, whatever the size of the batch. */
  const patch = useCallback((id: string, p: Partial<UploadItem>) => {
    const n = indexRef.current.get(id);
    if (n === undefined) return;
    const cur = itemsRef.current[n]!;
    itemsRef.current[n] = { ...cur, ...p };
    scheduleRender();
  }, [scheduleRender]);
  const current = (id: string) => {
    const n = indexRef.current.get(id);
    return n === undefined ? undefined : itemsRef.current[n];
  };

  const addEntries = useCallback((entries: { file: File; path?: string; galleryName?: string }[]) => {
    const fresh: UploadItem[] = entries.map(({ file, path, galleryName }) => {
      const error = validate(file);
      return { id: `u${idSeq.current++}`, file, contentType: mimeOf(file), path, galleryName, status: error ? 'failed' : 'queued', progress: 0, error } as UploadItem;
    });
    replaceAll([...itemsRef.current, ...fresh]);
  }, [replaceAll]);
  const addFiles = useCallback((files: File[]) => addEntries(files.map((file) => ({ file }))), [addEntries]);

  const finalize = useCallback(
    async (batch: UploadItem[]) => {
      if (!batch.length) return;
      try {
        const res = await withRetry(() => post<CompleteResponse>(`/events/${eventId}/uploads/complete`, { photoIds: batch.map((b) => b.photoId) }));
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

  /** Reserves photographs and upload links for files that do not have them yet. */
  const reserve = useCallback(
    async (chunk: UploadItem[]) => {
      const need = chunk.map((c) => current(c.id)!).filter((c) => c && c.status === 'queued' && !c.photoId);
      if (!need.length) return;
      try {
        const res = await withRetry(() =>
          post<InitResponse>(`/events/${eventId}/uploads`, {
            galleryId,
            files: need.map((c) => ({ filename: c.file.name, contentType: c.contentType, sizeBytes: c.file.size, ...(c.galleryName && { galleryName: c.galleryName }) })),
          }),
        );
        const rejected = new Map(res.rejected.map((r) => [r.filename, r.reason]));
        // Several files can share a name (same name in different folders): hand each reply out once.
        const byName = new Map<string, InitResponse['uploads']>();
        for (const u of res.uploads) byName.set(u.filename, [...(byName.get(u.filename) ?? []), u]);
        const now = Date.now();
        for (const c of need) {
          const u = byName.get(c.file.name)?.shift();
          if (u) patch(c.id, { photoId: u.photoId, uploadUrl: u.uploadUrl, urlAt: now });
          else patch(c.id, { status: 'failed', error: rejected.get(c.file.name) ?? 'Rejected by server' });
        }
      } catch (e) {
        for (const c of need) patch(c.id, { status: 'failed', error: (e as Error).message });
      }
    },
    [eventId, galleryId, patch],
  );

  /** Uploads one batch of queued items: reservations run a chunk ahead of the transfers. */
  const processBatch = useCallback(
    async (batch: UploadItem[]) => {
      const chunks: Promise<void>[] = [];
      const reserveChunk = (k: number) => {
        if (k * INIT_BATCH >= batch.length) return Promise.resolve();
        return (chunks[k] ??= reserve(batch.slice(k * INIT_BATCH, (k + 1) * INIT_BATCH)));
      };
      const pending: UploadItem[] = [];
      let cursor = 0;

      const worker = async () => {
        while (!cancelled.current) {
          const pos = cursor++;
          if (pos >= batch.length) return;
          const k = Math.floor(pos / INIT_BATCH);
          await reserveChunk(k);
          // Halfway through a chunk, start reserving the next one so the transfers never wait for it.
          if (pos % INIT_BATCH >= INIT_BATCH / 2) void reserveChunk(k + 1);
          if (cancelled.current) return;
          const item = current(batch[pos]!.id);
          if (!item || item.status !== 'queued' || !item.photoId) continue;

          patch(item.id, { status: 'uploading', progress: 0, error: undefined });
          try {
            let url = item.uploadUrl;
            for (let attempt = 1; ; attempt++) {
              try {
                // A fresh link when there is none (a retry) or the one we hold may have expired.
                if (!url || !item.urlAt || Date.now() - item.urlAt > URL_MAX_AGE_MS || attempt > 1) {
                  url = (await withRetry(() => post<{ uploadUrl: string }>(`/photos/${item.photoId}/upload-url`))).uploadUrl;
                  patch(item.id, { uploadUrl: url, urlAt: Date.now() });
                }
                let last = 0;
                await putFile(url, item.file, item.contentType, (p) => {
                  // Progress for the list only; skip tiny steps.
                  if (p - last >= 0.02 || p === 1) { last = p; patch(item.id, { progress: p }); }
                }, (x) => xhrs.current.add(x));
                break;
              } catch (e) {
                // 409: the server already has this file (an earlier attempt got through); just confirm it.
                if (e instanceof ApiError && e.status === 409) break;
                if (cancelled.current || attempt >= ATTEMPTS || !(e instanceof UploadError ? e.retryable : isTransient(e))) throw e;
                patch(item.id, { progress: 0 });
                await wait(2000 * attempt);
              }
            }
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
    },
    [reserve, finalize, patch],
  );

  const run = useCallback(async () => {
    if (running.current) return; // files added meanwhile are picked up by the loop below
    running.current = true;
    cancelled.current = false;
    try {
      for (;;) {
        if (cancelled.current) break;
        const batch = itemsRef.current.filter((i) => i.status === 'queued');
        if (!batch.length) break;
        await processBatch(batch);
      }
    } finally {
      xhrs.current.clear();
      running.current = false;
      flush();
      onSettled();
    }
  }, [processBatch, flush, onSettled]);

  /** Re-queues failed files; each gets a fresh upload link just before it is sent. */
  const retryFailed = useCallback(async () => {
    for (const f of itemsRef.current) {
      if (f.status !== 'failed') continue;
      if (f.photoId) patch(f.id, { status: 'queued', uploadUrl: undefined, urlAt: undefined, error: undefined, progress: 0 });
      else if (!validate(f.file)) patch(f.id, { status: 'queued', error: undefined, progress: 0 });
    }
    flush();
    void run();
  }, [patch, flush, run]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    xhrs.current.forEach((x) => x.abort());
    replaceAll(itemsRef.current.filter((i) => i.status !== 'queued'));
  }, [replaceAll]);

  const clearDone = useCallback(() => replaceAll(itemsRef.current.filter((i) => i.status !== 'done')), [replaceAll]);

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (running.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // One pass over the list per screen refresh: counts, and the rows worth showing (in progress, then failed, then next up).
  const { counts, visible, inFlight } = useMemo(() => {
    const c = { queued: 0, uploading: 0, finalizing: 0, done: 0, failed: 0 };
    const active: UploadItem[] = [];
    const failed: UploadItem[] = [];
    const queued: UploadItem[] = [];
    for (const i of items) {
      c[i.status]++;
      if (i.status === 'uploading' || i.status === 'finalizing') { if (active.length < VISIBLE_ROWS) active.push(i); }
      else if (i.status === 'failed') { if (failed.length < VISIBLE_ROWS) failed.push(i); }
      else if (i.status === 'queued' && queued.length < VISIBLE_ROWS) queued.push(i);
    }
    return {
      counts: { total: items.length, done: c.done, failed: c.failed, remaining: items.length - c.done - c.failed },
      visible: [...active, ...failed, ...queued].slice(0, VISIBLE_ROWS),
      inFlight: c.queued + c.uploading + c.finalizing > 0,
    };
  }, [items]);

  return { items, visible, addFiles, addEntries, start: run, retryFailed, cancel, clearDone, inFlight, counts };
}
