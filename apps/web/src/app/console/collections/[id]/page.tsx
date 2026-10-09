'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpToLine, Eye, EyeOff, FolderMinus, ImagePlus, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Tabs, Textarea, statusTone } from '@/components/ui';
import { MediaBrowser } from '@/components/media-browser';
import { BigModal } from '@/components/media/parts';
import { CopyButton } from '../../../admin/_shared';
import { get, patch, post, del, type Collection, type Selection, type Website } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { label } from '@/lib/format';

type Tab = 'items' | 'details' | 'dev';

export default function CollectionPage() {
  const { id } = useParams<{ id: string }>();
  const { data: user, isLoading: meLoading } = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('items');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const allowed = can(user, 'collections:manage');

  const q = useQuery({ queryKey: ['collection', id], queryFn: async () => (await get<{ collection: Collection }>(`/collections/${id}`)).collection, enabled: allowed });
  const c = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['collection', id] });
    void qc.invalidateQueries({ queryKey: ['collections'] });
    void qc.invalidateQueries({ queryKey: ['media'] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/collections/${id}`, body),
    onSuccess: () => { toast.success('Saved'); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => del(`/collections/${id}`),
    onSuccess: () => { toast.success('Collection deleted'); void qc.invalidateQueries({ queryKey: ['collections'] }); router.push('/console/collections'); },
    onError: (e) => toast.error(e.message),
  });
  const items = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown; msg: (r: never) => string }) => post<Record<string, number>>(`/collections/${id}/items${path}`, body),
    onSuccess: (r, v) => { toast.success((v.msg as (r: Record<string, number>) => string)(r)); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  if (meLoading || (allowed && q.isLoading)) return <Loading />;
  if (!allowed) return <Card><EmptyState title="You don't have access to collections" /></Card>;
  if (q.error || !c) return <ErrorNote error={q.error ?? new Error('Collection not found')} />;

  const published = c.status === 'published';
  return (
    <>
      <p className="mb-2 text-sm"><Link href="/console/collections" className="text-muted hover:text-fg">← Collections</Link></p>
      <PageHeader
        title={c.name}
        description={published ? 'Published collections are available to company websites.' : 'Draft. Publish it to make it available to company websites.'}
        actions={
          <>
            <Badge tone={statusTone(published ? 'active' : 'draft')}>{label(c.status)}</Badge>
            <Button variant={published ? 'secondary' : 'primary'} loading={save.isPending} onClick={() => save.mutate({ status: published ? 'draft' : 'published' })}>
              {published ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              {published ? 'Unpublish' : 'Publish'}
            </Button>
            <Button onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" aria-hidden />Delete</Button>
          </>
        }
      />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'items', label: `Items (${(c.itemCount ?? 0).toLocaleString()})` }, { id: 'details', label: 'Details' }, { id: 'dev', label: 'For developers' }]} />

      {tab === 'items' && (
        <>
          <MediaBrowser
            mode="manage"
            collectionId={id}
            baseFilter={{ collectionId: id }}
            toolbarExtra={<Button variant="primary" onClick={() => setAdding(true)}><ImagePlus className="size-4" aria-hidden />Add media</Button>}
            bulkExtra={({ selection, selectedIds, clear }) => (
              <>
                <Button size="sm" loading={items.isPending} onClick={() => items.mutate({ path: '/remove', body: { selection }, msg: ((r: { removed: number }) => `Removed ${r.removed.toLocaleString()} from the collection (media is kept)`) as never }, { onSuccess: clear })}>
                  <FolderMinus className="size-4" aria-hidden />Remove from collection
                </Button>
                {'ids' in selection && selection.ids.length === 1 && (
                  <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ coverPhotoId: selection.ids[0] }, { onSuccess: clear })}><Star className="size-4" aria-hidden />Set as cover</Button>
                )}
                {'ids' in selection && selectedIds.length > 0 && (
                  <Button size="sm" loading={items.isPending} onClick={() => items.mutate({ path: '/reorder', body: { ids: selectedIds }, msg: (() => 'Moved to the top') as never }, { onSuccess: clear })}>
                    <ArrowUpToLine className="size-4" aria-hidden />Move to top
                  </Button>
                )}
              </>
            )}
          />
          <AddMedia open={adding} onClose={() => setAdding(false)} collectionId={id} onAdded={refresh} />
        </>
      )}

      {tab === 'details' && <Details c={c} saving={save.isPending} onSave={(b) => save.mutate(b)} />}
      {tab === 'dev' && <Developers c={c} />}

      <ConfirmDialog
        open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete collection"
        title="Delete this collection?" message={`"${c.name}" will be removed${published ? ' and websites will no longer be able to fetch it' : ''}. Media is not deleted; photographs and videos stay in their events and in the library.`}
      />
    </>
  );
}

function AddMedia({ open, onClose, collectionId, onAdded }: { open: boolean; onClose: () => void; collectionId: string; onAdded: () => void }) {
  const [sel, setSel] = useState<{ s: Selection | null; n: number }>({ s: null, n: 0 });
  useEffect(() => { if (!open) setSel({ s: null, n: 0 }); }, [open]);
  const add = useMutation({
    mutationFn: (s: Selection) => post<{ added: number; alreadyIn: number }>(`/collections/${collectionId}/items`, { selection: s }),
    onSuccess: (r) => { toast.success(`Added ${r.added.toLocaleString()}${r.alreadyIn ? ` (${r.alreadyIn.toLocaleString()} were already in)` : ''}`); onAdded(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const all = !!sel.s && 'filter' in sel.s;
  return (
    <BigModal
      open={open} onClose={onClose} title="Add media to this collection"
      footer={
        <>
          <span className="mr-auto text-sm text-muted">Search and filter across all events, then select what to add.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!sel.s} loading={add.isPending} onClick={() => sel.s && add.mutate(sel.s)}>
            {!sel.s ? 'Add selected' : all ? `Add all ${sel.n.toLocaleString()} matching` : `Add ${sel.n.toLocaleString()} selected`}
          </Button>
        </>
      }
    >
      <MediaBrowser mode="pick" baseFilter={{ notInCollectionId: collectionId }} onSelectionChange={(s, n) => setSel({ s, n })} />
    </BigModal>
  );
}

function Details({ c, saving, onSave }: { c: Collection; saving: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description);
  const [slug, setSlug] = useState(c.slug);
  const [websiteIds, setWebsiteIds] = useState<string[]>(c.websiteIds ?? []);
  const draft = c.status === 'draft';

  const websites = useQuery({
    queryKey: ['admin-websites'],
    queryFn: () => get<{ items: Website[] }>('/admin/websites'),
  });

  return (
    <Card className="max-w-2xl">
      <CardHeader title="Details" />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name: name.trim(), description, websiteIds, ...(draft && slug !== c.slug ? { slug } : {}) });
        }}
      >
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></Field>
        <Field label="Link (slug)" hint={draft ? 'Lowercase letters, numbers and hyphens. Websites use this in the URL, so choose it before publishing.' : 'The link cannot change after publishing, because websites already depend on it. Unpublish first to change it.'}>
          <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} disabled={!draft} pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={80} />
        </Field>
        <Field label="Websites" hint="Select which websites can access this collection.">
          {websites.isLoading ? (
            <Loading />
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto rounded-lg border border-border p-3">
              {websites.data?.items.map((w) => (
                <label key={w.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={websiteIds.includes(w.id)}
                    onCheckedChange={(checked) => {
                      setWebsiteIds(checked ? [...websiteIds, w.id] : websiteIds.filter((id) => id !== w.id));
                    }}
                  />
                  <span>{w.name}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={saving}>Save changes</Button></div>
      </form>
    </Card>
  );
}

function Developers({ c }: { c: Collection }) {
  const url = c.apiUrl ?? `/api/v1/collections/${c.slug}`;
  const curl = `curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  ${url}/media`;
  const js = `const res = await fetch('${url}/media', {\n  headers: { Authorization: \`Bearer \${process.env.IMAGEUNIT_API_KEY}\` },\n});\nif (!res.ok) throw new Error(\`ImageUnit error \${res.status}\`);\nconst { items } = await res.json();`;
  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader title="API URLs" description={c.status === 'published' ? 'Company websites fetch this collection with their API key.' : 'These URLs only work once the collection is published.'} />
        <div className="space-y-3 p-5">
          {[['Collection', url], ['Media', `${url}/media`]].map(([k, v]) => (
            <div key={k}>
              <p className="mb-1 text-sm font-medium">{k}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm">{v}</code>
                <CopyButton value={v!} />
              </div>
            </div>
          ))}
          <p className="text-sm text-muted">The website&apos;s API key needs the <code className="font-mono">collections:read</code> scope, plus <code className="font-mono">images:read</code> to receive image links.</p>
        </div>
      </Card>
      {[['cURL', curl], ['JavaScript', js]].map(([k, v]) => (
        <Card key={k}>
          <CardHeader title={k!} action={<CopyButton value={v!} />} />
          <pre className="overflow-x-auto p-5 font-mono text-sm" tabIndex={0} aria-label={`${k} example`}>{v}</pre>
        </Card>
      ))}
    </div>
  );
}