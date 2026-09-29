'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Stat, statusTone } from '@/components/ui';
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
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description={isAdmin ? 'Platform overview' : 'Your events and photographs'}
        actions={can(user, 'events:create') && <Link href="/console/events?new=1"><Button variant="primary"><CalendarPlus className="size-4" /> New event</Button></Link>}
      />

      {isAdmin && platform.data ? (
        <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Photographers" value={num(platform.data.photographers)} sub={`${num(platform.data.users)} users`} />
          <Stat label="Events" value={num(platform.data.events)} sub={`${platform.data.activeGalleries} active · ${platform.data.expiredGalleries} expired`} />
          <Stat label="Photographs" value={num(platform.data.photos)} sub={platform.data.failedPhotos ? `${platform.data.failedPhotos} failed` : `${platform.data.processingPhotos} processing`} />
          <Stat label="Storage used" value={bytes(platform.data.storageBytes)} />
          <Stat label="Downloads" value={num(platform.data.downloads)} />
          <Stat label="Visitors (30d)" value={num(platform.data.visitorsLast30Days)} />
        </div>
      ) : (
        mine.data && (
          <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Events" value={num(mine.data.events)} />
            <Stat label="Photographs" value={num(mine.data.photos)} sub={mine.data.processingPhotos ? `${mine.data.processingPhotos} processing` : mine.data.failedPhotos ? `${mine.data.failedPhotos} failed` : undefined} />
            <Stat label="Gallery views" value={num(mine.data.galleryViews)} />
            <Stat label="Storage" value={bytes(mine.data.storageBytes)} sub={mine.data.quotaBytes ? `of ${bytes(mine.data.quotaBytes)}` : undefined} />
          </div>
        )
      )}

      <Card>
        <CardHeader title="Recent events" action={<Link href="/console/events" className="text-sm text-accent hover:underline">View all</Link>} />
        {recent.isLoading ? <Loading /> : recent.data?.items.length ? (
          <ul className="divide-y divide-border">
            {recent.data.items.map((e) => (
              <li key={e.id}>
                <Link href={`/console/events/${e.id}`} className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{e.name}</p>
                    <p className="text-sm text-muted">{date(e.eventDate)} · {e.readyCount ?? 0} photos</p>
                  </div>
                  <Badge tone={statusTone(e.status)}>{label(e.status)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No events yet" description="Create your first event to start uploading photographs." />
        )}
      </Card>
    </>
  );
}
