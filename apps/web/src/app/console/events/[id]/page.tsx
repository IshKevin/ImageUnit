'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { GalleriesTab } from '@/components/event/galleries-tab';
import { PhotosTab } from '@/components/event/photos-tab';
import { SettingsTab } from '@/components/event/settings-tab';
import { StatsTab } from '@/components/event/stats-tab';
import { DeveloperTab } from '@/components/event/developer-tab';
import { Badge, EmptyState, Loading, PageHeader, Tabs, statusTone } from '@/components/ui';
import { get, type EventItem } from '@/lib/api';
import { date, label } from '@/lib/format';
import { can, useMe } from '@/lib/auth';

type Tab = 'photos' | 'galleries' | 'settings' | 'stats' | 'developer';

export default function EventDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: user } = useMe();
  const [tab, setTab] = useState<Tab>('photos');
  const { data, isLoading, error } = useQuery({ queryKey: ['event', id], queryFn: async () => (await get<{ event: EventItem }>(`/events/${id}`)).event });

  if (isLoading) return <Loading />;
  if (error || !data) return <EmptyState title="Event not found" description="It may have been deleted, or you may not have access." action={<Link href="/console/events" className="text-accent hover:underline">Back to events</Link>} />;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'photos', label: 'Photographs' },
    { id: 'galleries', label: 'Galleries' },
    { id: 'settings', label: 'Settings & sharing' },
    ...(can(user, 'stats:view') ? [{ id: 'stats' as const, label: 'Statistics' }] : []),
    // Administrator-only: API access details for this event.
    ...(user?.role === 'admin' ? [{ id: 'developer' as const, label: 'Developer' }] : []),
  ];
  return (
    <>
      <Link href="/console/events" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Events</Link>
      <PageHeader
        title={data.name}
        description={[date(data.eventDate), data.location].filter((x) => x && x !== '—').join(' · ') || undefined}
        actions={<>
          <Badge tone={statusTone(data.status)}>{label(data.status)}</Badge>
          {data.status === 'active' && <a href={data.shareUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-sm hover:bg-surface-2">View public page <ExternalLink className="size-3.5" /></a>}
        </>}
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'photos' && <PhotosTab event={data} />}
      {tab === 'galleries' && <GalleriesTab event={data} />}
      {tab === 'settings' && <SettingsTab event={data} />}
      {tab === 'stats' && <StatsTab eventId={data.id} />}
      {tab === 'developer' && user?.role === 'admin' && <DeveloperTab eventId={data.id} />}
    </>
  );
}
