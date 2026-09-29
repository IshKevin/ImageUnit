'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, Loading, Stat } from '../ui';
import { get } from '@/lib/api';
import { bytes, num } from '@/lib/format';

interface Stats { views: number; uniqueVisitors: number; photoViews: number; downloads: number; photos: number; readyPhotos: number; failedPhotos: number; storageBytes: number; daily: { day: string; type: string; n: number }[] }

export function StatsTab({ eventId }: { eventId: string }) {
  const { data } = useQuery({ queryKey: ['event-stats', eventId], queryFn: () => get<Stats>(`/events/${eventId}/stats`) });
  if (!data) return <Loading />;
  const days = [...new Set(data.daily.map((d) => d.day))];
  const series = days.map((day) => ({ day, views: data.daily.find((d) => d.day === day && d.type === 'event_view')?.n ?? 0, downloads: data.daily.find((d) => d.day === day && d.type === 'download')?.n ?? 0 }));
  const max = Math.max(1, ...series.map((s) => s.views + s.downloads));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gallery views" value={num(data.views)} sub={`${num(data.uniqueVisitors)} unique visitors`} />
        <Stat label="Photo views" value={num(data.photoViews)} />
        <Stat label="Downloads" value={num(data.downloads)} />
        <Stat label="Storage" value={bytes(data.storageBytes)} sub={`${num(data.readyPhotos)} of ${num(data.photos)} photos ready`} />
      </div>
      <Card>
        <CardHeader title="Last 30 days" description="Gallery views and downloads per day" />
        {series.length ? (
          <div className="p-5">
            <div className="flex h-40 items-end gap-1" role="img" aria-label="Daily views and downloads chart">
              {series.map((s) => (
                <div key={s.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${s.day}: ${s.views} views, ${s.downloads} downloads`}>
                  <div className="bg-success/70" style={{ height: `${(s.downloads / max) * 100}%` }} />
                  <div className="rounded-t bg-accent" style={{ height: `${(s.views / max) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-4 text-xs text-muted"><span><i className="mr-1 inline-block size-2 rounded-sm bg-accent" />Views</span><span><i className="mr-1 inline-block size-2 rounded-sm bg-success/70" />Downloads</span></div>
          </div>
        ) : <p className="p-8 text-center text-sm text-muted">No activity yet.</p>}
      </Card>
    </div>
  );
}
