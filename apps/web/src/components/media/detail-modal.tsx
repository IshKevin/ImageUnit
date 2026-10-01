'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Play } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Field, Input, Modal, Textarea, statusTone } from '../ui';
import { TagInput } from './parts';
import { patch, type LibraryItem } from '@/lib/api';
import { bytes, date, displayName, duration, label } from '@/lib/format';

export function DetailModal({ item, onClose, canEdit }: { item: LibraryItem | null; onClose: () => void; canEdit: boolean }) {
  return (
    <Modal open={!!item} onClose={onClose} title={item ? displayName(item) : 'Details'} wide>
      {item && <Body key={item.id} item={item} onClose={onClose} canEdit={canEdit} />}
    </Modal>
  );
}

function Body({ item, onClose, canEdit }: { item: LibraryItem; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(item.title ?? '');
  const [description, setDescription] = useState(item.description);
  const [tags, setTags] = useState(item.tags);
  const save = useMutation({
    mutationFn: () => patch(`/photos/${item.id}`, { title: title.trim() || null, description, tags }),
    onSuccess: () => {
      toast.success('Saved');
      void qc.invalidateQueries({ queryKey: ['media'] });
      void qc.invalidateQueries({ queryKey: ['library-tags'] });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const facts: [string, string][] = [
    ['Type', item.mediaType === 'video' ? 'Video' : 'Photo'],
    ['File name', item.filename],
    ['Size', bytes(item.sizeBytes)],
    ...(item.mediaType === 'video' ? ([['Duration', duration(item.durationSeconds)]] as [string, string][]) : []),
    ['Dimensions', item.width && item.height ? `${item.width} × ${item.height}` : '—'],
    ['Taken', date(item.takenAt ?? item.createdAt, true)],
  ];
  return (
    <div className="space-y-4">
      <div className="relative grid max-h-80 place-items-center overflow-hidden rounded-lg bg-surface-2">
        {item.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbUrl} alt={displayName(item)} className="max-h-80 w-full object-contain" />
        ) : (
          <div className="grid h-48 place-items-center text-sm text-muted">Preview not ready</div>
        )}
        {item.mediaType === 'video' && item.thumbUrl && (
          <span className="absolute grid size-12 place-items-center rounded-full bg-black/60 text-white"><Play className="size-6" aria-hidden /></span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={`/console/events/${item.event.id}`} className="font-medium text-accent hover:underline">{item.event.name}</Link>
        <Badge tone={statusTone(item.status)}>{label(item.status)}</Badge>
        {item.isHidden && <Badge tone="warning"><EyeOff className="mr-1 size-3" aria-hidden />Hidden</Badge>}
      </div>
      {item.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{item.error}</p>}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="truncate tabular-nums" title={v}>{v}</dd>
          </div>
        ))}
      </dl>
      <form
        className="space-y-4 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Title" hint={canEdit ? 'Leave empty to use the file name.' : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={item.filename} maxLength={200} readOnly={!canEdit} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} readOnly={!canEdit} />
        </Field>
        <TagInput label="Tags" value={tags} onChange={setTags} disabled={!canEdit} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>}
        </div>
      </form>
    </div>
  );
}
