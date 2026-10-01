'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Input, Spinner } from '../ui';
import { get, qs, type EventItem } from '@/lib/api';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const normTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);

/** Chips input: Enter or comma adds, Backspace on an empty field removes the last one. */
export function TagInput({ value, onChange, label, disabled, placeholder = 'Add a tag and press Enter' }: { value: string[]; onChange: (t: string[]) => void; label: string; disabled?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const commit = (raw: string) => {
    const add = raw.split(',').map(normTag).filter(Boolean);
    if (add.length) onChange([...new Set([...value, ...add])]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 focus-within:border-accent">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs font-medium">
            {t}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="rounded-full p-0.5 hover:bg-border">
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => commit(draft)} placeholder={value.length ? '' : placeholder} className="h-7 min-w-32 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted" />
        )}
        {disabled && !value.length && <span className="px-1.5 text-sm text-muted">No tags</span>}
      </div>
    </div>
  );
}

/** Searchable event filter backed by GET /events?q= */
export function EventPicker({ value, onChange, label = 'Event' }: { value: { id: string; name: string } | null; onChange: (e: { id: string; name: string } | null) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const box = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: ['events-pick', dq],
    queryFn: () => get<{ items: EventItem[] }>(`/events${qs({ q: dq, pageSize: 200 })}`),
    enabled: open,
    placeholderData: (p) => p,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={box} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <span className="sr-only">{label}</span>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-sm">
        <span className={clsx('truncate', !value && 'text-muted')}>{value ? value.name : 'All events'}</span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-72 max-w-[85vw] rounded-lg border border-border bg-surface p-2 shadow-lg">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events…" aria-label="Search events" />
          <ul role="listbox" aria-label={label} className="mt-2 max-h-60 overflow-y-auto">
            <Opt selected={!value} onClick={() => { onChange(null); setOpen(false); }}>All events</Opt>
            {list.isFetching && !list.data && <li className="flex justify-center py-3"><Spinner /></li>}
            {list.data?.items.map((e) => (
              <Opt key={e.id} selected={value?.id === e.id} onClick={() => { onChange({ id: e.id, name: e.name }); setOpen(false); }}>{e.name}</Opt>
            ))}
            {list.data && !list.data.items.length && <li className="px-2 py-3 text-sm text-muted">No events found</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Opt({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <li role="option" aria-selected={selected}>
      <button type="button" onClick={onClick} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2">
        <span className="truncate">{children}</span>
        {selected && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
      </button>
    </li>
  );
}

/** Large modal (the shared Modal tops out at max-w-2xl). */
export function BigModal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} className="m-auto h-[90vh] w-[calc(100%-1.5rem)] max-w-6xl rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/50">
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 id={titleId} className="font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-surface-2"><X className="size-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
