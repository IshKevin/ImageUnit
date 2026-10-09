'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ImageIcon, Images } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, ErrorNote, Modal, Pagination, Spinner } from '@/components/ui';
import { get, patch, qs, type Collection, type Paged, type Photo } from '@/lib/api';

const PICK_PAGE_SIZE = 24;

export function CollectionCoverCard({ collection }: { collection: Collection }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(1);

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

  return (
    <Card>
      <CardHeader title="Cover image" />
      <div className="space-y-4 p-5">
        {collection.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={collection.coverUrl}
            alt={`Current cover image of ${collection.name}`}
            className="aspect-[16/9] w-full rounded-lg bg-surface-2 object-cover"
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
        </p>

        <div className="flex flex-wrap gap-2">
          <Button disabled={setCover.isPending} onClick={() => { setPage(1); setPicking(true); }}>
            <Images className="size-4" /> Choose from collection items
          </Button>
          {collection.coverPhotoId && (
            <Button
              variant="ghost"
              loading={setCover.isPending && setCover.variables === null}
              onClick={() => setCover.mutate(null)}
            >
              Use automatic cover
            </Button>
          )}
        </div>
      </div>

      <Modal open={picking} onClose={() => setPicking(false)} title="Choose a cover image" wide>
        <ErrorNote error={photos.error} />
        {photos.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Loading photos…</p>
        ) : photos.data && photos.data.items.length === 0 ? (
          <p className="text-sm text-muted">No processed photos in this collection yet. Add media to the collection first.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.data?.items.map((p) => {
              const current = p.id === collection.coverPhotoId;
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
