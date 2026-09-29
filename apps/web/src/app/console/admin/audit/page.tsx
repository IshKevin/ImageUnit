'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Pagination, Table, Td, Th } from '@/components/ui';
import { get, qs, type Paged } from '@/lib/api';
import { date } from '@/lib/format';
import { AdminGate } from '../_shared';

interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  eventId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  ip: string | null;
  createdAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v, null, 2);

function Diff({ before, after }: { before: unknown; after: unknown }) {
  if (before == null && after == null) return null;
  if (!isObj(before) && !isObj(after)) {
    return <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{json({ before, after })}</pre>;
  }
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => json(b[k]) !== json(a[k]));
  if (!keys.length) return <p className="text-xs text-muted">No field changes.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead><tr><Th>Field</Th><Th>Before</Th><Th>After</Th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <Td className="font-mono">{k}</Td>
              <Td className="bg-danger/10 font-mono break-all">{k in b ? json(b[k]) : '—'}</Td>
              <Td className="bg-success/10 font-mono break-all">{k in a ? json(a[k]) : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function exportCsv(rows: AuditRow[]) {
  const head = ['time', 'actor', 'actor_type', 'action', 'entity_type', 'entity_id', 'event_id', 'ip', 'before', 'after', 'meta'];
  const lines = rows.map((r) => [r.createdAt, r.actorLabel, r.actorType, r.action, r.entityType, r.entityId, r.eventId, r.ip, r.before ? JSON.stringify(r.before) : '', r.after ? JSON.stringify(r.after) : '', r.meta ? JSON.stringify(r.meta) : ''].map(csvCell).join(','));
  const url = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditPage() {
  return (
    <AdminGate perm="audit:view">
      <Audit />
    </AdminGate>
  );
}

function Audit() {
  const [f, setF] = useState({ action: '', q: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setApplied(f); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [f]);

  const list = useQuery({
    queryKey: ['admin-audit', applied, page],
    queryFn: () =>
      get<Paged<AuditRow>>(
        `/admin/audit${qs({
          action: applied.action.trim(),
          q: applied.q.trim(),
          from: applied.from ? new Date(applied.from).toISOString() : '',
          to: applied.to ? new Date(`${applied.to}T23:59:59.999`).toISOString() : '',
          page,
          pageSize: 50,
        })}`,
      ),
    placeholderData: (p) => p,
  });
  const items = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="Audit log" description="Security-relevant actions across the platform." actions={<Button onClick={() => exportCsv(items)} disabled={!items.length}><Download className="size-4" aria-hidden /> Export page as CSV</Button>} />
      <Card>
        <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Action prefix"><Input placeholder="e.g. user." value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
          <Field label="Actor"><Input placeholder="Name or email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        </div>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorNote error={list.error} /></div> : !items.length ? <EmptyState title="No audit entries" description="Nothing matches these filters." /> : (
          <>
            <Table>
              <thead><tr><Th><span className="sr-only">Expand</span></Th><Th>Time</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Event</Th></tr></thead>
              <tbody>
                {items.map((r) => {
                  const isOpen = open === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-surface-2">
                        <Td className="w-8">
                          <button aria-expanded={isOpen} aria-label={isOpen ? 'Collapse details' : 'Expand details'} onClick={() => setOpen(isOpen ? null : r.id)} className="rounded p-1 hover:bg-surface">
                            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </Td>
                        <Td className="whitespace-nowrap text-muted">{date(r.createdAt, true)}</Td>
                        <Td>{r.actorLabel ?? r.actorType}</Td>
                        <Td><code className="font-mono text-xs">{r.action}</code></Td>
                        <Td className="text-muted">{r.entityType ? `${r.entityType}${r.entityId ? ` ${r.entityId.slice(0, 8)}` : ''}` : '—'}</Td>
                        <Td>{r.eventId ? <Link href={`/console/events/${r.eventId}`} className="font-mono text-xs hover:underline">{r.eventId.slice(0, 8)}</Link> : '—'}</Td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} className="space-y-3 border-t border-border bg-surface-2/50 px-6 py-4">
                            <Diff before={r.before} after={r.after} />
                            {r.meta != null && <div><p className="mb-1 text-xs font-medium text-muted">Meta</p><pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{json(r.meta)}</pre></div>}
                            {r.ip && <p className="text-xs text-muted">IP {r.ip}</p>}
                            {r.before == null && r.after == null && r.meta == null && <p className="text-xs text-muted">No additional details.</p>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={list.data!.page} pageSize={list.data!.pageSize} total={list.data!.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
