'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Badge, Card, CardHeader, ErrorNote, Loading, PageHeader, statusTone, Table, Td, Th } from '@/components/ui';
import { get } from '@/lib/api';
import { label, num } from '@/lib/format';
import { AdminGate } from '../_shared';

interface Health {
  status: 'ok' | 'degraded';
  checks: Record<string, boolean>;
  latencyMs: number;
  queues: Record<string, Record<string, number> | null>;
  photos: { failed: number; stuck: number; abandonedUploads: number };
  security: { lockedAccounts: number; lockoutsLast24h: number };
}

function Indicator({ ok, name, detail }: { ok: boolean; name: string; detail?: string }) {
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${ok ? 'border-success/40 bg-success/10' : 'border-warning/50 bg-warning/10'}`}>
      <Icon className={`size-5 ${ok ? 'text-success' : 'text-warning'}`} aria-hidden />
      <div>
        <p className="text-sm font-medium">{name}</p>
        <p className={`text-xs ${ok ? 'text-success' : 'text-warning'}`}>{detail ?? (ok ? 'OK' : 'Needs attention')}</p>
      </div>
    </div>
  );
}

export default function HealthPage() {
  return (
    <AdminGate perm="admin">
      <HealthView />
    </AdminGate>
  );
}

function HealthView() {
  const q = useQuery({ queryKey: ['admin-health'], queryFn: () => get<Health>('/admin/health'), refetchInterval: 10_000 });
  const h = q.data;
  return (
    <div className="space-y-6">
      <PageHeader title="System health" description="Refreshes automatically every 10 seconds." actions={h && <Badge tone={statusTone(h.status)}>{h.status === 'ok' ? 'All systems operational' : 'Degraded'}</Badge>} />
      {q.isLoading ? <Loading /> : !h ? <ErrorNote error={q.error} /> : (
        <>
          {q.error && <ErrorNote error={q.error} />}
          <div role="status" aria-live="polite" className="sr-only">System status: {h.status}</div>
          <Card>
            <CardHeader title="Services" description={`Check latency ${h.latencyMs} ms`} />
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              {Object.entries(h.checks).map(([k, ok]) => <Indicator key={k} ok={ok} name={label(k)} detail={ok ? 'Reachable' : 'Unreachable'} />)}
            </div>
          </Card>

          <Card>
            <CardHeader title="Queues" />
            <Table>
              <thead><tr><Th>Queue</Th>{['waiting', 'active', 'delayed', 'completed', 'failed'].map((c) => <Th key={c} className="text-right">{label(c)}</Th>)}</tr></thead>
              <tbody>
                {Object.entries(h.queues).map(([name, c]) => (
                  <tr key={name}>
                    <Td className="font-medium">{name}</Td>
                    {['waiting', 'active', 'delayed', 'completed', 'failed'].map((k) => (
                      <Td key={k} className={`text-right tabular-nums ${k === 'failed' && (c?.[k] ?? 0) > 0 ? 'font-semibold text-danger' : ''}`}>{c ? num(c[k]) : '—'}</Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Photo processing" />
              <div className="grid gap-3 p-5">
                <Indicator ok={h.photos.failed === 0} name="Failed photos" detail={`${num(h.photos.failed)} failed`} />
                <Indicator ok={h.photos.stuck === 0} name="Stuck processing" detail={`${num(h.photos.stuck)} stuck over 15 minutes`} />
                <Indicator ok={h.photos.abandonedUploads === 0} name="Abandoned uploads" detail={`${num(h.photos.abandonedUploads)} pending over 24 hours`} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Security" />
              <div className="grid gap-3 p-5">
                <Indicator ok={h.security.lockedAccounts === 0} name="Locked accounts" detail={`${num(h.security.lockedAccounts)} currently locked`} />
                <Indicator ok={h.security.lockoutsLast24h === 0} name="Lockouts, last 24 hours" detail={`${num(h.security.lockoutsLast24h)} lockouts`} />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
