'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ImageIcon, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Textarea, statusTone } from '@/components/ui';
import { useDebounced } from '@/components/media/parts';
import { get, post, qs, type Collection, type Website } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { label, relative } from '@/lib/format';

export default function CollectionsPage() {
  const { data: user, isLoading: meLoading } = useMe();
  const router = useRouter();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteIds, setWebsiteIds] = useState<string[]>([]);
  const allowed = can(user, 'collections:manage');

  const websites = useQuery({
    queryKey: ['admin-websites'],
    queryFn: () => get<{ items: Website[] }>('/admin/websites'),
    enabled: creating,
  });

  const list = useQuery({ queryKey: ['collections', dq], queryFn: () => get<{ items: Collection[] }>(`/collections${qs({ q: dq })}`), enabled: allowed, placeholderData: (p) => p });
  const create = useMutation({
    mutationFn: () => post<{ collection: Collection }>('/collections', { name: name.trim(), description, websiteIds }),
    onSuccess: (r) => { toast.success('Collection created'); router.push(`/console/collections/${r.collection.id}`); },
    onError: (e) => toast.error(e.message),
  });

  if (meLoading) return <Loading />;
  if (!allowed) return <Card><EmptyState title="You don't have access to collections" /></Card>;

  return (
    <>
      <PageHeader title="Collections" description="Hand-picked sets of photographs and videos from any event, served to company websites" actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New collection</Button>} />
      <div className="relative mb-4 max-w-md">
        <label htmlFor="coll-search" className="sr-only">Search collections</label>
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden />
        <Input id="coll-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections…" className="pl-9" />
      </div>
      <ErrorNote error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.items.length ? (
        <Card><EmptyState title={dq ? 'No collections match your search' : 'No collections yet'} description={dq ? undefined : 'Create a collection to group media from several events and publish it to a website.'} action={dq ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New collection</Button>} /></Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.data.items.map((c) => (
            <li key={c.id}>
              <Link href={`/console/collections/${c.id}`} className="block overflow-hidden rounded-xl border border-border bg-surface transition-shadow hover:shadow-md">
                <div className="aspect-[16/10] bg-surface-2">
                  {c.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.coverUrl} alt="" loading="lazy" className="size-full object-cover" />
                  ) : (
                    <div className="grid size-full place-items-center text-muted"><ImageIcon className="size-8" aria-hidden /></div>
                  )}
                </div>
                <div className="space-y-1 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate font-semibold">{c.name}</h2>
                    <Badge tone={statusTone(c.status === 'published' ? 'active' : 'draft')}>{label(c.status)}</Badge>
                  </div>
                  <p className="text-sm tabular-nums text-muted">{(c.itemCount ?? 0).toLocaleString()} items · updated {relative(c.updatedAt)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New collection">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} autoFocus /></Field>
          <Field label="Description" hint="Optional. Returned to the website with the collection."><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></Field>
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
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={name.trim().length < 2}>Create</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}