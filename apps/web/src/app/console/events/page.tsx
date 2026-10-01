'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Table, Td, Textarea, Th, statusTone } from '@/components/ui';
import { get, post, qs, type DownloadPolicy, type EventItem, type Paged } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { bytes, date, label } from '@/lib/format';

function NewEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', description: '', eventDate: '', location: '', visibility: 'public', downloadPolicy: 'preview' as DownloadPolicy, password: '' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => post<{ event: EventItem }>('/events', { name: form.name, description: form.description, eventDate: form.eventDate || null, location: form.location || null, visibility: form.visibility, downloadPolicy: form.downloadPolicy, password: form.visibility === 'private' ? form.password : undefined }),
    onSuccess: ({ event }) => {
      toast.success('Event created');
      router.push(`/console/events/${event.id}`);
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="New event" wide>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-4">
        <Field label="Event name"><Input required minLength={2} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Kigali International Marathon 2026" autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date"><Input type="date" value={form.eventDate} onChange={(e) => set('eventDate', e.target.value)} /></Field>
          <Field label="Location"><Input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Kigali" /></Field>
        </div>
        <Field label="Description"><Textarea value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who can view" hint="Unlisted events are reachable only through their link.">
            <Select value={form.visibility} onChange={(e) => set('visibility', e.target.value)}>
              <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Password protected</option>
            </Select>
          </Field>
          <Field label="Downloads">
            <Select value={form.downloadPolicy} onChange={(e) => set('downloadPolicy', e.target.value)}>
              <option value="disabled">Disabled</option><option value="preview">Preview quality</option><option value="full">Full resolution</option>
            </Select>
          </Field>
        </div>
        {form.visibility === 'private' && <Field label="Gallery password" hint="Share this with attendees. At least 6 characters."><Input required minLength={6} value={form.password} onChange={(e) => set('password', e.target.value)} /></Field>}
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={create.isPending}>Create event</Button></div>
      </form>
    </Modal>
  );
}

function EventsList() {
  const { data: user } = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  useEffect(() => { if (params.get('new')) { setCreating(true); router.replace('/console/events'); } }, [params, router]);
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => { setDebounced(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const events = useQuery({ queryKey: ['events', debounced, status, page], queryFn: () => get<Paged<EventItem>>(`/events${qs({ q: debounced, status, page, pageSize: 20 })}`), placeholderData: (p) => p });
  const canCreate = can(user, 'events:create');
  return (
    <>
      <PageHeader title="Events" description={user?.role === 'admin' ? 'All events on the platform' : 'Your events and events shared with you'} actions={canCreate && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New event</Button>} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-border p-4">
          <div className="relative min-w-52 flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input className="pl-9" placeholder="Search events" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search events" /></div>
          <Select className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {['draft', 'active', 'expired', 'archived', 'scheduled_for_deletion'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
        </div>
        {events.isLoading ? <Loading /> : events.data?.items.length ? (
          <>
            <Table>
              <thead><tr><Th>Event</Th><Th>Date</Th><Th>Photographer</Th><Th>Photos</Th><Th>Storage</Th><Th>Expires</Th><Th>Status</Th></tr></thead>
              <tbody>
                {events.data.items.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-2">
                    <Td>
                      <div className="flex items-center gap-3">
                        {e.coverUrl ? <img src={e.coverUrl} alt="" loading="lazy" className="size-10 shrink-0 rounded-md object-cover" /> : <span className="size-10 shrink-0 rounded-md bg-surface-2" aria-hidden />}
                        <div className="min-w-0">
                          <Link href={`/console/events/${e.id}`} className="font-medium hover:text-accent">{e.name}</Link>
                          <p className="text-xs text-muted">{e.location}</p>
                          <div className="mt-0.5 flex flex-wrap gap-1.5">
                            {e.myAccess === 'contribute' && <Badge tone="accent">Shared with you</Badge>}
                            {e.myAccess !== 'contribute' && !!e.memberCount && <Badge>{e.memberCount} {e.memberCount === 1 ? 'photographer' : 'photographers'}</Badge>}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>{date(e.eventDate)}</Td>
                    <Td>{e.ownerName ?? '—'}</Td>
                    <Td className="tabular-nums">{e.readyCount}/{e.photoCount}</Td>
                    <Td>{bytes(e.storageBytes)}</Td>
                    <Td>{date(e.expiresAt)}</Td>
                    <Td><Badge tone={statusTone(e.status)}>{label(e.status)}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onChange={setPage} />
          </>
        ) : <EmptyState title="No events found" description={debounced || status ? 'Try changing your filters.' : 'Create an event to get started.'} action={canCreate && !debounced && !status && <Button variant="primary" onClick={() => setCreating(true)}>New event</Button>} />}
      </Card>
      <NewEventModal open={creating} onClose={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['events'] }); }} />
    </>
  );
}

export default function EventsPage() {
  return <Suspense fallback={<Loading />}><EventsList /></Suspense>;
}
