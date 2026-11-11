'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, CalendarPlus, Camera, Download, Eye, HardDrive, ImageIcon, MapPin, Users } from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Progress, Skeleton, Stat, statusTone } from '@/components/ui';
import { get, type EventItem, type Paged } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { bytes, date, label, num } from '@/lib/format';

interface MyStats { events: number; photos: number; storageBytes: number; quotaBytes: number | null; failedPhotos: number; processingPhotos: number; galleryViews: number; downloads: number }
interface PlatformStats { users: number; photographers: number; events: number; photos: number; storageBytes: number; activeGalleries: number; expiredGalleries: number; downloads: number; visitorsLast30Days: number; failedPhotos: number; processingPhotos: number }

export default function Overview() {
  const { data: user } = useMe();
  const isAdmin = user?.role === 'admin';
  const mine = useQuery({ queryKey: ['stats-me'], queryFn: () => get<MyStats>('/stats/me'), enabled: can(user, 'stats:view') });
  const platform = useQuery({ queryKey: ['stats-platform'], queryFn: () => get<PlatformStats>('/admin/stats'), enabled: isAdmin });
  const recent = useQuery({ queryKey: ['events', 'recent'], queryFn: () => get<Paged<EventItem>>('/events?pageSize=6'), enabled: can(user, 'events:view') });

  if (!user) return <Loading />;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const statsLoading = isAdmin ? platform.isLoading : mine.isLoading;
  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.name.split(' ')[0]}`}
        description={isAdmin ? "Here's what's happening across the platform." : "Here's an overview of your events and photographs."}
        actions={can(user, 'events:create') && <Link href="/console/events?new=1"><Button variant="primary"><CalendarPlus className="size-4" /> New event</Button></Link>}
      />

      {statsLoading && (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)}
        </div>
      )}
      {isAdmin && platform.data ? (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <Stat icon={Camera} label="Photographers" value={num(platform.data.photographers)} sub={`${num(platform.data.users)} users`} />
          <Stat icon={CalendarDays} label="Events" value={num(platform.data.events)} sub={`${platform.data.activeGalleries} active · ${platform.data.expiredGalleries} expired`} />
          <Stat icon={ImageIcon} label="Photographs" value={num(platform.data.photos)} sub={platform.data.failedPhotos ? `${platform.data.failedPhotos} failed` : `${platform.data.processingPhotos} processing`} />
          <Stat icon={HardDrive} label="Storage used" value={bytes(platform.data.storageBytes)} />
          <Stat icon={Download} label="Downloads" value={num(platform.data.downloads)} />
          <Stat icon={Users} label="Visitors (30d)" value={num(platform.data.visitorsLast30Days)} />
        </div>
      ) : (
        mine.data && (
          <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat icon={CalendarDays} label="Events" value={num(mine.data.events)} />
            <Stat icon={ImageIcon} label="Photographs" value={num(mine.data.photos)} sub={mine.data.processingPhotos ? `${mine.data.processingPhotos} processing` : mine.data.failedPhotos ? `${mine.data.failedPhotos} failed` : undefined} />
            <Stat icon={Eye} label="Gallery views" value={num(mine.data.galleryViews)} />
            <Card className="p-5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] font-medium text-muted">Storage</p>
                <span className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent"><HardDrive className="size-4" aria-hidden /></span>
              </div>
              <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums">{bytes(mine.data.storageBytes)}</p>
              {mine.data.quotaBytes ? (
                <div className="mt-3 space-y-1.5">
                  <Progress value={(mine.data.storageBytes / mine.data.quotaBytes) * 100} tone={mine.data.storageBytes / mine.data.quotaBytes > 0.9 ? 'danger' : mine.data.storageBytes / mine.data.quotaBytes > 0.75 ? 'warning' : 'accent'} />
                  <p className="text-xs text-muted">of {bytes(mine.data.quotaBytes)}</p>
                </div>
              ) : null}
            </Card>
          </div>
        )
      )}

      <Card>
        <CardHeader
          title="Recent events"
          description="Your latest events at a glance"
          action={<Link href="/console/events" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">View all <ArrowRight className="size-3.5" /></Link>}
        />
        {recent.isLoading ? (
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="aspect-[16/11] rounded-xl" />)}</div>
        ) : recent.data?.items.length ? (
          <ul className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {recent.data.items.map((e) => (
              <li key={e.id}>
                <Link href={`/console/events/${e.id}`} className="group block overflow-hidden rounded-xl border border-border bg-surface transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop">
                  <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-accent/15 via-surface-2 to-fuchsia-500/10">
                    {e.coverUrl ? (
                      <img src={e.coverUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    ) : (
                      <span className="absolute inset-0 grid place-items-center text-accent/50"><ImageIcon className="size-8" aria-hidden /></span>
                    )}
                    <span className="absolute left-3 top-3"><Badge tone={statusTone(e.status)} dot>{label(e.status)}</Badge></span>
                  </div>
                  <div className="space-y-1 p-4">
                    <p className="truncate font-semibold tracking-tight group-hover:text-accent">{e.name}</p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" aria-hidden />{date(e.eventDate)}</span>
                      {e.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{e.location}</span></span>}
                      <span className="inline-flex items-center gap-1"><ImageIcon className="size-3.5" aria-hidden />{num(e.readyCount ?? 0)}</span>
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={CalendarPlus}
            title="No events yet"
            description="Create your first event to start uploading photographs."
            action={can(user, 'events:create') && <Link href="/console/events?new=1"><Button variant="primary"><CalendarPlus className="size-4" /> New event</Button></Link>}
          />
        )}
      </Card>
    </>
  );
}
