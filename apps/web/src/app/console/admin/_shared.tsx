'use client';

import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, EmptyState, Loading, Modal, Card } from '@/components/ui';
import { can, useMe } from '@/lib/auth';

/** Resolves whether the current user may see an admin page. `perm === 'admin'` requires the admin role. */
export function useAdminGuard(perm: string) {
  const me = useMe();
  const allowed = !!me.data && (perm === 'admin' ? me.data.role === 'admin' : can(me.data, perm));
  return { loading: me.isLoading, allowed };
}

export function AdminGate({ perm, children }: { perm: string; children: ReactNode }) {
  const g = useAdminGuard(perm);
  if (g.loading) return <Loading />;
  if (!g.allowed) {
    return (
      <Card>
        <EmptyState title="Administrators only" description="You do not have permission to view this page." />
      </Card>
    );
  }
  return <>{children}</>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast.error('Could not copy. Select the text and copy it manually.');
        }
      }}
    >
      {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Shows a secret (temporary password / API key) exactly once. */
export function SecretDialog({ open, onClose, title, secret, warning }: { open: boolean; onClose: () => void; title: string; secret: string; warning: string }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{warning}</span>
        </p>
        <code className="block break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm select-all" aria-label="Secret value">
          {secret}
        </code>
        <div className="flex justify-end gap-2">
          <CopyButton value={secret} />
          <Button variant="primary" onClick={onClose}>
            I have saved it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

/** Accessible dependency-free SVG chart. `mode="bars"` draws grouped bars, `mode="line"` draws lines. */
export function TimeChart({ rows, series, xKey, mode, title }: { rows: Record<string, number | string>[]; series: ChartSeries[]; xKey: string; mode: 'bars' | 'line'; title: string }) {
  const W = 720;
  const H = 220;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const rawMax = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
  const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax / step) * step;
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));
  const n = rows.length;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const groupW = iw / Math.max(n, 1);
  const barW = Math.max((groupW * 0.8) / series.length, 1);
  const labelEvery = Math.max(Math.ceil(n / 6), 1);

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title}>
        <title>{title}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : '3 3'} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {mode === 'bars'
          ? rows.map((r, i) =>
              series.map((s, si) => {
                const v = Number(r[s.key]) || 0;
                const bx = pad.l + i * groupW + groupW * 0.1 + si * barW;
                return (
                  <rect key={`${i}-${s.key}`} x={bx} y={y(v)} width={Math.max(barW - 1, 1)} height={pad.t + ih - y(v)} rx="1.5" fill={s.color}>
                    <title>{`${r[xKey]}: ${v.toLocaleString()} ${s.label.toLowerCase()}`}</title>
                  </rect>
                );
              }),
            )
          : series.map((s) => (
              <g key={s.key}>
                <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" points={rows.map((r, i) => `${x(i)},${y(Number(r[s.key]) || 0)}`).join(' ')} />
                {rows.map((r, i) => (
                  <circle key={i} cx={x(i)} cy={y(Number(r[s.key]) || 0)} r="2.5" fill={s.color}>
                    <title>{`${r[xKey]}: ${(Number(r[s.key]) || 0).toLocaleString()} ${s.label.toLowerCase()}`}</title>
                  </circle>
                ))}
              </g>
            ))}
        {rows.map((r, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={mode === 'bars' ? pad.l + i * groupW + groupW / 2 : x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {String(r[xKey]).slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Date</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r[xKey]}</td>
              {series.map((s) => (
                <td key={s.key}>{Number(r[s.key]) || 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
