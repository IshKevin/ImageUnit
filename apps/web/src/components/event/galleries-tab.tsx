'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, ConfirmDialog, ErrorNote, Input, Loading, Select } from '../ui';
import { del, get, patch, post, type DownloadPolicy, type EventItem, type Gallery } from '@/lib/api';

export function GalleriesTab({ event }: { event: EventItem }) {
  const qc = useQueryClient();
  const key = ['galleries', event.id];
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Gallery | null>(null);
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => get<{ items: Gallery[] }>(`/events/${event.id}/galleries`) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const onError = (e: Error) => toast.error(e.message);

  const add = useMutation({ mutationFn: () => post(`/events/${event.id}/galleries`, { name }), onSuccess: () => { setName(''); void refresh(); }, onError });
  const update = useMutation({ mutationFn: ({ id, ...body }: { id: string } & Partial<Gallery>) => patch(`/galleries/${id}`, body), onSuccess: () => void refresh(), onError });
  const reorder = useMutation({ mutationFn: (ids: string[]) => post(`/events/${event.id}/galleries/reorder`, { ids }), onSuccess: () => void refresh(), onError });
  const remove = useMutation({ mutationFn: (id: string) => del(`/galleries/${id}`), onSuccess: () => { setRemoving(null); void refresh(); void qc.invalidateQueries({ queryKey: ['photos', event.id] }); }, onError });

  if (isLoading || !data) return <Loading />;
  const items = data.items;
  const move = (i: number, d: -1 | 1) => {
    const ids = items.map((g) => g.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <div className="space-y-4">
      <Card>
        <ul className="divide-y divide-border">
          {items.map((g, i) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex flex-col">
                <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="disabled:opacity-30"><ArrowUp className="size-4" /></button>
                <button disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="disabled:opacity-30"><ArrowDown className="size-4" /></button>
              </div>
              <Input className="h-9 min-w-40 flex-1" defaultValue={g.name} aria-label="Gallery name" onBlur={(e) => e.target.value.trim() && e.target.value !== g.name && update.mutate({ id: g.id, name: e.target.value.trim() })} />
              <span className="w-24 text-sm tabular-nums text-muted">{g.readyCount}/{g.photoCount} photos</span>
              <Select className="h-9 w-44" aria-label="Download policy" value={g.downloadPolicy ?? ''} onChange={(e) => update.mutate({ id: g.id, downloadPolicy: (e.target.value || null) as DownloadPolicy | null })}>
                <option value="">Downloads: event default</option><option value="disabled">Downloads: disabled</option><option value="preview">Downloads: preview</option><option value="full">Downloads: full</option>
              </Select>
              <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: g.id, isVisible: !g.isVisible })} aria-label={g.isVisible ? 'Hide gallery' : 'Show gallery'}>{g.isVisible ? <Eye className="size-4" /> : <EyeOff className="size-4 text-muted" />}</Button>
              <Button size="sm" variant="ghost" disabled={items.length <= 1} onClick={() => setRemoving(g)} aria-label="Delete gallery"><Trash2 className="size-4" /></Button>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-sm text-muted">A gallery can restrict downloads but never allow more than the event does.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }} className="flex gap-2">
        <Input placeholder="New gallery, e.g. Finish Line" value={name} onChange={(e) => setName(e.target.value)} aria-label="New gallery name" />
        <Button type="submit" variant="primary" loading={add.isPending}>Add gallery</Button>
      </form>
      <ErrorNote error={add.error} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} loading={remove.isPending} title={`Delete “${removing?.name}”?`} message="Photographs in this gallery are not deleted; they become ungrouped." confirmLabel="Delete gallery" danger />
    </div>
  );
}
