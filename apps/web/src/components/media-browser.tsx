'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Check, EyeOff, Film, ImageIcon, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { BulkBar } from './media/bulk-bar';
import { DetailModal } from './media/detail-modal';
import { EventPicker, useDebounced } from './media/parts';
import { Button, Card, EmptyState, ErrorNote, Input, Pagination, Select, Spinner } from './ui';
import { get, qs, type LibraryFilter, type LibraryItem, type Paged, type PhotoStatus, type Selection } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { displayName, duration } from '@/lib/format';

const PAGE_SIZE = 60;

export interface BulkExtraCtx {
  selection: Selection;
  count: number;
  clear: () => void;
  /** Ids of selected items on the current page (in grid order). */
  selectedIds: string[];
}

export interface MediaBrowserProps {
  mode: 'manage' | 'pick';
  /** Always applied; not user-editable (e.g. { collectionId } or { notInCollectionId }). */
  baseFilter?: LibraryFilter;
  /** When set, the grid lists this collection in curated order and bulk actions can target it. */
  collectionId?: string;
  onSelectionChange?: (sel: Selection | null, count: number) => void;
  /** Rendered at the end of the filter/result row (e.g. an "Add media" button). */
  toolbarExtra?: ReactNode;
  /** Extra bulk actions shown in the bulk bar (manage mode). */
  bulkExtra?: (ctx: BulkExtraCtx) => ReactNode;
}

interface UiFilter { q: string; type: '' | 'image' | 'video'; event: { id: string; name: string } | null; tag: string; status: '' | PhotoStatus; hidden: '' | 'true' | 'false'; from: string; to: string }
const EMPTY: UiFilter = { q: '', type: '', event: null, tag: '', status: '', hidden: '', from: '', to: '' };

export function MediaBrowser({ mode, baseFilter, collectionId, onSelectionChange, toolbarExtra, bulkExtra }: MediaBrowserProps) {
  const { data: user } = useMe();
  const [ui, setUi] = useState<UiFilter>(EMPTY);
  const [sort, setSort] = useState<string>(collectionId ? '' : 'newest');
  const [page, setPage] = useState(1);
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const lastIdx = useRef<number | null>(null);
  const searchId = useId();

  const dq = useDebounced(ui.q.trim(), 300);
  const dtag = useDebounced(ui.tag.trim().toLowerCase(), 300);
  const baseKey = JSON.stringify(baseFilter ?? {});

  const filter = useMemo<LibraryFilter>(() => {
    const f: LibraryFilter = {};
    if (dq) f.q = dq;
    if (ui.type) f.type = ui.type;
    if (ui.event) f.eventId = ui.event.id;
    if (dtag) f.tag = dtag;
    if (ui.status) f.status = ui.status;
    if (ui.hidden) f.hidden = ui.hidden;
    if (ui.from) f.from = ui.from;
    if (ui.to) f.to = ui.to;
    return { ...f, ...(JSON.parse(baseKey) as LibraryFilter) };
  }, [dq, dtag, ui.type, ui.event, ui.status, ui.hidden, ui.from, ui.to, baseKey]);
  const filterKey = JSON.stringify(filter);

  const clear = useCallback(() => {
    setIds(new Set());
    setAllMatching(false);
    setExcluded(new Set());
    lastIdx.current = null;
  }, []);
  // A different result set invalidates the selection and the page.
  useEffect(() => {
    clear();
    setPage(1);
  }, [filterKey, sort, clear]);

  const update = (patch: Partial<UiFilter>) => setUi((u) => ({ ...u, ...patch }));

  const list = useQuery({
    queryKey: ['media', collectionId ?? 'library', filterKey, sort, page],
    queryFn: () => get<Paged<LibraryItem>>(`${collectionId ? `/collections/${collectionId}/items` : '/library/media'}${qs({ ...filter, sort, page, pageSize: PAGE_SIZE })}`),
    placeholderData: (p) => p,
  });
  const tagSugg = useQuery({
    queryKey: ['library-tags', dtag],
    queryFn: () => get<{ items: { tag: string; n: number }[] }>(`/library/tags${qs({ q: dtag })}`),
    staleTime: 30_000,
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const isSel = (id: string) => (allMatching ? !excluded.has(id) : ids.has(id));
  const count = allMatching ? Math.max(total - excluded.size, 0) : ids.size;
  const selection = useMemo<Selection | null>(() => {
    if (allMatching) return count > 0 ? { filter, excludeIds: [...excluded] } : null;
    return ids.size ? { ids: [...ids] } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMatching, ids, excluded, filterKey, count]);

  const cb = useRef(onSelectionChange);
  cb.current = onSelectionChange;
  useEffect(() => {
    cb.current?.(selection, count);
  }, [selection, count]);

  const setOne = (id: string, on: boolean) => {
    if (allMatching) setExcluded((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n; });
    else setIds((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  };
  const toggle = (i: number, shift: boolean) => {
    const target = !isSel(items[i]!.id);
    if (shift && lastIdx.current !== null) {
      const [a, b] = [Math.min(lastIdx.current, i), Math.max(lastIdx.current, i)];
      const range = items.slice(a, b + 1).map((x) => x.id);
      if (allMatching) setExcluded((s) => { const n = new Set(s); range.forEach((id) => (target ? n.delete(id) : n.add(id))); return n; });
      else setIds((s) => { const n = new Set(s); range.forEach((id) => (target ? n.add(id) : n.delete(id))); return n; });
    } else setOne(items[i]!.id, target);
    lastIdx.current = i;
  };
  const pageAll = items.length > 0 && items.every((x) => isSel(x.id));
  const togglePage = () => {
    const pageIds = items.map((x) => x.id);
    if (allMatching) setExcluded((s) => { const n = new Set(s); pageIds.forEach((id) => (pageAll ? n.add(id) : n.delete(id))); return n; });
    else setIds((s) => { const n = new Set(s); pageIds.forEach((id) => (pageAll ? n.delete(id) : n.add(id))); return n; });
  };

  const selectedItems = items.filter((x) => isSel(x.id));
  const canEdit = can(user, 'media:edit');
  const hasFilters = JSON.stringify({ ...ui, q: '' }) !== JSON.stringify(EMPTY) || !!ui.q;
  const initial = list.isLoading;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2">
            <label htmlFor={searchId} className="sr-only">Search</label>
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden />
            <Input id={searchId} type="search" value={ui.q} onChange={(e) => update({ q: e.target.value })} placeholder="Search titles, descriptions, tags, events…" className="pl-9" />
          </div>
          <label className="block"><span className="sr-only">Type</span>
            <Select value={ui.type} onChange={(e) => update({ type: e.target.value as UiFilter['type'] })}>
              <option value="">All types</option><option value="image">Photos</option><option value="video">Videos</option>
            </Select>
          </label>
          {!baseFilter?.eventId ? <EventPicker value={ui.event} onChange={(event) => update({ event })} /> : <div />}
          <div>
            <label className="sr-only" htmlFor={`${searchId}-tag`}>Tag</label>
            <Input id={`${searchId}-tag`} list={`${searchId}-tags`} value={ui.tag} onChange={(e) => update({ tag: e.target.value })} placeholder="Filter by tag" />
            <datalist id={`${searchId}-tags`}>{tagSugg.data?.items.map((t) => <option key={t.tag} value={t.tag}>{t.n}</option>)}</datalist>
          </div>
          <label className="block"><span className="sr-only">Status</span>
            <Select value={ui.status} onChange={(e) => update({ status: e.target.value as UiFilter['status'] })}>
              <option value="">Any status</option><option value="ready">Ready</option><option value="processing">Processing</option><option value="failed">Failed</option>
            </Select>
          </label>
          <label className="block"><span className="sr-only">Visibility</span>
            <Select value={ui.hidden} onChange={(e) => update({ hidden: e.target.value as UiFilter['hidden'] })}>
              <option value="">Hidden and visible</option><option value="false">Visible only</option><option value="true">Hidden only</option>
            </Select>
          </label>
          <label className="block"><span className="sr-only">Sort</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value)}>
              {collectionId && <option value="">Curated order</option>}
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option><option value="taken">Date taken</option>
            </Select>
          </label>
          <div className="flex items-center gap-2 sm:col-span-2">
            <label className="flex flex-1 items-center gap-2 text-sm text-muted">From <Input type="date" value={ui.from} max={ui.to || undefined} onChange={(e) => update({ from: e.target.value })} /></label>
            <label className="flex flex-1 items-center gap-2 text-sm text-muted">To <Input type="date" value={ui.to} min={ui.from || undefined} onChange={(e) => update({ to: e.target.value })} /></label>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm tabular-nums text-muted" aria-live="polite">
          {initial ? 'Loading…' : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`}
          {list.isFetching && !initial && <Spinner className="ml-2 inline size-3.5 align-middle" />}
        </p>
        {hasFilters && <Button size="sm" variant="ghost" onClick={() => setUi(EMPTY)}><X className="size-4" aria-hidden />Clear filters</Button>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {items.length > 0 && <Button size="sm" aria-pressed={pageAll} onClick={togglePage}>{pageAll ? 'Deselect page' : 'Select all on this page'}</Button>}
          {toolbarExtra}
        </div>
      </div>

      {count > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-accent/10 px-4 py-2 text-sm">
          <span className="font-medium tabular-nums">{count.toLocaleString()} selected</span>
          {!allMatching && pageAll && total > items.length && (
            <>
              <span>All {items.length.toLocaleString()} on this page selected.</span>
              <button type="button" className="font-medium text-accent underline" onClick={() => { setAllMatching(true); setExcluded(new Set()); }}>Select all {total.toLocaleString()} results</button>
            </>
          )}
          {allMatching && <span>All {total.toLocaleString()} results are selected{excluded.size ? ` except ${excluded.size.toLocaleString()}` : ''}.</span>}
          <button type="button" className="ml-auto font-medium text-muted hover:text-fg" onClick={clear}>Clear</button>
        </div>
      )}

      {mode === 'manage' && selection && (
        <BulkBar
          selection={selection} count={count} selectedItems={selectedItems} clear={clear} collectionId={collectionId}
          canEdit={canEdit} canHide={can(user, 'galleries:manage')} canCollect={can(user, 'collections:manage')}
          extra={bulkExtra?.({ selection, count, clear, selectedIds: selectedItems.map((x) => x.id) })}
        />
      )}

      <ErrorNote error={list.error} />

      <Card>
        {initial ? (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6" aria-busy>
            {Array.from({ length: 12 }, (_, i) => <div key={i} className="aspect-square animate-pulse rounded-lg bg-surface-2" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={hasFilters ? 'No media matches your filters' : 'No media here yet'} description={hasFilters ? 'Try a different search or clear the filters.' : undefined} action={hasFilters ? <Button onClick={() => setUi(EMPTY)}>Clear filters</Button> : undefined} />
        ) : (
          <ul className={clsx('grid grid-cols-2 gap-3 p-4 transition-opacity sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6', list.isPlaceholderData && 'opacity-60')}>
            {items.map((m, i) => {
              const sel = isSel(m.id);
              const name = displayName(m);
              return (
                <li key={m.id} className="group relative">
                  <button type="button" onClick={() => setOpen(m)} className="block w-full text-left" aria-label={`Open details for ${name}`}>
                    <div className={clsx('relative aspect-square overflow-hidden rounded-lg border bg-surface-2', sel ? 'border-accent ring-2 ring-accent' : 'border-border')}>
                      {m.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <div className="grid size-full place-items-center text-muted">{m.mediaType === 'video' ? <Film className="size-8" aria-hidden /> : <ImageIcon className="size-8" aria-hidden />}</div>
                      )}
                      <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                        {m.isHidden && <span title="Hidden" className="rounded bg-black/65 p-1 text-white"><EyeOff className="size-3.5" aria-label="Hidden" /></span>}
                        {m.status === 'failed' && <span title="Processing failed" className="rounded bg-danger p-1 text-white"><AlertTriangle className="size-3.5" aria-label="Processing failed" /></span>}
                        {m.mediaType === 'video' && <span className="inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"><Film className="size-3" aria-hidden /><span className="sr-only">Video, </span>{duration(m.durationSeconds)}</span>}
                      </div>
                    </div>
                    <p className="mt-1.5 truncate text-sm font-medium" title={name}>{name}</p>
                    <p className="truncate text-xs text-muted">{m.event.name}</p>
                    {m.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.tags.slice(0, 2).map((t) => <span key={t} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{t}</span>)}
                        {m.tags.length > 2 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">+{m.tags.length - 2}</span>}
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-pressed={sel}
                    aria-label={`Select ${name}`}
                    onClick={(e) => toggle(i, e.shiftKey)}
                    className={clsx('absolute left-2 top-2 grid size-6 place-items-center rounded-md border shadow transition-opacity focus-visible:opacity-100', sel ? 'border-accent bg-accent text-accent-fg opacity-100' : 'border-white/80 bg-black/40 text-transparent opacity-70 group-hover:opacity-100 sm:opacity-0')}
                  >
                    <Check className="size-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={(p) => { setPage(p); lastIdx.current = null; }} />
      </Card>

      <DetailModal item={open} onClose={() => setOpen(null)} canEdit={canEdit} />
    </div>
  );
}
