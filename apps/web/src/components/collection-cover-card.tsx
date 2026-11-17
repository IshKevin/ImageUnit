'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Crop, ImageIcon, Images, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, ErrorNote, Modal, Pagination, Progress, Spinner } from '@/components/ui';
import { CoverCropModal } from '@/components/event/cover-crop-modal';
import { putWithProgress } from '@/components/event/cover-card';
import { get, patch, post, put, qs, type Collection, type Paged, type Photo } from '@/lib/api';

const PICK_PAGE_SIZE = 24;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_BYTES = 20 * 1024 * 1024;

type Phase = { kind: 'idle' } | { kind: 'uploading'; progress: number } | { kind: 'processing' };

export function CollectionCoverCard({ collection }: { collection: Collection }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [page, setPage] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [uploadError, setUploadError] = useState<string | null>(null);

  const photos = useQuery({
    queryKey: ['collection-cover-photos', collection.id, page],
    queryFn: () =>
      get<Paged<Photo>>(`/collections/${collection.id}/items${qs({ status: 'ready', type: 'image', page, pageSize: PICK_PAGE_SIZE })}`),
    enabled: picking,
    placeholderData: (prev) => prev,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['collection', collection.id] });
    void qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const setCover = useMutation({
    mutationFn: (coverPhotoId: string | null) => patch(`/collections/${collection.id}`, { coverPhotoId }),
    onSuccess: (_d, id) => {
      toast.success(id ? 'Cover image updated' : 'Cover set to automatic');
      setPicking(false);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const busy = phase.kind !== 'idle';
  const source = collection.coverSource;
  // A crop applies to the picture it was made on: the uploaded image, or the chosen cover photo.
  const savedCrop = collection.coverCrop && source && (source.kind === 'upload' || source.photoId === collection.coverPhotoId) ? collection.coverCrop : null;
  const isCustom = collection.coverUploaded || !!collection.coverPhotoId;

  const upload = async (file: File) => {
    setUploadError(null);
    if (!COVER_TYPES.includes(file.type)) return setUploadError('Choose a JPEG, PNG or WebP image.');
    if (file.size > MAX_COVER_BYTES) return setUploadError('The cover image must be 20 MB or smaller.');
    try {
      setPhase({ kind: 'uploading', progress: 0 });
      const { key, uploadUrl } = await post<{ key: string; uploadUrl: string }>(`/collections/${collection.id}/cover-upload`, { contentType: file.type, sizeBytes: file.size });
      await putWithProgress(uploadUrl, file, (p) => setPhase({ kind: 'uploading', progress: p }));
      setPhase({ kind: 'processing' });
      await post(`/collections/${collection.id}/cover-upload/complete`, { key });
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
        {collection.coverUrl ? (
          // A cropped cover is shown at its own shape; otherwise the usual 16:9 framing.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={collection.coverUrl}
            alt={`Current cover image of ${collection.name}`}
            className={collection.coverCrop ? 'max-h-80 w-full rounded-lg bg-surface-2 object-contain' : 'aspect-[16/9] w-full rounded-lg bg-surface-2 object-cover'}
          />
        ) : (
          <div className="grid aspect-[16/9] w-full place-items-center rounded-lg border border-dashed border-border bg-surface-2 p-4 text-center text-sm text-muted">
            <span className="flex flex-col items-center gap-2">
              <ImageIcon className="size-6" aria-hidden /> Automatic: the first media item is used
            </span>
          </div>
        )}
        <p className="text-xs text-muted">
          The cover represents this collection across the dashboard, in collection lists, and when websites fetch it.
          {collection.coverUploaded && ' It is an uploaded image, not one of the collection items.'}
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
            <Images className="size-4" /> Choose from collection items
          </Button>
          <Button disabled={busy || setCover.isPending} onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" /> Upload a cover image
          </Button>
          {source?.croppable && (
            <Button disabled={busy || setCover.isPending} onClick={() => setCropping(true)}>
              <Crop className="size-4" /> {savedCrop ? 'Edit crop' : 'Crop / reposition'}
            </Button>
          )}
          {isCustom && (
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
        <p className="text-xs text-muted">Uploads: JPEG, PNG or WebP, up to 20 MB.</p>
      </div>

      {source && (
        <CoverCropModal
          open={cropping}
          onClose={() => setCropping(false)}
          sourceUrl={source.url}
          savedCrop={savedCrop}
          onSave={(crop) => put(`/collections/${collection.id}/cover-crop`, source.kind === 'upload' ? { crop } : { photoId: source.photoId, crop })}
          onSaved={refresh}
          usedIn="the dashboard, collection lists and connected websites"
        />
      )}

      <Modal open={picking} onClose={() => setPicking(false)} title="Choose a cover image" wide>
        <ErrorNote error={photos.error} />
        {photos.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Loading photos…</p>
        ) : photos.data && photos.data.items.length === 0 ? (
          <p className="text-sm text-muted">No processed photos in this collection yet. Add media to the collection first, or upload a cover image.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.data?.items.map((p) => {
              const current = p.id === collection.coverPhotoId && !collection.coverUploaded;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={setCover.isPending}
                    onClick={() => setCover.mutate(p.id)}
                    aria-label={`Use ${p.title?.trim() || p.filename} as cover${current ? ' (current cover)' : ''}`}
                    aria-pressed={current}
                    className={clsx(
                      'relative block aspect-square w-full overflow-hidden rounded-lg bg-surface-2 ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent',
                      current && 'ring-2 ring-accent',
                    )}
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
        {photos.data && (
          <div className="mt-3 -mx-5 -mb-5">
            <Pagination page={page} pageSize={PICK_PAGE_SIZE} total={photos.data.total} onChange={setPage} />
          </div>
        )}
      </Modal>
    </Card>
  );
}
