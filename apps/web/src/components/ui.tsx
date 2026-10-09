'use client';

import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-surface hover:bg-surface-2',
        variant === 'ghost' && 'hover:bg-surface-2',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const field = 'w-full rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted focus:border-accent disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(field, 'h-10', className)} {...rest} />;
}
export function Checkbox({ className, onCheckedChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & { onCheckedChange?: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className={clsx('size-4 accent-[var(--accent)]', className)}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...rest}
    />
  );
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(field, 'min-h-24 py-2', className)} {...rest} />;
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(field, 'h-10', className)} {...rest} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted">{hint}</span>}
      {error && <span className="block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('rounded-xl border border-border bg-surface', className)}>{children}</section>;
}
export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES: Record<string, string> = {
  neutral: 'bg-surface-2 text-muted',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  accent: 'bg-accent/15 text-accent',
};
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone])}>{children}</span>;
}

export const statusTone = (s: string): keyof typeof TONES =>
  ({ active: 'success', ready: 'success', paid: 'success', ok: 'success', draft: 'neutral', pending_upload: 'neutral', uploaded: 'accent', processing: 'accent', expired: 'warning', suspended: 'warning', inactive: 'neutral', disabled: 'warning', archived: 'neutral', scheduled_for_deletion: 'danger', failed: 'danger', revoked: 'danger', degraded: 'danger' })[s] ?? 'neutral';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-muted', className)} aria-label="Loading" />;
}
export function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {error instanceof Error ? error.message : 'Something went wrong'}
    </p>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={clsx('m-auto w-[calc(100%-2rem)] rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/50', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div>
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 id={titleId} className="font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-surface-2">
              <X className="size-4" />
            </button>
          </div>
          <div className="p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading, children }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: string; confirmLabel?: string; danger?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-muted">{message}</p>
      {children && <div className="mt-4">{children}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={clsx('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors', value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => <th className={clsx('whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted', className)}>{children}</th>;
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={clsx('border-t border-border px-4 py-3 align-middle', className)}>{children}</td>;

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted">
      <span>
        Page {page} of {pages} · {total.toLocaleString()} total
      </span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'danger' | 'warning' }) {
  const color = { accent: 'bg-accent', danger: 'bg-danger', warning: 'bg-warning' }[tone];
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full transition-all', color)} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}
