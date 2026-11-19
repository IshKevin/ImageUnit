'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Check, CheckSquare, Eye, EyeOff, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { UploadPanel } from '../upload-panel';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, Pagination, Select, Spinner, Textarea, statusTone } from '../ui';
import { api, get, patch, post, qs, type EventItem, type Gallery, type Paged, type Photo } from '@/lib/api';
import { bytes, displayName, duration, label } from '@/lib/format';
import { useMe } from '@/lib/auth';
import { useGridSelection } from '@/lib/use-grid-selection';

/** Most items one bulk request may carry (the API's limits); bigger selections are sent in chunks. */
const MOVE_CHUNK = 1000;
const DELETE_CHUNK = 500;

async function inChunks(ids: string[], size: number, fn: (chunk: string[]) => Promise<unknown>) {
  for (let i = 0; i < ids.length; i += size) await fn(ids.slice(i, i + size));
}

interface Summary { pending_upload: number; uploaded: number; processing: number; ready: number; failed: number; total: number }

export function PhotosTab({ event }: { event: EventItem }) {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const [galleryId, setGalleryId] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState<'' | 'image' | 'video'>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Photo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const eid = event.id;
  const contributor = event.myAccess === 'contribute';

  const galleries = useQuery({ queryKey: ['galleries', eid], queryFn: () => get<{ items: Gallery[] }>(`/events/${eid}/galleries`) });
  const summary = useQuery({
    queryKey: ['summary', eid],
    queryFn: () => get<Summary>(`/events/${eid}/upload-summary`),
    // Poll while anything is still moving through the pipeline.
    refetchInterval: (q) => (q.state.data && q.state.data.uploaded + q.state.data.processing > 0 ? 3000 : false),
  });
  const active = (summary.data?.uploaded ?? 0) + (summary.data?.processing ?? 0) > 0;
  // When processing finishes the summary stops polling; refresh the grid once more so it never shows stale placeholders.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) void qc.invalidateQueries({ queryKey: ['photos', eid] });
    wasActive.current = active;
  }, [active, eid, qc]);
  const photos = useQuery({
    queryKey: ['photos', eid, galleryId, status, type, page],
    queryFn: () => get<Paged<Photo>>(`/events/${eid}/photos${qs({ galleryId, status, type, page, pageSize: 60 })}`),
    placeholderData: (p) => p,
    refetchInterval: active ? 4000 : false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['photos', eid] });
    void qc.invalidateQueries({ queryKey: ['summary', eid] });
    void qc.invalidateQueries({ queryKey: ['galleries', eid] });
  };

  const retryAll = useMutation({ mutationFn: () => post<{ retried: number }>(`/events/${eid}/photos/retry-failed`), onSuccess: (r) => { toast.success(`Retrying ${r.retried} photographs`); refresh(); } });
  const retryOne = useMutation({ mutationFn: (id: string) => post(`/photos/${id}/retry`), onSuccess: () => { toast.success('Retrying'); setOpen(null); refresh(); }, onError: (e) => toast.error(e.message) });
  const bulk = useMutation({
    mutationFn: (body: { galleryId?: string | null; isHidden?: boolean }) => inChunks([...selected], MOVE_CHUNK, (photoIds) => post(`/events/${eid}/photos/bulk`, { photoIds, ...body })),
    onSuccess: (_r, body) => {
      const n = selected.size.toLocaleString();
      toast.success(body.galleryId ? `Moved ${n} item(s)` : body.isHidden ? `Hid ${n} item(s)` : `${n} item(s) are visible again`);
      setSelected(new Set());
      refresh();
    },
    onError: (e) => { toast.error(e.message); refresh(); },
  });
  const remove = useMutation({
    mutationFn: () => inChunks([...selected], DELETE_CHUNK, (photoIds) => post(`/events/${eid}/photos/delete`, { photoIds })),
    onSuccess: () => { toast.success('Photographs permanently deleted'); setSelected(new Set()); setConfirmDelete(false); refresh(); },
    onError: (e) => { toast.error(e.message); refresh(); },
  });
  // "Select all" across every page of the current view.
  const selectAll = useMutation({
    mutationFn: () => get<{ ids: string[] }>(`/events/${eid}/photo-ids${qs({ galleryId, status, type })}`),
    onSuccess: (r) => setSelected(new Set(r.ids)),
    onError: (e) => toast.error(e.message),
  });
  const setCover = useMutation({ mutationFn: (id: string) => patch(`/events/${eid}`, { coverPhotoId: id }), onSuccess: () => { toast.success('Cover photo updated'); void qc.invalidateQueries({ queryKey: ['event', eid] }); } });

  const s = summary.data;
  const canUpload = !!user?.permissions.includes('images:upload');
  const canEdit = !!user?.permissions.includes('media:edit');
  const canEditPhoto = (p: Photo) => (contributor ? p.uploaderId === user?.id : canEdit);
  const shown = photos.data?.items ?? [];
  const uploadsOpen = ['draft', 'active'].includes(event.status);
  const total = photos.data?.total ?? 0;

  const clearSelection = () => setSelected(new Set());
  const sel = useGridSelection({
    ids: shown.map((p) => p.id),
    isSelected: (id) => selected.has(id),
    apply: (on, off) => setSelected((cur) => { const n = new Set(cur); on.forEach((id) => n.add(id)); off.forEach((id) => n.delete(id)); return n; }),
    clear: clearSelection,
    count: selected.size,
    enabled: !contributor,
  });
  const pageAll = shown.length > 0 && shown.every((p) => selected.has(p.id));
  const togglePage = () => setSelected((cur) => { const n = new Set(cur); shown.forEach((p) => (pageAll ? n.delete(p.id) : n.add(p.id))); return n; });
  // A different view starts a fresh selection, so nothing out of sight stays selected (and gets moved or deleted by surprise).
  const changeView = (fn: () => void) => { fn(); setPage(1); clearSelection(); };

  return (
    <div className="space-y-6">
      {canUpload ? (
        <UploadPanel eventId={eid} galleryId={galleryId || undefined} onSettled={refresh} disabled={!uploadsOpen} />
      ) : (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">You don&apos;t have permission to upload photos or videos to this event.</p>
      )}

      {s && s.total > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
          <Badge tone="success">{s.ready} ready</Badge>
          {s.uploaded + s.processing > 0 && <Badge tone="accent"><Spinner className="mr-1 size-3" />{s.uploaded + s.processing} processing</Badge>}
          {s.pending_upload > 0 && <Badge>{s.pending_upload} awaiting upload</Badge>}
          {s.failed > 0 && (<><Badge tone="danger">{s.failed} failed</Badge>{!contributor && <Button size="sm" onClick={() => retryAll.mutate()} loading={retryAll.isPending}><RotateCcw className="size-3.5" /> Retry failed</Button>}</>)}
          {active && <span className="text-muted">Processing continues in the background — you can leave this page.</span>}
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <Select className="w-48" value={galleryId} onChange={(e) => changeView(() => setGalleryId(e.target.value))} aria-label="Gallery">
            <option value="">All galleries</option>
            {galleries.data?.items.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.photoCount})</option>)}
          </Select>
          <Select className="w-40" value={status} onChange={(e) => changeView(() => setStatus(e.target.value))} aria-label="Status">
            <option value="">Any status</option>
            {['ready', 'processing', 'uploaded', 'failed', 'pending_upload'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
          </Select>
          <Select className="w-36" value={type} onChange={(e) => changeView(() => setType(e.target.value as '' | 'image' | 'video'))} aria-label="Type">
            <option value="">Photos &amp; videos</option>
            <option value="image">Photos</option>
            <option value="video">Videos</option>
          </Select>
          {!contributor && shown.length > 0 && (
            <Button size="sm" className="ml-auto" aria-pressed={pageAll} onClick={togglePage}>
              <CheckSquare className="size-3.5" /> {pageAll ? 'Deselect page' : 'Select page'}
            </Button>
          )}
        </div>

        {!contributor && selected.size > 0 && (
          <div role="region" aria-label="Selected items" className="sticky top-2 z-10 mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-surface px-3 py-2 shadow-md">
            <span className="text-sm font-medium tabular-nums" aria-live="polite">{selected.size.toLocaleString()} selected</span>
            {total > shown.length && selected.size < total && (
              <Button size="sm" variant="ghost" loading={selectAll.isPending} onClick={() => selectAll.mutate()}>Select all {total.toLocaleString()}</Button>
            )}
            <span className="hidden flex-1 sm:block" />
            <Select className="h-8 w-40 text-xs" value="" disabled={bulk.isPending} onChange={(e) => e.target.value && bulk.mutate({ galleryId: e.target.value })} aria-label="Move to gallery">
              <option value="">Move to…</option>
              {galleries.data?.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
            <Button size="sm" loading={bulk.isPending && bulk.variables?.isHidden === true} disabled={bulk.isPending} onClick={() => bulk.mutate({ isHidden: true })}><EyeOff className="size-3.5" /> Hide</Button>
            <Button size="sm" loading={bulk.isPending && bulk.variables?.isHidden === false} disabled={bulk.isPending} onClick={() => bulk.mutate({ isHidden: false })}><Eye className="size-3.5" /> Show</Button>
            {user?.role === 'admin' && <Button size="sm" variant="danger" disabled={bulk.isPending} onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" /> Delete</Button>}
            <Button size="sm" variant="ghost" onClick={clearSelection}><X className="size-3.5" /> Clear</Button>
          </div>
        )}
        {!contributor && shown.length > 0 && (
          <p className="hidden px-4 pt-3 text-xs text-muted sm:block">
            Tip: drag across photos to select many at once · Shift-click selects a range · Ctrl/⌘-click adds one · Esc clears
          </p>
        )}

        {photos.isLoading ? <Loading /> : shown.length ? (
          <>
            <ul className="grid select-none grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-6">
              {shown.map((p, i) => {
                const isSel = selected.has(p.id);
                return (
                <li key={p.id} {...sel.tileProps(i)} className={clsx('group relative aspect-square overflow-hidden rounded-lg bg-surface-2 transition-shadow', isSel && 'ring-[3px] ring-accent ring-offset-2 ring-offset-surface')}>
                  <button
                    onClick={(e) => { if (!sel.handleTileClick(e, i)) setOpen(p); }}
                    className="absolute inset-0"
                    aria-label={sel.selecting && !contributor ? `${isSel ? 'Deselect' : 'Select'} ${displayName(p)}` : `Open ${displayName(p)}${p.mediaType === 'video' ? ' (video)' : ''}`}
                  >
                    {p.thumbUrl ? <img src={p.thumbUrl} alt={displayName(p)} loading="lazy" draggable={false} className={clsx('size-full object-cover transition-transform duration-150', p.isHidden && 'opacity-40', isSel && 'scale-[0.94]')} /> : (
                      <span className="grid size-full place-items-center p-2 text-center text-xs text-muted">
                        {p.status === 'failed' ? <AlertTriangle className="size-5 text-danger" /> : <Spinner />}
                        <span className="mt-1 line-clamp-2 break-all">{displayName(p)}</span>
                      </span>
                    )}
                  </button>
                  {!contributor && (
                    // A large target (the whole corner) around a small visible check mark; always shown while selecting.
                    <button
                      type="button"
                      {...sel.checkboxProps(i)}
                      aria-pressed={isSel}
                      aria-label={`Select ${displayName(p)}`}
                      className={clsx('absolute left-0 top-0 grid size-11 place-items-center transition-opacity focus-visible:opacity-100', isSel || sel.selecting ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100')}
                    >
                      <span className={clsx('grid size-6 place-items-center rounded-full border-2 shadow transition', isSel ? 'border-accent bg-accent text-accent-fg' : 'border-white bg-black/35 text-white/0 hover:text-white/80')}>
                        <Check className="size-3.5" />
                      </span>
                    </button>
                  )}
                  {event.coverPhotoId === p.id && <span className="pointer-events-none absolute right-1.5 bottom-6"><Badge tone="accent">Cover</Badge></span>}
                  {p.mediaType === 'video' && p.thumbUrl && (
                    <span className="pointer-events-none absolute inset-0 grid place-items-center">
                      <span className="grid size-9 place-items-center rounded-full bg-black/55 text-white"><Play className="size-4 fill-current" aria-label="Video" /></span>
                    </span>
                  )}
                  {p.mediaType === 'video' && p.durationSeconds != null && <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">{duration(p.durationSeconds)}</span>}
                  {p.status !== 'ready' && <span className="absolute bottom-1.5 left-1.5"><Badge tone={statusTone(p.status)}>{label(p.status)}</Badge></span>}
                  {p.status === 'ready' && <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] text-white" style={{ paddingRight: p.mediaType === 'video' ? '3.5rem' : undefined }}>{displayName(p)}</span>}
                  {p.isHidden && <EyeOff className="absolute right-1.5 top-1.5 size-4 text-white drop-shadow" aria-label="Hidden" />}
                </li>
                );
              })}
            </ul>
            <Pagination page={photos.data!.page} pageSize={photos.data!.pageSize} total={photos.data!.total} onChange={setPage} /* the selection is kept across pages */ />
          </>
        ) : <EmptyState title={type || photos.data?.items.length ? 'Nothing matches this filter' : 'No photos or videos yet'} description="Upload photos and videos above. They are processed in the background." />}
      </Card>

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? displayName(open) : ''} wide>
        {open && (
          <div className="space-y-4">
            {open.previewUrl ? (open.mediaType === 'video' ? <video key={open.id} controls playsInline preload="metadata" poster={open.thumbUrl ?? undefined} src={open.previewUrl} className="max-h-[60vh] w-full rounded-lg bg-black" /> : <img src={open.previewUrl} alt={displayName(open)} className="max-h-[60vh] w-full rounded-lg object-contain" />) : <p className="rounded-lg bg-surface-2 p-8 text-center text-sm text-muted">{open.status === 'failed' ? 'Processing failed' : open.mediaType === 'video' ? 'Video is still being converted — this can take a few minutes' : 'Preview not ready yet'}</p>}
            <MediaForm key={open.id} photo={open} canEdit={canEditPhoto(open)} onSaved={(p) => { setOpen((cur) => (cur ? p : cur)); refresh(); }} /* never reopen a dialog the user already closed */ />
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted">File</dt><dd className="break-all">{open.filename}</dd>
              <dt className="text-muted">Type</dt><dd>{open.mediaType === 'video' ? 'Video' : 'Photo'}</dd>
              {open.mediaType === 'video' && open.durationSeconds != null && (<><dt className="text-muted">Duration</dt><dd>{duration(open.durationSeconds)}</dd></>)}
              <dt className="text-muted">Status</dt><dd><Badge tone={statusTone(open.status)}>{label(open.status)}</Badge></dd>
              <dt className="text-muted">Size</dt><dd>{bytes(open.sizeBytes)}</dd>
              {open.width && (<><dt className="text-muted">Dimensions</dt><dd>{open.width} × {open.height}</dd></>)}
            </dl>
            {open.error && <ErrorNote error={new Error(open.error)} />}
            <div className="flex flex-wrap justify-end gap-2">
              {open.status === 'failed' && (!contributor || open.uploaderId === user?.id) && <Button onClick={() => retryOne.mutate(open.id)} loading={retryOne.isPending}><RotateCcw className="size-4" /> Retry processing</Button>}
              {!contributor && open.status === 'ready' && <Button onClick={() => setCover.mutate(open.id)}>Set as cover</Button>}
              {open.status !== 'pending_upload' && <Button onClick={async () => { const r = await api<{ url: string }>(`/photos/${open.id}/original`); window.open(r.url, '_blank'); }}>Download original</Button>}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger title="Permanently delete photos and videos?" message={`${selected.size.toLocaleString()} item(s) and all their versions will be permanently removed from storage. This cannot be undone and is recorded in the audit log.`} confirmLabel="Delete permanently" />
    </div>
  );
}

function MediaForm({ photo, canEdit, onSaved }: { photo: Photo; canEdit: boolean; onSaved: (p: Photo) => void }) {
  const [title, setTitle] = useState(photo.title ?? '');
  const [description, setDescription] = useState(photo.description ?? '');
  const [tags, setTags] = useState<string[]>(photo.tags ?? []);
  const [draft, setDraft] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const pending = draft.trim().replace(/,$/, '');
      const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
      return patch(`/photos/${photo.id}`, { title: title.trim() || null, description: description.trim(), tags: finalTags }).then(() => ({ finalTags }));
    },
    onSuccess: ({ finalTags }) => {
      toast.success('Details saved');
      setTags(finalTags);
      setDraft('');
      onSaved({ ...photo, title: title.trim() || null, description: description.trim(), tags: finalTags });
    },
    onError: (e) => toast.error(e.message),
  });
  const addTag = () => {
    const fresh = draft.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x && !tags.includes(x));
    if (fresh.length) setTags([...tags, ...new Set(fresh)]);
    setDraft('');
  };

  if (!canEdit) {
    return (
      <div className="space-y-2 text-sm">
        {photo.description && <p>{photo.description}</p>}
        {photo.tags.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Tags">{photo.tags.map((t) => <li key={t}><Badge>{t}</Badge></li>)}</ul>}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
      <Field label="Name (title)" hint="Leave blank to show the file name."><Input value={title} maxLength={200} placeholder={photo.filename.replace(/\.[^.]+$/, '')} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description"><Textarea value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Tags" hint="Press Enter or comma to add a tag.">
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
              {t}
              <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="grid size-5 place-items-center rounded-full hover:bg-black/10"><X className="size-3" /></button>
            </span>
          ))}
          <input
            value={draft}
            maxLength={40}
            aria-label="Add tag"
            placeholder={tags.length ? '' : 'Add a tag'}
            onChange={(e) => {
              const v = e.target.value;
              if (v.endsWith(',')) {
                const t = v.slice(0, -1).trim();
                if (t && !tags.includes(t)) setTags([...tags, t]);
                setDraft('');
              } else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addTag(); }
              else if (e.key === 'Backspace' && !draft && tags.length) setTags(tags.slice(0, -1));
            }}
            onBlur={addTag}
            className="min-w-24 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none"
          />
        </div>
      </Field>
      <Button type="submit" variant="primary" loading={save.isPending}>Save details</Button>
    </form>
  );
}
