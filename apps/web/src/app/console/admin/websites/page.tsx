'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Stat, statusTone, Table, Td, Textarea, Th } from '@/components/ui';
import { get, patch, post, type EventItem, type Website as WebsiteSummary } from '@/lib/api';
import { bytes, date, label, num, relative } from '@/lib/format';
import { AdminGate, SecretDialog, TimeChart } from '../_shared';

interface Website extends WebsiteSummary {
  description: string;
  keyPrefix: string;
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  allowedEventIds: string[] | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
type UsageRow = {
  day: string;
  requests: number;
  errors: number;
  bytesServed: number;
};
const SCOPES = ['events:read', 'galleries:read', 'images:read', 'downloads:read', 'collections:read'];
const SCOPE_LABELS: Record<string, string> = { 'collections:read': 'Collections' };
const EVENT_PAGE_SIZE = 200;

async function loadEvents() {
  const first = await get<{ items: EventItem[]; total: number }>(`/events?page=1&pageSize=${EVENT_PAGE_SIZE}`);
  const pages = Math.ceil(first.total / EVENT_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      get<{ items: EventItem[] }>(`/events?page=${index + 2}&pageSize=${EVENT_PAGE_SIZE}`),
    ),
  );
  return [...first.items, ...rest.flatMap((page) => page.items)];
}

export default function WebsitesPage() {
  return (
    <AdminGate perm="websites:manage">
      <Websites />
    </AdminGate>
  );
}

function Websites() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin-websites'], queryFn: () => get<{ items: Website[] }>('/admin/websites') });
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState<{ title: string; value: string } | null>(null);
  const [details, setDetails] = useState<Website | null>(null);
  const [revoke, setRevoke] = useState<Website | null>(null);
  const [rotate, setRotate] = useState<Website | null>(null);
  const [usage, setUsage] = useState<Website | null>(null);
  const [eventAccess, setEventAccess] = useState<Website | null>(null);
  const [collectionAccess, setCollectionAccess] = useState<Website | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-websites'] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Request failed');

  const toggle = useMutation({
    mutationFn: (w: Website) => patch(`/admin/websites/${w.id}`, { status: w.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: () => { toast.success('Website updated'); refresh(); },
    onError: fail,
  });
  const doRotate = useMutation({
    mutationFn: (w: Website) => post<{ apiKey: string }>(`/admin/websites/${w.id}/rotate-key`),
    onSuccess: (r, w) => { setRotate(null); refresh(); setKey({ title: `New API key for ${w.name}`, value: r.apiKey }); },
    onError: (e) => { setRotate(null); fail(e); },
  });
  const doRevoke = useMutation({
    mutationFn: (w: Website) => post(`/admin/websites/${w.id}/revoke`),
    onSuccess: () => { setRevoke(null); toast.success('Access revoked'); refresh(); },
    onError: (e) => { setRevoke(null); fail(e); },
  });

  return (
    <div>
      <PageHeader
        title="Websites"
        description="Manage website API keys, event access, and access to assigned collections."
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden /> New website</Button>}
      />
      <Card>
        {list.isLoading ? <Loading /> : list.error ? <div className="p-4"><ErrorNote error={list.error} /></div> : !list.data?.items.length ? (
          <EmptyState title="No websites yet" description="Register a website to issue it an API key." />
        ) : (
          <Table>
            <thead><tr><Th>Website</Th><Th>Status</Th><Th>Key</Th><Th>Scopes</Th><Th>Last used</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {list.data.items.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <p className="font-medium">{w.name}</p>
                    <p className="text-xs text-muted">{w.rateLimitPerMinute.toLocaleString()} req/min</p>
                  </Td>
                  <Td><Badge tone={statusTone(w.status)}>{label(w.status)}</Badge></Td>
                  <Td><code className="font-mono text-xs">{w.keyPrefix}…</code></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">{w.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{w.lastUsedAt ? relative(w.lastUsedAt) : 'Never'}</Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setDetails(w)}>Details</Button>
                      <Button size="sm" onClick={() => setUsage(w)} aria-label={`Usage for ${w.name}`}><BarChart3 className="size-4" aria-hidden /> Usage</Button>
                      {w.status !== 'revoked' && (
                        <>
                          <Button size="sm" onClick={() => setCollectionAccess(w)}>Collections</Button>
                          <Button size="sm" onClick={() => setEventAccess(w)}>Events</Button>
                          <Button size="sm" onClick={() => toggle.mutate(w)} disabled={toggle.isPending}>{w.status === 'active' ? 'Disable' : 'Enable'}</Button>
                          <Button size="sm" onClick={() => setRotate(w)}>Rotate key</Button>
                          <Button size="sm" variant="danger" onClick={() => setRevoke(w)}>Revoke</Button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <CreateWebsite open={creating} onClose={() => setCreating(false)} onCreated={(name, apiKey) => { setCreating(false); refresh(); setKey({ title: `API key for ${name}`, value: apiKey }); }} />
      <Modal open={!!details} onClose={() => setDetails(null)} title={`Website details: ${details?.name ?? ''}`} wide>
        {details && (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
            <dt className="text-muted">ID</dt>
            <dd className="break-all font-mono text-xs">{details.id}</dd>
            <dt className="text-muted">Name</dt>
            <dd>{details.name}</dd>
            <dt className="text-muted">Description</dt>
            <dd className="whitespace-pre-wrap wrap-break-word">{details.description || '—'}</dd>
            <dt className="text-muted">Status</dt>
            <dd><Badge tone={statusTone(details.status)}>{label(details.status)}</Badge></dd>
            <dt className="text-muted">Key prefix</dt>
            <dd><code className="font-mono text-xs">{details.keyPrefix}…</code></dd>
            <dt className="text-muted">Scopes</dt>
            <dd className="flex flex-wrap gap-1">
              {details.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}
            </dd>
            <dt className="text-muted">Event access</dt>
            <dd className="wrap-break-word">
              {details.allowedEventIds === null
                ? 'All events'
                : details.allowedEventIds.length
                  ? details.allowedEventIds.join(', ')
                  : 'No events'}
            </dd>
            <dt className="text-muted">Allowed origins</dt>
            <dd className="wrap-break-word">
              {details.allowedOrigins.length
                ? details.allowedOrigins.map((origin) => <code key={origin} className="mr-2 inline-block font-mono text-xs">{origin}</code>)
                : 'Any origin'}
            </dd>
            <dt className="text-muted">Rate limit</dt>
            <dd>{details.rateLimitPerMinute.toLocaleString()} requests/min</dd>
            <dt className="text-muted">Last used</dt>
            <dd>{date(details.lastUsedAt, true)}</dd>
            <dt className="text-muted">Revoked</dt>
            <dd>{date(details.revokedAt, true)}</dd>
            <dt className="text-muted">Created</dt>
            <dd>{date(details.createdAt, true)}</dd>
          </dl>
        )}
      </Modal>
      {eventAccess && <WebsiteEventsModal website={eventAccess} onClose={() => setEventAccess(null)} onSaved={refresh} />}
      {collectionAccess && <WebsiteCollectionsModal website={collectionAccess} onClose={() => setCollectionAccess(null)} onSaved={refresh} />}
      <SecretDialog open={!!key} onClose={() => setKey(null)} title={key?.title ?? ''} secret={key?.value ?? ''} warning="Copy this key now. It is shown only once and cannot be retrieved later." />
      <ConfirmDialog open={!!rotate} onClose={() => setRotate(null)} title="Rotate API key" message={`The current key for ${rotate?.name} stops working immediately. A new key will be shown once.`} confirmLabel="Rotate key" loading={doRotate.isPending} onConfirm={() => rotate && doRotate.mutate(rotate)} />
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title="Revoke access" message={`Revoking ${revoke?.name} is irreversible. To restore access you must create a new website credential.`} confirmLabel="Revoke" danger loading={doRevoke.isPending} onConfirm={() => revoke && doRevoke.mutate(revoke)} />
      <Modal open={!!usage} onClose={() => setUsage(null)} title={`Usage: ${usage?.name ?? ''}`} wide>
        {usage && <Usage id={usage.id} />}
      </Modal>
    </div>
  );
}

function Usage({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['admin-website-usage', id], queryFn: () => get<{ items: UsageRow[] }>(`/admin/websites/${id}/usage`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const rows = q.data?.items ?? [];
  if (!rows.length) return <EmptyState title="No usage yet" description="No requests in the last 30 days." />;
  const sum = (k: 'requests' | 'errors' | 'bytesServed') => rows.reduce((s, r) => s + r[k], 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Requests" value={num(sum('requests'))} />
        <Stat label="Errors" value={num(sum('errors'))} />
        <Stat label="Served" value={bytes(sum('bytesServed'))} />
      </div>
      <TimeChart mode="bars" xKey="day" title="Requests per day, last 30 days" rows={rows} series={[{ key: 'requests', label: 'Requests', color: 'var(--accent)' }]} />
    </div>
  );
}

function CreateWebsite({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string, apiKey: string) => void }) {
  const blank = { name: '', description: '', scopes: ['events:read', 'galleries:read', 'images:read', 'collections:read'], origins: '', rate: '600' };
  const [f, setF] = useState(blank);
  const [allEvents, setAllEvents] = useState(true);
  const [eventIds, setEventIds] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: () => {
      const origins = f.origins.split(/[\s,]+/).filter(Boolean);
      return post<{ website: Website; apiKey: string }>('/admin/websites', {
        name: f.name.trim(),
        description: f.description,
        scopes: f.scopes,
        allowedEventIds: allEvents ? null : eventIds,
        allowedOrigins: origins,
        rateLimitPerMinute: Number(f.rate),
      });
    },
    onSuccess: (r) => { toast.success('Website created'); setF(blank); setAllEvents(true); setEventIds([]); onCreated(r.website.name, r.apiKey); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="New website">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea maxLength={500} className="min-h-16" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <EventAccessPicker enabled={open} allEvents={allEvents} eventIds={eventIds} onAllEventsChange={setAllEvents} onEventIdsChange={setEventIds} />
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Scopes</legend>
          <div className="grid grid-cols-2 gap-2">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={f.scopes.includes(s)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s] : f.scopes.filter((x) => x !== s) })} />
                <span className="font-mono text-xs">{s}</span>{SCOPE_LABELS[s] && <span className="text-xs text-muted">({SCOPE_LABELS[s]})</span>}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted">Collections assigned to this website are listed at <code>/api/v1/collections</code>. Enable <code>images:read</code> to receive signed thumbnails.</p>
        <Field label="Allowed origins (optional)" hint="Comma or space separated, e.g. https://example.com"><Input value={f.origins} onChange={(e) => setF({ ...f, origins: e.target.value })} /></Field>
        <Field label="Rate limit (requests per minute)" hint="10 to 100,000."><Input type="number" min={10} max={100000} required value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!f.scopes.length}>Create website</Button>
        </div>
      </form>
    </Modal>
  );
}

function EventAccessPicker({
  enabled,
  allEvents,
  eventIds,
  onAllEventsChange,
  onEventIdsChange,
}: {
  enabled: boolean;
  allEvents: boolean;
  eventIds: string[];
  onAllEventsChange: (value: boolean) => void;
  onEventIdsChange: (ids: string[]) => void;
}) {
  const events = useQuery({ queryKey: ['website-event-choices'], queryFn: loadEvents, enabled });
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Event access</legend>
      <p className="text-xs text-muted">This limits which events’ media the website can read, including media in its assigned collections.</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={allEvents} onChange={(e) => onAllEventsChange(e.target.checked)} />
        All events (no event restriction)
      </label>
      {!allEvents && (
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
          {events.isLoading ? <Loading /> : events.error ? <ErrorNote error={events.error} /> : events.data?.length ? events.data.map((event) => (
            <label key={event.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={eventIds.includes(event.id)}
                onChange={(e) => onEventIdsChange(e.target.checked ? [...eventIds, event.id] : eventIds.filter((id) => id !== event.id))}
              />
              <span>{event.name}</span>
              <span className="text-xs text-muted">{label(event.status)}</span>
            </label>
          )) : <p className="text-sm text-muted">No events available.</p>}
        </div>
      )}
      {!allEvents && eventIds.length === 0 && <p className="text-xs text-warning">No events selected. This website will not be able to read event media.</p>}
    </fieldset>
  );
}

function WebsiteEventsModal({ website, onClose, onSaved }: { website: Website; onClose: () => void; onSaved: () => void }) {
  const [allEvents, setAllEvents] = useState(website.allowedEventIds === null);
  const [eventIds, setEventIds] = useState(website.allowedEventIds ?? []);
  const update = useMutation({
    mutationFn: () => patch(`/admin/websites/${website.id}`, { allowedEventIds: allEvents ? null : eventIds }),
    onSuccess: () => { toast.success('Event access updated'); onSaved(); onClose(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Request failed'),
  });

  return (
    <Modal open onClose={onClose} title={`Event access: ${website.name}`}>
      <div className="space-y-4">
        <EventAccessPicker enabled allEvents={allEvents} eventIds={eventIds} onAllEventsChange={setAllEvents} onEventIdsChange={setEventIds} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} onClick={() => update.mutate()}>Save event access</Button>
        </div>
      </div>
    </Modal>
  );
}

function WebsiteCollectionsModal({ website, onClose, onSaved }: { website: Website; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [addingExisting, setAddingExisting] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionDescription, setNewCollectionDescription] = useState('');

  const assigned = useQuery({
    queryKey: ['admin-website-collections', website.id],
    queryFn: () => get<{ items: Array<WebsiteSummary & { id: string; name: string; slug: string; itemCount: number; status: string; coverUrl: string | null }> }>(`/admin/websites/${website.id}/collections`),
  });

  const allCollections = useQuery({
    queryKey: ['collections-all-for-picker'],
    queryFn: () => get<{ items: Array<{ id: string; name: string; slug: string }> }>('/collections'),
    enabled: addingExisting,
  });

  const linkExisting = useMutation({
    mutationFn: (collectionId: string) => post(`/admin/websites/${website.id}/collections`, { collectionId }),
    onSuccess: () => {
      toast.success('Collection linked to website');
      setSelectedCollectionId('');
      setAddingExisting(false);
      void qc.invalidateQueries({ queryKey: ['admin-website-collections', website.id] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Request failed'),
  });

  const createCollection = useMutation({
    mutationFn: () =>
      post(`/admin/websites/${website.id}/collections`, {
        name: newCollectionName.trim(),
        description: newCollectionDescription.trim(),
      }),
    onSuccess: () => {
      toast.success('New collection created and linked');
      setNewCollectionName('');
      setNewCollectionDescription('');
      setCreatingNew(false);
      void qc.invalidateQueries({ queryKey: ['admin-website-collections', website.id] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Request failed'),
  });

  const unlinkCollection = useMutation({
    mutationFn: (collectionId: string) => patch(`/collections/${collectionId}`, { websiteId: null }),
    onSuccess: () => {
      toast.success('Collection unlinked');
      void qc.invalidateQueries({ queryKey: ['admin-website-collections', website.id] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Request failed'),
  });

  const items = assigned.data?.items ?? [];
  const assignedIds = new Set(items.map((i) => i.id));
  const availableToLink = (allCollections.data?.items ?? []).filter((c) => !assignedIds.has(c.id));

  return (
    <Modal open onClose={onClose} title={`Collections: ${website.name}`} wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            Collections assigned to this website can be fetched with this website&apos;s API key.
          </p>
          <div className="flex gap-2">
            {!creatingNew && !addingExisting && (
              <>
                <Button size="sm" onClick={() => setAddingExisting(true)}>
                  Link existing
                </Button>
                <Button size="sm" variant="primary" onClick={() => setCreatingNew(true)}>
                  <Plus className="size-4" /> New collection
                </Button>
              </>
            )}
          </div>
        </div>

        {addingExisting && (
          <div className="rounded-lg border border-border bg-surface-2 p-3 space-y-3">
            <h4 className="text-sm font-medium">Link existing collection</h4>
            {allCollections.isLoading ? (
              <Loading />
            ) : availableToLink.length === 0 ? (
              <p className="text-xs text-muted">No unassigned or other collections available to link.</p>
            ) : (
              <div className="flex gap-2">
                <select
                  className="flex-1 h-9 rounded-lg border border-border bg-surface px-3 text-sm focus:border-accent"
                  value={selectedCollectionId}
                  onChange={(e) => setSelectedCollectionId(e.target.value)}
                >
                  <option value="">Select a collection…</option>
                  {availableToLink.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.slug})
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!selectedCollectionId}
                  loading={linkExisting.isPending}
                  onClick={() => linkExisting.mutate(selectedCollectionId)}
                >
                  Link
                </Button>
                <Button size="sm" onClick={() => setAddingExisting(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}

        {creatingNew && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createCollection.mutate();
            }}
            className="rounded-lg border border-border bg-surface-2 p-3 space-y-3"
          >
            <h4 className="text-sm font-medium">Create collection for this website</h4>
            <Field label="Name">
              <Input
                required
                minLength={2}
                maxLength={160}
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Collection name"
              />
            </Field>
            <Field label="Description (optional)">
              <Textarea
                maxLength={5000}
                className="min-h-16"
                value={newCollectionDescription}
                onChange={(e) => setNewCollectionDescription(e.target.value)}
                placeholder="Description"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button size="sm" type="button" onClick={() => setCreatingNew(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                variant="primary"
                loading={createCollection.isPending}
                disabled={newCollectionName.trim().length < 2}
              >
                Create and link
              </Button>
            </div>
          </form>
        )}

        {assigned.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState
            title="No collections assigned"
            description="Assign or create a collection for this website."
          />
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-2 border border-border rounded-lg p-2">
            {items.map((col) => (
              <div
                key={col.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-2.5"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {col.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={col.coverUrl} alt="" className="size-10 rounded object-cover shrink-0" />
                  ) : (
                    <div className="grid size-10 place-items-center rounded bg-surface-2 text-muted shrink-0">
                      <BarChart3 className="size-4" />
                    </div>
                  )}
                  <div className="min-w-0 truncate">
                    <p className="font-medium text-sm truncate">{col.name}</p>
                    <p className="text-xs text-muted truncate">
                      {col.slug} · {col.itemCount} items · {label(col.status)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge tone={statusTone(col.status === 'active' ? 'active' : 'disabled')}>
                    {label(col.status)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={unlinkCollection.isPending && unlinkCollection.variables === col.id}
                    onClick={() => unlinkCollection.mutate(col.id)}
                    aria-label={`Unlink ${col.name}`}
                  >
                    Unlink
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
