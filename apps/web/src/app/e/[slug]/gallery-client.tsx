'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Aperture, CalendarDays, ChevronLeft, ChevronRight, Clock, Download, ImageIcon, MapPin, Maximize2, Play, Search, SearchX, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Input } from '@/components/ui';
import { get, post, qs, type Paged } from '@/lib/api';
import { date, displayName, duration } from '@/lib/format';

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
interface PublicPhoto { id: string; type: 'image' | 'video'; title: string | null; description: string; tags: string[]; durationSeconds: number | null; filename: string; width: number | null; height: number | null; thumbUrl: string; previewUrl: string; downloadable: boolean }

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
      <header className={clsx('relative isolate overflow-hidden', event.coverUrl ? 'flex min-h-[44vh] items-end bg-black text-white md:min-h-[56vh]' : 'border-b border-border bg-surface')}>
        {event.coverUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={event.coverUrl} alt="" fetchPriority="high" loading="eager" decoding="async" className="absolute inset-0 -z-20 size-full animate-fade-in object-cover" />
            <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-black/90 via-black/40 to-black/10" />
          </>
        ) : (
          <>
            <div aria-hidden className="absolute -left-24 -top-24 -z-10 size-96 rounded-full bg-accent/20 blur-3xl" />
            <div aria-hidden className="absolute -right-24 top-0 -z-10 size-80 rounded-full bg-fuchsia-500/15 blur-3xl" />
          </>
        )}
        <div className={clsx('mx-auto w-full max-w-7xl px-4 sm:px-6', event.coverUrl ? 'pb-8 pt-20 sm:pb-12' : 'py-12 sm:py-16')}>
          <p className={clsx('mb-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium', event.coverUrl ? 'bg-white/15 text-white ring-1 ring-white/20 backdrop-blur' : 'bg-accent/10 text-accent')}>
            <Aperture className="size-3.5" aria-hidden /> Event gallery
          </p>
          <h1 className="max-w-4xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">{event.name}</h1>
          <div className={clsx('mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm', event.coverUrl ? 'text-white/85' : 'text-muted')}>
            {event.eventDate && <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{date(event.eventDate)}</span>}
            {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" aria-hidden />{event.location}</span>}
            <span className="inline-flex items-center gap-1.5"><ImageIcon className="size-4" aria-hidden />{total.toLocaleString()} {total === 1 ? 'item' : 'items'}</span>
          </div>
          {event.description && <p className={clsx('mt-4 max-w-2xl text-[15px] leading-relaxed', event.coverUrl ? 'text-white/85' : 'text-muted')}>{event.description}</p>}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button onClick={share} className={clsx('inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-medium transition-all active:scale-[0.98]', event.coverUrl ? 'bg-white text-black hover:bg-white/90' : 'bg-accent text-accent-fg shadow-sm shadow-accent/25 hover:bg-accent-strong')}>
              <Share2 className="size-4" /> Share gallery
            </button>
            {event.expiresAt && <span className={clsx('inline-flex items-center gap-1.5 text-xs', event.coverUrl ? 'text-white/75' : 'text-muted')}><Clock className="size-3.5" aria-hidden />Available until {date(event.expiresAt)}</span>}
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" role="tablist" aria-label="Galleries">
            {event.galleries.length > 1 && [{ id: '', name: 'All', photoCount: undefined as number | undefined }, ...event.galleries].map((g) => (
              <button key={g.id} role="tab" aria-selected={galleryId === g.id} onClick={() => setGalleryId(g.id)} className={clsx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all', galleryId === g.id ? 'bg-fg text-bg shadow-card' : 'bg-surface text-muted ring-1 ring-border hover:text-fg hover:ring-border-strong')}>
                {g.name}
                {g.photoCount != null && <span className={clsx('text-xs tabular-nums', galleryId === g.id ? 'opacity-70' : 'text-muted/80')}>{g.photoCount}</span>}
              </button>
            ))}
          </div>
          <div className="relative w-44 shrink-0 sm:w-64">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="h-10 rounded-full pl-10" placeholder="Search photos" aria-label="Search photos and videos" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-2 py-4 sm:px-6 sm:py-6">
        {photos.isLoading ? (
          <div className="columns-2 gap-2 sm:gap-3 md:columns-3 lg:columns-4">{Array.from({ length: 12 }).map((_, i) => <div key={i} className="mb-2 animate-pulse rounded-xl bg-surface-2 sm:mb-3" style={{ aspectRatio: i % 3 ? '4/3' : '3/4' }} />)}</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <span className="grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent ring-8 ring-accent/5">{debounced ? <SearchX className="size-6" /> : <ImageIcon className="size-6" />}</span>
            <p className="font-semibold">{debounced ? 'Nothing matches your search' : 'No photos yet'}</p>
            <p className="max-w-xs text-sm text-muted">{debounced ? 'Try another word, or clear the search to see everything.' : 'Photos and videos will appear here as soon as they are published.'}</p>
            {debounced && <Button size="sm" onClick={() => setSearch('')}>Clear search</Button>}
          </div>
        ) : (
          <ul className="columns-2 gap-2 sm:gap-3 md:columns-3 lg:columns-4">
            {items.map((p, i) => (
              <li key={p.id} className="mb-2 break-inside-avoid sm:mb-3">
                <button onClick={() => setOpenIndex(i)} className="group block w-full overflow-hidden rounded-xl bg-surface-2" aria-label={`Open ${displayName(p)}${p.type === 'video' ? ' (video)' : ''}`}>
                  <span className="relative block">
                    <img src={p.thumbUrl} alt={displayName(p)} loading="lazy" decoding="async" width={p.width ?? undefined} height={p.height ?? undefined} style={{ aspectRatio: p.width && p.height ? `${p.width}/${p.height}` : undefined }} className="h-auto w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
                    <span aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    {p.type !== 'video' && <span aria-hidden className="pointer-events-none absolute bottom-2 right-2 grid size-8 place-items-center rounded-full bg-white/90 text-black opacity-0 shadow transition-all duration-300 group-hover:opacity-100"><Maximize2 className="size-3.5" /></span>}
                    {p.type === 'video' && (
                      <>
                        <span className="pointer-events-none absolute inset-0 grid place-items-center"><span className="grid size-12 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/30 backdrop-blur transition-transform group-hover:scale-110"><Play className="size-5 fill-current" aria-hidden /></span></span>
                        {p.durationSeconds != null && <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">{duration(p.durationSeconds)}</span>}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div ref={sentinel} className="h-10" />
        {photos.isFetchingNextPage && <p className="py-4 text-center text-sm text-muted">Loading more…</p>}
      </main>

      <footer className="border-t border-border py-8 text-center text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><Aperture className="size-3.5" aria-hidden /> Shared with ImageUnit</span>
      </footer>

      {openIndex !== null && items[openIndex] && (
        <Lightbox event={event} items={items} total={total} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} onNearEnd={() => photos.hasNextPage && void photos.fetchNextPage()} />
      )}
    </div>
  );
}

function Lightbox({ event, items, total, index, onIndex, onClose, onNearEnd }: { event: PublicEvent; items: PublicPhoto[]; total: number; index: number; onIndex: (i: number) => void; onClose: () => void; onNearEnd: () => void }) {
  const photo = items[index]!;
  const name = displayName(photo);
  const videoRef = useRef<HTMLVideoElement>(null);
  const go = useCallback((d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); if (items.length - n < 6) onNearEnd(); }, [index, items.length, onIndex, onNearEnd]);

  useEffect(() => { void post(`/public/photos/${photo.id}/view`).catch(() => {}); }, [photo.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [go, onClose]);
  // Warm the neighbours (images only; videos load on demand) and stop playback when leaving a video.
  useEffect(() => { for (const n of [items[index + 1], items[index - 1]]) if (n && n.type !== 'video') new Image().src = n.previewUrl; }, [index, items]);
  useEffect(() => { const v = videoRef.current; return () => v?.pause(); }, [photo.id]);

  const touch = useRef<number | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-black/95 text-white backdrop-blur" onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)} onTouchEnd={(e) => { if (touch.current !== null) { const dx = e.changedTouches[0]!.clientX - touch.current; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); touch.current = null; } }}>
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex min-w-0 items-center gap-3 text-sm"><span className="shrink-0 rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium tabular-nums">{index + 1} / {Math.max(total, items.length)}</span><span className="truncate text-white/70">{name}</span></span>
        <div className="flex items-center gap-1">
          {photo.downloadable && <a href={`/api/public/photos/${photo.id}/download`} download className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-white/90"><Download className="size-4" /> <span className="hidden sm:inline">Download</span></a>}
          <button onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-full transition-colors hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <button onClick={() => go(-1)} disabled={index === 0} aria-label="Previous item" className="absolute left-3 z-10 hidden size-12 place-items-center rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-0 sm:grid"><ChevronLeft className="size-6" /></button>
        {photo.type === 'video' ? (
          <video key={photo.id} ref={videoRef} controls playsInline preload="metadata" poster={photo.thumbUrl} src={photo.previewUrl} aria-label={name} className="max-h-full max-w-full bg-black object-contain" />
        ) : (
          <img key={photo.id} src={photo.previewUrl} alt={photo.description || name} className="max-h-full max-w-full animate-fade-in rounded-sm object-contain" />
        )}
        <button onClick={() => go(1)} disabled={index === items.length - 1} aria-label="Next item" className="absolute right-3 z-10 hidden size-12 place-items-center rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-0 sm:grid"><ChevronRight className="size-6" /></button>
      </div>
      <div className="max-h-[28vh] space-y-1.5 overflow-y-auto px-4 pb-4 text-sm">
        {photo.title?.trim() && <p className="text-base font-medium">{photo.title}</p>}
        {photo.description && <p className="max-w-3xl whitespace-pre-line text-white/80">{photo.description}</p>}
        {photo.tags.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Tags">{photo.tags.map((t) => <li key={t} className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs">{t}</li>)}</ul>}
        <p className="flex flex-wrap gap-x-4 text-xs text-white/60">
          <span>{event.name}</span>
          {event.eventDate && <span>{date(event.eventDate)}</span>}
          {event.location && <span>{event.location}</span>}
        </p>
      </div>
    </div>
  );
}
