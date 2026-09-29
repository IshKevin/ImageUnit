'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, Download, MapPin, Search, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Input } from '@/components/ui';
import { get, post, qs, type Paged } from '@/lib/api';
import { date } from '@/lib/format';

export interface PublicEvent {
  name: string;
  slug: string;
  description: string;
  eventDate: string | null;
  location: string | null;
  expiresAt: string | null;
  downloadPolicy: 'disabled' | 'preview' | 'full';
  coverUrl: string | null;
  galleries: { id: string; name: string; description: string; photoCount: number }[];
}
interface PublicPhoto { id: string; filename: string; width: number | null; height: number | null; thumbUrl: string; previewUrl: string; downloadable: boolean }

export function GalleryClient({ slug, event }: { slug: string; event: PublicEvent }) {
  const [galleryId, setGalleryId] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { void post(`/public/events/${slug}/view`).catch(() => {}); }, [slug]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);

  const photos = useInfiniteQuery({
    queryKey: ['public-photos', slug, galleryId, debounced],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => get<Paged<PublicPhoto>>(`/public/events/${slug}/photos${qs({ galleryId, q: debounced, page: pageParam, pageSize: 60 })}`),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const items = photos.data?.pages.flatMap((p) => p.items) ?? [];
  const total = photos.data?.pages[0]?.total ?? 0;

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && photos.hasNextPage && !photos.isFetchingNextPage && void photos.fetchNextPage(), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [photos]);

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: event.name, url }).catch(() => {});
    else { await navigator.clipboard.writeText(url); toast.success('Link copied'); }
  };

  return (
    <div className="min-h-screen">
      <header className="relative isolate overflow-hidden border-b border-border">
        {event.coverUrl && <img src={event.coverUrl} alt="" aria-hidden className="absolute inset-0 -z-10 size-full scale-110 object-cover opacity-25 blur-2xl" />}
        <div className="mx-auto max-w-7xl px-4 py-10 sm:py-14">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{event.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
            {event.eventDate && <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" />{date(event.eventDate)}</span>}
            {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" />{event.location}</span>}
            <span>{total.toLocaleString()} photos</span>
          </div>
          {event.description && <p className="mt-4 max-w-2xl text-sm leading-relaxed">{event.description}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button onClick={share}><Share2 className="size-4" /> Share</Button>
            {event.expiresAt && <span className="text-xs text-muted">Available until {date(event.expiresAt)}</span>}
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Galleries">
            {event.galleries.length > 1 && [{ id: '', name: 'All' }, ...event.galleries].map((g) => (
              <button key={g.id} role="tab" aria-selected={galleryId === g.id} onClick={() => setGalleryId(g.id)} className={clsx('whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium', galleryId === g.id ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-2')}>{g.name}</button>
            ))}
          </div>
          <div className="relative w-40 shrink-0 sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" />
            <Input className="h-10 rounded-full pl-9" placeholder="Search by file name" aria-label="Search photos" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-2 py-3 sm:px-4">
        {photos.isLoading ? (
          <div className="columns-2 gap-2 md:columns-3 lg:columns-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="mb-2 animate-pulse rounded-lg bg-surface-2" style={{ aspectRatio: i % 3 ? '4/3' : '3/4' }} />)}</div>
        ) : items.length === 0 ? (
          <p className="py-24 text-center text-muted">{debounced ? 'No photos match your search.' : 'No photos to show yet.'}</p>
        ) : (
          <ul className="columns-2 gap-2 md:columns-3 lg:columns-4">
            {items.map((p, i) => (
              <li key={p.id} className="mb-2 break-inside-avoid">
                <button onClick={() => setOpenIndex(i)} className="block w-full overflow-hidden rounded-lg bg-surface-2" aria-label={`Open ${p.filename}`}>
                  <img src={p.thumbUrl} alt={p.filename} loading="lazy" decoding="async" width={p.width ?? undefined} height={p.height ?? undefined} style={{ aspectRatio: p.width && p.height ? `${p.width}/${p.height}` : undefined }} className="h-auto w-full object-cover transition-transform hover:scale-[1.02]" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div ref={sentinel} className="h-10" />
        {photos.isFetchingNextPage && <p className="py-4 text-center text-sm text-muted">Loading more…</p>}
      </main>

      {openIndex !== null && items[openIndex] && (
        <Lightbox items={items} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} onNearEnd={() => photos.hasNextPage && void photos.fetchNextPage()} />
      )}
    </div>
  );
}

function Lightbox({ items, index, onIndex, onClose, onNearEnd }: { items: PublicPhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void; onNearEnd: () => void }) {
  const photo = items[index]!;
  const go = useCallback((d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); if (items.length - n < 6) onNearEnd(); }, [index, items.length, onIndex, onNearEnd]);

  useEffect(() => { void post(`/public/photos/${photo.id}/view`).catch(() => {}); }, [photo.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [go, onClose]);
  // Warm the neighbours.
  useEffect(() => { for (const n of [items[index + 1], items[index - 1]]) if (n) new Image().src = n.previewUrl; }, [index, items]);

  const touch = useRef<number | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-label={photo.filename} className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white" onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)} onTouchEnd={(e) => { if (touch.current !== null) { const dx = e.changedTouches[0]!.clientX - touch.current; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); touch.current = null; } }}>
      <div className="flex items-center justify-between px-4 py-3">
        <span className="truncate text-sm text-white/70">{index + 1} / {items.length}+ · {photo.filename}</span>
        <div className="flex items-center gap-1">
          {photo.downloadable && <a href={`/api/public/photos/${photo.id}/download`} download className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm hover:bg-white/10"><Download className="size-4" /> Download</a>}
          <button onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-lg hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <button onClick={() => go(-1)} disabled={index === 0} aria-label="Previous photo" className="absolute left-2 z-10 hidden size-11 place-items-center rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-0 sm:grid"><ChevronLeft className="size-6" /></button>
        <img key={photo.id} src={photo.previewUrl} alt={photo.filename} className="max-h-full max-w-full object-contain" />
        <button onClick={() => go(1)} disabled={index === items.length - 1} aria-label="Next photo" className="absolute right-2 z-10 hidden size-11 place-items-center rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-0 sm:grid"><ChevronRight className="size-6" /></button>
      </div>
    </div>
  );
}
