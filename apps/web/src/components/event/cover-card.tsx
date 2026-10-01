'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ImageIcon, Images, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, ErrorNote, Modal, Pagination, Progress, Spinner } from '../ui';
import { get, patch, post, qs, type EventItem, type Paged, type Photo } from '@/lib/api';
import { useMe } from '@/lib/auth';

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const PICK_PAGE_SIZE = 24;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

type Phase = { kind: 'idle' } | { kind: 'uploading'; progress: number } | { kind: 'processing' };

export function CoverCard({ event }: { event: EventItem }) {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';
  const archived = ['archived', 'scheduled_for_deletion'].includes(event.status);
  const fileInput = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [uploadError, setUploadError] = useState<string | null>(null);

  const photos = useQuery({
    queryKey: ['event-cover-photos', event.id, page],
    queryFn: () => get<Paged<Photo>>(`/events/${event.id}/photos${qs({ status: 'ready', type: 'image', page, pageSize: PICK_PAGE_SIZE })}`),
    enabled: picking,
    placeholderData: (prev) => prev,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['event', event.id] });
    void qc.invalidateQueries({ queryKey: ['events'] });
  };
  const setCover = useMutation({
    mutationFn: (coverPhotoId: string | null) => patch(`/events/${event.id}`, { coverPhotoId }),
    onSuccess: (_d, id) => {
      toast.success(id ? 'Cover image updated' : 'Cover set to automatic');
      setPicking(false);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  if (event.myAccess === 'contribute' || (archived && !isAdmin)) return null;

  const busy = phase.kind !== 'idle';

  const upload = async (file: File) => {
    setUploadError(null);
    if (!COVER_TYPES.includes(file.type)) return setUploadError('Choose a JPEG, PNG or WebP image.');
    if (file.size > MAX_COVER_BYTES) return setUploadError('The cover image must be 20 MB or smaller.');
    try {
      setPhase({ kind: 'uploading', progress: 0 });
      const init = await post<{ uploads: { photoId: string; uploadUrl: string }[]; rejected: { reason: string }[] }>(`/events/${event.id}/uploads`, {
        asCover: true,
        files: [{ filename: file.name, contentType: file.type, sizeBytes: file.size }],
      });
      const target = init.uploads[0];
      if (!target) throw new Error(init.rejected[0]?.reason ?? 'The server rejected this image');
      await putWithProgress(target.uploadUrl, file, (p) => setPhase({ kind: 'uploading', progress: p }));
      setPhase({ kind: 'processing' });
      await post(`/events/${event.id}/uploads/complete`, { photoIds: [target.photoId] });
      // Processing is asynchronous: wait (up to ~2 min) until the image is ready.
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(i < 5 ? 1000 : 2000);
        const res = await get<Paged<Photo>>(`/events/${event.id}/photos${qs({ hidden: 'true', pageSize: 100 })}`);
        const p = res.items.find((x) => x.id === target.photoId);
        if (p?.status === 'failed') throw new Error(p.error ?? 'The image could not be processed');
        ready = p?.status === 'ready';
      }
      if (!ready) throw new Error('Processing is taking longer than expected. Try again in a moment.');
      await patch(`/events/${event.id}`, { coverPhotoId: target.photoId });
      toast.success('Cover image updated');
      refresh();
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setPhase({ kind: 'idle' });
    }
  };

  return (
    <Card>
      <CardHeader title="Cover image" />
      <div className="space-y-4 p-5">
        {event.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.coverUrl} alt={`Current cover image of ${event.name}`} className="aspect-[16/9] w-full rounded-lg bg-surface-2 object-cover" />
        ) : (
          <div className="grid aspect-[16/9] w-full place-items-center rounded-lg border border-dashed border-border bg-surface-2 p-4 text-center text-sm text-muted">
            <span className="flex flex-col items-center gap-2"><ImageIcon className="size-6" aria-hidden /> Automatic: the first photograph is used</span>
          </div>
        )}
        <p className="text-xs text-muted">
          The cover appears as the banner at the top of the public gallery, in the event list, and as the picture websites receive.
        </p>

        <input
          ref={fileInput}
          type="file"
          accept={COVER_TYPES.join(',')}
          hidden
          aria-label="Choose a cover image file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || setCover.isPending} onClick={() => { setPage(1); setPicking(true); }}>
            <Images className="size-4" /> Choose from photos
          </Button>
          <Button disabled={busy || setCover.isPending} onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" /> Upload a cover image
          </Button>
          {event.coverPhotoId && (
            <Button variant="ghost" disabled={busy} loading={setCover.isPending && setCover.variables === null} onClick={() => setCover.mutate(null)}>
              Use automatic cover
            </Button>
          )}
        </div>

        <div aria-live="polite" className="space-y-2">
          {phase.kind === 'uploading' && (
            <>
              <p className="text-sm text-muted">Uploading… {Math.round(phase.progress * 100)}%</p>
              <Progress value={phase.progress * 100} />
            </>
          )}
          {phase.kind === 'processing' && <p className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Processing the image…</p>}
          {uploadError && <p role="alert" className="text-sm text-danger">{uploadError}</p>}
        </div>
        <p className="text-xs text-muted">JPEG, PNG or WebP, up to 20 MB. An uploaded cover is not shown in the gallery.</p>
      </div>

      <Modal open={picking} onClose={() => setPicking(false)} title="Choose a cover image" wide>
        <ErrorNote error={photos.error} />
        {photos.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Loading photos…</p>
        ) : photos.data && photos.data.items.length === 0 ? (
          <p className="text-sm text-muted">No processed photos yet. Upload photos first, or upload a cover image directly.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.data?.items.map((p) => {
              const current = p.id === event.coverPhotoId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={setCover.isPending}
                    onClick={() => setCover.mutate(p.id)}
                    aria-label={`Use ${p.title?.trim() || p.filename} as cover${current ? ' (current cover)' : ''}`}
                    aria-pressed={current}
                    className={clsx('relative block aspect-square w-full overflow-hidden rounded-lg bg-surface-2 ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent', current && 'ring-2 ring-accent')}
                  >
                    {p.thumbUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumbUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                    )}
                    {current && (
                      <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-white">
                        <Check className="size-3" aria-hidden /> Cover
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {photos.data && <div className="mt-3 -mx-5 -mb-5"><Pagination page={page} pageSize={PICK_PAGE_SIZE} total={photos.data.total} onChange={setPage} /></div>}
      </Modal>
    </Card>
  );
}
