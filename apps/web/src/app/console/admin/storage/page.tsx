'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Loading, PageHeader, Progress, Stat, statusTone, Table, Td, Th } from '@/components/ui';
import { get } from '@/lib/api';
import { bytes, label, num } from '@/lib/format';
import { AdminGate, TimeChart } from '../_shared';

interface Storage {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  byPhotographer: { userId: string; name: string; email: string; quota: number | null; bytes: number; photos: number }[];
  byEvent: { eventId: string; name: string; status: string; bytes: number; photos: number }[];
  byWebsite: { clientId: string; name: string; requests: number; bytesServed: number }[];
}
interface Stats {
  users: number;
  photographers: number;
  events: number;
  photos: number;
  activeGalleries: number;
  expiredGalleries: number;
  downloads: number;
  visitorsLast30Days: number;
}

const tone = (pct: number) => (pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent');

export default function StoragePage() {
  return (
    <AdminGate perm="admin">
      <StorageView />
    </AdminGate>
  );
}

function StorageView() {
  const storage = useQuery({ queryKey: ['admin-storage'], queryFn: () => get<Storage>('/admin/storage') });
  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => get<Stats>('/admin/stats') });
  const series = useQuery({ queryKey: ['admin-timeseries'], queryFn: () => get<{ items: { day: string; views: number; downloads: number; uploads: number }[] }>('/admin/stats/timeseries') });
  const s = storage.data;
  const pct = s && s.totalBytes > 0 ? (s.usedBytes / s.totalBytes) * 100 : 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Storage and platform" description="Capacity, usage by owner, and platform-wide activity." />

      {stats.data && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Users" value={num(stats.data.users)} />
          <Stat label="Photographers" value={num(stats.data.photographers)} />
          <Stat label="Events" value={num(stats.data.events)} />
          <Stat label="Photos" value={num(stats.data.photos)} />
          <Stat label="Active galleries" value={num(stats.data.activeGalleries)} />
          <Stat label="Expired galleries" value={num(stats.data.expiredGalleries)} />
          <Stat label="Downloads" value={num(stats.data.downloads)} />
          <Stat label="Visitors" value={num(stats.data.visitorsLast30Days)} sub="Last 30 days" />
        </div>
      )}
      <ErrorNote error={stats.error} />

      <Card>
        <CardHeader title="Activity, last 30 days" />
        <div className="p-5">
          {series.isLoading ? <Loading /> : series.error ? <ErrorNote error={series.error} /> : (
            <TimeChart
              mode="line"
              xKey="day"
              title="Views, downloads and uploads per day for the last 30 days"
              rows={(series.data?.items ?? []) as Record<string, string | number>[]}
              series={[
                { key: 'views', label: 'Views', color: 'var(--accent)' },
                { key: 'downloads', label: 'Downloads', color: 'var(--success)' },
                { key: 'uploads', label: 'Uploads', color: 'var(--warning)' },
              ]}
            />
          )}
        </div>
      </Card>

      {storage.isLoading ? <Loading /> : storage.error || !s ? <ErrorNote error={storage.error} /> : (
        <>
          <Card>
            <CardHeader title="Capacity" />
            <div className="space-y-3 p-5">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div><p className="text-muted">Total</p><p className="text-lg font-semibold tabular-nums">{bytes(s.totalBytes)}</p></div>
                <div><p className="text-muted">Used</p><p className="text-lg font-semibold tabular-nums">{bytes(s.usedBytes)}</p></div>
                <div><p className="text-muted">Available</p><p className="text-lg font-semibold tabular-nums">{bytes(s.availableBytes)}</p></div>
              </div>
              <Progress value={pct} tone={tone(pct)} />
              <p className="text-xs text-muted tabular-nums">{pct.toFixed(1)}% used</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="By photographer" />
            {!s.byPhotographer.length ? <EmptyState title="No photographers" /> : (
              <Table>
                <thead><tr><Th>Photographer</Th><Th className="text-right">Photos</Th><Th className="text-right">Used</Th><Th className="min-w-48">Quota</Th></tr></thead>
                <tbody>
                  {s.byPhotographer.map((p) => {
                    const q = p.quota ? (p.bytes / p.quota) * 100 : null;
                    return (
                      <tr key={p.userId}>
                        <Td><Link href={`/console/admin/users/${p.userId}`} className="font-medium hover:underline">{p.name}</Link><p className="text-xs text-muted">{p.email}</p></Td>
                        <Td className="text-right tabular-nums">{num(p.photos)}</Td>
                        <Td className="text-right tabular-nums">{bytes(p.bytes)}</Td>
                        <Td>{q === null ? <span className="text-muted">Unlimited</span> : (
                          <div className="space-y-1"><Progress value={q} tone={tone(q)} /><p className="text-xs text-muted tabular-nums">{q.toFixed(0)}% of {bytes(p.quota)}</p></div>
                        )}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="By event" description="Top 50 events by storage." />
            {!s.byEvent.length ? <EmptyState title="No events" /> : (
              <Table>
                <thead><tr><Th>Event</Th><Th>Status</Th><Th className="text-right">Photos</Th><Th className="text-right">Used</Th></tr></thead>
                <tbody>
                  {s.byEvent.map((e) => (
                    <tr key={e.eventId}>
                      <Td><Link href={`/console/events/${e.eventId}`} className="font-medium hover:underline">{e.name}</Link></Td>
                      <Td><Badge tone={statusTone(e.status)}>{label(e.status)}</Badge></Td>
                      <Td className="text-right tabular-nums">{num(e.photos)}</Td>
                      <Td className="text-right tabular-nums">{bytes(e.bytes)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="By website" />
            {!s.byWebsite.length ? <EmptyState title="No websites" /> : (
              <Table>
                <thead><tr><Th>Website</Th><Th className="text-right">Requests</Th><Th className="text-right">Bytes served</Th></tr></thead>
                <tbody>
                  {s.byWebsite.map((w) => (
                    <tr key={w.clientId}>
                      <Td className="font-medium">{w.name}</Td>
                      <Td className="text-right tabular-nums">{num(w.requests)}</Td>
                      <Td className="text-right tabular-nums">{bytes(w.bytesServed)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
