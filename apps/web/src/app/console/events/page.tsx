'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, ImageIcon, LayoutGrid, List, MapPin, Plus, Search, Users } from 'lucide-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Skeleton, Table, Td, Textarea, Th, statusTone } from '@/components/ui';
import { get, post, qs, type DownloadPolicy, type EventItem, type Paged } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { bytes, date, label, num } from '@/lib/format';

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
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={create.isPending}>Create event</Button></div>
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
  const [view, setView] = useState<'grid' | 'list'>('grid');
  useEffect(() => { try { const v = localStorage.getItem('imageunit-events-view'); if (v === 'grid' || v === 'list') setView(v); } catch { /* storage blocked */ } }, []);
  const changeView = (v: 'grid' | 'list') => { setView(v); try { localStorage.setItem('imageunit-events-view', v); } catch { /* storage blocked */ } };
  const items = events.data?.items ?? [];
  return (
    <>
      <PageHeader title="Events" description={user?.role === 'admin' ? 'All events on the platform' : 'Your events and events shared with you'} actions={canCreate && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New event</Button>} />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <div className="relative min-w-52 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="pl-9" placeholder="Search events by name or location" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search events" /></div>
          <Select className="w-full sm:w-48" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {['draft', 'active', 'expired', 'archived', 'scheduled_for_deletion'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
          <div role="radiogroup" aria-label="Layout" className="flex rounded-lg border border-border bg-surface-2 p-0.5">
            {([['grid', LayoutGrid, 'Grid view'], ['list', List, 'List view']] as const).map(([id, Icon, name]) => (
              <button key={id} role="radio" aria-checked={view === id} aria-label={name} title={name} onClick={() => changeView(id)} className={clsx('grid size-8 place-items-center rounded-md transition-all', view === id ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}>
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        </div>
        {events.isLoading ? (
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[4/3] rounded-xl" />)}</div>
        ) : items.length ? (
          <>
            {view === 'grid' ? (
              <ul className={clsx('grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-4', events.isFetching && 'opacity-60 transition-opacity')}>
                {items.map((e) => (
                  <li key={e.id}>
                    <Link href={`/console/events/${e.id}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop">
                      <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-accent/15 via-surface-2 to-fuchsia-500/10">
                        {e.coverUrl ? <img src={e.coverUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" /> : <span className="absolute inset-0 grid place-items-center text-accent/50"><ImageIcon className="size-8" aria-hidden /></span>}
                        <span className="absolute left-3 top-3"><Badge tone={statusTone(e.status)} dot>{label(e.status)}</Badge></span>
                        {e.myAccess === 'contribute' && <span className="absolute right-3 top-3"><Badge tone="accent">Shared with you</Badge></span>}
                      </div>
                      <div className="flex flex-1 flex-col gap-1.5 p-4">
                        <p className="line-clamp-2 font-semibold leading-snug tracking-tight group-hover:text-accent">{e.name}</p>
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                          <span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" aria-hidden />{date(e.eventDate)}</span>
                          {e.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{e.location}</span></span>}
                        </p>
                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
                          <span className="inline-flex items-center gap-1 tabular-nums"><ImageIcon className="size-3.5" aria-hidden />{num(e.readyCount)} / {num(e.photoCount)}</span>
                          <span className="tabular-nums">{bytes(e.storageBytes)}</span>
                          {!!e.memberCount && e.myAccess !== 'contribute' && <span className="inline-flex items-center gap-1"><Users className="size-3.5" aria-hidden />{e.memberCount}</span>}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Table>
                <thead><tr><Th>Event</Th><Th>Date</Th><Th>Photographer</Th><Th>Photos</Th><Th>Storage</Th><Th>Expires</Th><Th>Status</Th></tr></thead>
                <tbody className={clsx(events.isFetching && 'opacity-60 transition-opacity')}>
                  {items.map((e) => (
                    <tr key={e.id} className="transition-colors hover:bg-surface-2/60">
                      <Td>
                        <div className="flex items-center gap-3">
                          {e.coverUrl ? <img src={e.coverUrl} alt="" loading="lazy" className="size-11 shrink-0 rounded-lg object-cover ring-1 ring-border" /> : <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted" aria-hidden><ImageIcon className="size-4" /></span>}
                          <div className="min-w-0">
                            <Link href={`/console/events/${e.id}`} className="font-medium hover:text-accent">{e.name}</Link>
                            {e.location && <p className="text-xs text-muted">{e.location}</p>}
                            <div className="mt-0.5 flex flex-wrap gap-1.5">
                              {e.myAccess === 'contribute' && <Badge tone="accent">Shared with you</Badge>}
                              {e.myAccess !== 'contribute' && !!e.memberCount && <Badge>{e.memberCount} {e.memberCount === 1 ? 'photographer' : 'photographers'}</Badge>}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">{date(e.eventDate)}</Td>
                      <Td>{e.ownerName ?? '—'}</Td>
                      <Td className="tabular-nums">{e.readyCount}/{e.photoCount}</Td>
                      <Td className="whitespace-nowrap">{bytes(e.storageBytes)}</Td>
                      <Td className="whitespace-nowrap">{date(e.expiresAt)}</Td>
                      <Td><Badge tone={statusTone(e.status)} dot>{label(e.status)}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination page={events.data!.page} pageSize={events.data!.pageSize} total={events.data!.total} onChange={setPage} />
          </>
        ) : <EmptyState icon={debounced || status ? Search : CalendarPlus} title={debounced || status ? 'No matching events' : 'No events yet'} description={debounced || status ? 'Try a different search or status filter.' : 'Create an event to start uploading and sharing photographs.'} action={canCreate && !debounced && !status && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New event</Button>} />}
      </Card>
      <NewEventModal open={creating} onClose={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['events'] }); }} />
    </>
  );
}

export default function EventsPage() {
  return <Suspense fallback={<Loading />}><EventsList /></Suspense>;
}
