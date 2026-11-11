'use client';

import clsx from 'clsx';
import { AlertCircle, ChevronLeft, ChevronRight, Inbox, Loader2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-accent text-accent-fg shadow-sm shadow-accent/25 hover:bg-accent-strong',
        variant === 'secondary' && 'border border-border bg-surface text-fg shadow-card hover:border-border-strong hover:bg-surface-2',
        variant === 'ghost' && 'text-fg hover:bg-surface-2',
        variant === 'danger' && 'bg-danger text-white shadow-sm shadow-danger/25 hover:brightness-110',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const field =
  'w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg shadow-card transition-[border-color,box-shadow] placeholder:text-muted/80 hover:border-border-strong focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(field, 'h-10', className)} {...rest} />;
}
export function Checkbox({ className, onCheckedChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & { onCheckedChange?: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className={clsx('size-4 cursor-pointer rounded accent-[var(--accent)]', className)}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...rest}
    />
  );
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(field, 'min-h-24 py-2 leading-relaxed', className)} {...rest} />;
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(field, 'h-10 cursor-pointer pr-8', className)} {...rest} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted">{hint}</span>}
      {error && <span className="block text-xs font-medium text-danger">{error}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('rounded-2xl border border-border bg-surface shadow-card', className)}>{children}</section>;
}
export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES: Record<string, string> = {
  neutral: 'bg-surface-2 text-muted ring-border',
  success: 'bg-success/10 text-success ring-success/20',
  warning: 'bg-warning/10 text-warning ring-warning/20',
  danger: 'bg-danger/10 text-danger ring-danger/20',
  accent: 'bg-accent/10 text-accent ring-accent/20',
};
const DOTS: Record<string, string> = { neutral: 'bg-muted', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', accent: 'bg-accent' };
export function Badge({ tone = 'neutral', dot, children }: { tone?: keyof typeof TONES; dot?: boolean; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone])}>
      {dot && <span className={clsx('size-1.5 rounded-full', DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export const statusTone = (s: string): keyof typeof TONES =>
  ({ active: 'success', ready: 'success', paid: 'success', ok: 'success', draft: 'neutral', pending_upload: 'neutral', uploaded: 'accent', processing: 'accent', expired: 'warning', suspended: 'warning', inactive: 'neutral', disabled: 'warning', archived: 'neutral', scheduled_for_deletion: 'danger', failed: 'danger', revoked: 'danger', degraded: 'danger' })[s] ?? 'neutral';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-muted', className)} aria-label="Loading" />;
}
export function Loading() {
  return (
    <div className="flex animate-fade-in justify-center py-20">
      <Spinner className="size-6 text-accent" />
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-surface-2', className)} aria-hidden />;
}
export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description?: string; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex animate-fade-in flex-col items-center gap-2 px-6 py-16 text-center">
      <div className="mb-2 grid size-12 place-items-center rounded-2xl bg-accent/10 text-accent ring-8 ring-accent/5">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="font-semibold">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{error instanceof Error ? error.message : 'Something went wrong'}</span>
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
      className={clsx('m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-border bg-surface p-0 text-fg shadow-pop', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="flex items-center justify-between gap-4 px-6 pb-2 pt-5">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="-mr-2 grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-6 pb-6 pt-3">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading, children }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: string; confirmLabel?: string; danger?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      {children && <div className="mt-4">{children}</div>}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
    <div className="mb-6 overflow-x-auto">
      <div role="tablist" className="inline-flex min-w-full gap-1 border-b border-border sm:min-w-0 sm:rounded-xl sm:border sm:bg-surface-2/70 sm:p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            className={clsx(
              'relative whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-all sm:rounded-lg sm:py-1.5',
              value === t.id
                ? 'text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent sm:bg-surface sm:shadow-card sm:after:hidden'
                : 'text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, icon: Icon }: { label: string; value: ReactNode; sub?: string; icon?: LucideIcon }) {
  return (
    <Card className="group relative overflow-hidden p-5 transition-shadow hover:shadow-pop">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {Icon && (
          <span className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent">
            <Icon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      {sub && <p className="mt-2 text-xs text-muted">{sub}</p>}
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
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => <th className={clsx('whitespace-nowrap bg-surface-2/60 px-4 py-2.5 text-left text-xs font-medium text-muted first:pl-5 last:pr-5', className)}>{children}</th>;
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={clsx('border-t border-border px-4 py-3.5 align-middle first:pl-5 last:pr-5', className)}>{children}</td>;

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm text-muted">
      <span>
        Showing <span className="font-medium text-fg tabular-nums">{from.toLocaleString()}–{to.toLocaleString()}</span> of <span className="font-medium text-fg tabular-nums">{total.toLocaleString()}</span>
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /> Previous</Button>
        <span className="hidden tabular-nums sm:inline">{page} / {pages}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">Next <ChevronRight className="size-4" /></Button>
      </div>
    </div>
  );
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'danger' | 'warning' }) {
  const color = { accent: 'bg-accent', danger: 'bg-danger', warning: 'bg-warning' }[tone];
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full transition-all duration-500', color)} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}

/** Initials in a coloured circle, stable per name. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
  const hues = [250, 200, 160, 20, 330, 280, 40];
  const hue = hues[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
  return (
    <span aria-hidden className={clsx('grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white', className)} style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue! + 40) % 360} 70% 48%))` }}>
      {initials}
    </span>
  );
}
