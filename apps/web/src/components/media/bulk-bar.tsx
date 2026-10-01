'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, FolderPlus, Pencil, Tag, Tags, TextCursorInput, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, ErrorNote, Field, Input, Modal, Spinner, Textarea } from '../ui';
import { TagInput } from './parts';
import { get, post, type Collection, type LibraryItem, type Selection } from '@/lib/api';
import { displayName } from '@/lib/format';

const TOKENS = ['{event}', '{n}', '{filename}', '{date}', '{type}'];

export function renderName(tpl: string, item: LibraryItem, index: number, start: number, pad: number) {
  const date = item.event.date ?? (item.takenAt ?? item.createdAt).slice(0, 10);
  return tpl
    .replaceAll('{event}', item.event.name)
    .replaceAll('{n}', String(start + index).padStart(pad, '0'))
    .replaceAll('{filename}', item.filename.replace(/\.[^.]+$/, ''))
    .replaceAll('{date}', date)
    .replaceAll('{type}', item.mediaType)
    .slice(0, 200);
}

type Dlg = null | 'collection' | 'addTags' | 'removeTags' | 'description' | 'rename';

export function BulkBar({ selection, count, selectedItems, clear, collectionId, canEdit, canHide, canCollect, extra }: {
  selection: Selection; count: number; selectedItems: LibraryItem[]; clear: () => void; collectionId?: string;
  canEdit: boolean; canHide: boolean; canCollect: boolean; extra?: ReactNode;
}) {
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<Dlg>(null);
  const done = () => {
    setDlg(null);
    clear();
    void qc.invalidateQueries({ queryKey: ['media'] });
    void qc.invalidateQueries({ queryKey: ['library-tags'] });
  };
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<{ updated: number }>('/library/bulk', { selection, ...body }),
    onSuccess: (r) => { toast.success(`Updated ${r.updated.toLocaleString()} ${r.updated === 1 ? 'item' : 'items'}`); done(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div role="region" aria-label="Bulk actions" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-surface px-3 py-2 shadow-md">
      <span className="mr-1 text-sm font-medium tabular-nums">{count.toLocaleString()} selected</span>
      {canCollect && <Button size="sm" onClick={() => setDlg('collection')}><FolderPlus className="size-4" aria-hidden />Add to collection…</Button>}
      {canEdit && (
        <>
          <Button size="sm" onClick={() => setDlg('addTags')}><Tag className="size-4" aria-hidden />Add tags…</Button>
          <Button size="sm" onClick={() => setDlg('removeTags')}><Tags className="size-4" aria-hidden />Remove tags…</Button>
          <Button size="sm" onClick={() => setDlg('description')}><TextCursorInput className="size-4" aria-hidden />Set description…</Button>
          <Button size="sm" onClick={() => setDlg('rename')}><Pencil className="size-4" aria-hidden />Rename…</Button>
        </>
      )}
      {canHide && (
        <>
          <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ isHidden: true })}><EyeOff className="size-4" aria-hidden />Hide</Button>
          <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ isHidden: false })}><Eye className="size-4" aria-hidden />Show</Button>
        </>
      )}
      {extra}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={clear}><X className="size-4" aria-hidden />Clear</Button>

      <AddToCollection open={dlg === 'collection'} onClose={() => setDlg(null)} selection={selection} exclude={collectionId} onDone={done} />
      <TagsDialog open={dlg === 'addTags' || dlg === 'removeTags'} remove={dlg === 'removeTags'} count={count} busy={bulk.isPending} onClose={() => setDlg(null)} onSubmit={(tags) => bulk.mutate(dlg === 'removeTags' ? { removeTags: tags } : { addTags: tags })} />
      <DescriptionDialog open={dlg === 'description'} count={count} busy={bulk.isPending} onClose={() => setDlg(null)} onSubmit={(description) => bulk.mutate({ description })} />
      <RenameDialog open={dlg === 'rename'} count={count} items={selectedItems} busy={bulk.isPending} error={bulk.error} onClose={() => setDlg(null)} onSubmit={(rename) => bulk.mutate({ rename })} />
    </div>
  );
}

function AddToCollection({ open, onClose, selection, exclude, onDone }: { open: boolean; onClose: () => void; selection: Selection; exclude?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const list = useQuery({ queryKey: ['collections'], queryFn: () => get<{ items: Collection[] }>('/collections'), enabled: open });
  const add = useMutation({
    mutationFn: async (target: { id: string } | { name: string }) => {
      const id = 'id' in target ? target.id : (await post<{ collection: Collection }>('/collections', { name: target.name })).collection.id;
      return post<{ added: number; alreadyIn: number }>(`/collections/${id}/items`, { selection });
    },
    onSuccess: (r) => {
      toast.success(`Added ${r.added.toLocaleString()}${r.alreadyIn ? ` (${r.alreadyIn.toLocaleString()} were already in)` : ''}`);
      void qc.invalidateQueries({ queryKey: ['collections'] });
      setName('');
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  const items = list.data?.items.filter((c) => c.id !== exclude) ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Add to collection">
      <div className="space-y-4">
        {list.isLoading ? <div className="flex justify-center py-4"><Spinner /></div> : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {items.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={add.isPending} onClick={() => add.mutate({ id: c.id })} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{(c.itemCount ?? 0).toLocaleString()} items</span>
                </button>
              </li>
            ))}
            {!items.length && <li className="px-3 py-4 text-sm text-muted">No collections yet. Create one below.</li>}
          </ul>
        )}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) add.mutate({ name: name.trim() }); }}>
          <div className="flex-1"><Field label="Or create a new collection"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer highlights" minLength={2} maxLength={160} /></Field></div>
          <Button type="submit" variant="primary" disabled={name.trim().length < 2} loading={add.isPending}>Create and add</Button>
        </form>
      </div>
    </Modal>
  );
}

function TagsDialog({ open, remove, count, busy, onClose, onSubmit }: { open: boolean; remove: boolean; count: number; busy: boolean; onClose: () => void; onSubmit: (t: string[]) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const sugg = useQuery({ queryKey: ['library-tags', ''], queryFn: () => get<{ items: { tag: string; n: number }[] }>('/library/tags'), enabled: open && remove });
  return (
    <Modal open={open} onClose={onClose} title={remove ? 'Remove tags' : 'Add tags'}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (tags.length) onSubmit(tags); }}>
        <p className="text-sm text-muted">{remove ? 'These tags will be removed from' : 'These tags will be added to'} {count.toLocaleString()} selected {count === 1 ? 'item' : 'items'}.</p>
        <TagInput label="Tags" value={tags} onChange={setTags} />
        {remove && !!sugg.data?.items.length && (
          <div className="flex flex-wrap gap-1.5" aria-label="Existing tags">
            {sugg.data.items.slice(0, 15).map((t) => (
              <button type="button" key={t.tag} onClick={() => setTags([...new Set([...tags, t.tag])])} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-surface-2">{t.tag}</button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!tags.length} loading={busy}>{remove ? 'Remove tags' : 'Add tags'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function DescriptionDialog({ open, count, busy, onClose, onSubmit }: { open: boolean; count: number; busy: boolean; onClose: () => void; onSubmit: (d: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Set description">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit(text); }}>
        <p className="text-sm text-muted">This replaces the description of {count.toLocaleString()} selected {count === 1 ? 'item' : 'items'}. Leave empty to clear it.</p>
        <Textarea aria-label="Description" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Apply</Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDialog({ open, count, items, busy, error, onClose, onSubmit }: { open: boolean; count: number; items: LibraryItem[]; busy: boolean; error: unknown; onClose: () => void; onSubmit: (r: { template: string; start: number; pad: number }) => void }) {
  const [tpl, setTpl] = useState('{event} {n}');
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(3);
  const preview = items.slice(0, 3);
  return (
    <Modal open={open} onClose={onClose} title="Rename" wide>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (tpl.trim()) onSubmit({ template: tpl.trim(), start, pad }); }}>
        <p className="text-sm text-muted">Sets the display title of {count.toLocaleString()} selected {count === 1 ? 'item' : 'items'}. File names are not changed.</p>
        <Field label="Name template"><Input value={tpl} onChange={(e) => setTpl(e.target.value)} maxLength={200} required /></Field>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert token">
          <span className="text-xs text-muted">Insert:</span>
          {TOKENS.map((t) => (
            <button type="button" key={t} onClick={() => setTpl((v) => v + t)} className="rounded-md border border-border px-2 py-0.5 font-mono text-xs hover:bg-surface-2">{t}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start number"><Input type="number" min={0} max={1000000} value={start} onChange={(e) => setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></Field>
          <Field label="Digits (padding)"><Input type="number" min={1} max={6} value={pad} onChange={(e) => setPad(Math.min(6, Math.max(1, Math.floor(Number(e.target.value) || 1))))} /></Field>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-sm" aria-live="polite">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Preview</p>
          <ul className="space-y-1">
            {preview.map((it, i) => (
              <li key={it.id} className="flex flex-wrap gap-x-2"><span className="text-muted line-through">{displayName(it)}</span><span aria-hidden>→</span><span className="font-medium">{renderName(tpl, it, i, start, pad)}</span></li>
            ))}
            {!preview.length && <li className="text-muted">Preview unavailable for this selection.</li>}
          </ul>
          <p className="mt-2 text-xs text-muted">Numbers follow event date, then shooting time, so the final order may differ slightly from what is shown here.</p>
        </div>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Rename {count.toLocaleString()}</Button>
        </div>
      </form>
    </Modal>
  );
}
