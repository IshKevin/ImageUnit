'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ExternalLink, ImageIcon, Info, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { GalleriesTab } from '@/components/event/galleries-tab';
import { PhotosTab } from '@/components/event/photos-tab';
import { SettingsTab } from '@/components/event/settings-tab';
import { StatsTab } from '@/components/event/stats-tab';
import { DeveloperTab } from '@/components/event/developer-tab';
import { TeamTab } from '@/components/event/team-tab';
import { Badge, EmptyState, Loading, Tabs, statusTone } from '@/components/ui';
import { get, type EventItem } from '@/lib/api';
import { date, label, num } from '@/lib/format';
import { can, useMe } from '@/lib/auth';

type Tab = 'photos' | 'galleries' | 'settings' | 'stats' | 'team' | 'developer';

export default function EventDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: user } = useMe();
  const [tab, setTab] = useState<Tab>('photos');
  const { data, isLoading, error } = useQuery({ queryKey: ['event', id], queryFn: async () => (await get<{ event: EventItem }>(`/events/${id}`)).event });

  if (isLoading) return <Loading />;
  if (error || !data) return <EmptyState icon={ImageIcon} title="Event not found" description="It may have been deleted, or you may not have access." action={<Link href="/console/events" className="text-accent hover:underline">Back to events</Link>} />;
  const contributor = data.myAccess === 'contribute';
  const tabs: { id: Tab; label: string }[] = contributor ? [{ id: 'photos', label: 'Photographs' }] : [
    { id: 'photos', label: 'Photographs' },
    { id: 'galleries', label: 'Galleries' },
    { id: 'settings', label: 'Settings & sharing' },
    { id: 'team', label: 'Team' },
    ...(can(user, 'stats:view') ? [{ id: 'stats' as const, label: 'Statistics' }] : []),
    // Administrator-only: API access details for this event.
    ...(user?.role === 'admin' ? [{ id: 'developer' as const, label: 'Developer' }] : []),
  ];
  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : 'photos';
  return (
    <>
      <Link href="/console/events" className="mb-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted transition-colors hover:text-fg"><ArrowLeft className="size-4" /> All events</Link>
      {contributor && (
        <p role="note" className="mb-4 flex items-start gap-2.5 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          You were invited to contribute to this event. You can upload photos and videos and edit your own uploads.
        </p>
      )}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        {data.coverUrl && (
          <>
            <img src={data.coverUrl} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover opacity-25 blur-2xl" />
            <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-surface via-surface/90 to-surface/60" />
          </>
        )}
        <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
          <div className="size-20 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-accent/20 to-fuchsia-500/15 shadow-card ring-1 ring-border sm:size-24">
            {data.coverUrl ? <img src={data.coverUrl} alt="" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-accent/60"><ImageIcon className="size-8" aria-hidden /></span>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(data.status)} dot>{label(data.status)}</Badge>
              <Badge>{{ public: 'Public', unlisted: 'Unlisted', private: 'Password protected' }[data.visibility]}</Badge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{data.name}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {data.eventDate && <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{date(data.eventDate)}</span>}
              {data.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" aria-hidden />{data.location}</span>}
              {data.photoCount != null && <span className="inline-flex items-center gap-1.5"><ImageIcon className="size-4" aria-hidden />{num(data.readyCount)} of {num(data.photoCount)} ready</span>}
            </p>
          </div>
          {!contributor && data.status === 'active' && (
            <a href={data.shareUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm shadow-accent/25 transition-colors hover:bg-accent-strong">
              View public gallery <ExternalLink className="size-4" />
            </a>
          )}
        </div>
      </section>
      <Tabs tabs={tabs} value={activeTab} onChange={setTab} />
      {activeTab === 'photos' && <PhotosTab event={data} />}
      {activeTab === 'galleries' && <GalleriesTab event={data} />}
      {activeTab === 'settings' && <SettingsTab event={data} />}
      {activeTab === 'team' && <TeamTab event={data} />}
      {activeTab === 'stats' && <StatsTab eventId={data.id} />}
      {activeTab === 'developer' && user?.role === 'admin' && <DeveloperTab eventId={data.id} />}
    </>
  );
}
