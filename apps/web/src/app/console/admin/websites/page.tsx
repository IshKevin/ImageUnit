'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Stat, statusTone, Table, Td, Textarea, Th } from '@/components/ui';
import { get, patch, post } from '@/lib/api';
import { bytes, label, num, relative } from '@/lib/format';
import { AdminGate, SecretDialog, TimeChart } from '../_shared';

interface Website {
  id: string;
  name: string;
  description: string;
  keyPrefix: string;
  scopes: string[];
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  status: 'active' | 'disabled' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
}
type UsageRow = {
  day: string;
  requests: number;
  errors: number;
  bytesServed: number;
};
const SCOPES = ['events:read', 'galleries:read', 'images:read', 'downloads:read'];

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
  const [revoke, setRevoke] = useState<Website | null>(null);
  const [rotate, setRotate] = useState<Website | null>(null);
  const [usage, setUsage] = useState<Website | null>(null);
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
        description="Client websites that read published galleries through the public API."
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
                      <Button size="sm" onClick={() => setUsage(w)} aria-label={`Usage for ${w.name}`}><BarChart3 className="size-4" aria-hidden /> Usage</Button>
                      {w.status !== 'revoked' && (
                        <>
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
  const blank = { name: '', description: '', scopes: ['events:read', 'galleries:read', 'images:read'], origins: '', rate: '600' };
  const [f, setF] = useState(blank);
  const m = useMutation({
    mutationFn: () => {
      const origins = f.origins.split(/[\s,]+/).filter(Boolean);
      return post<{ website: Website; apiKey: string }>('/admin/websites', { name: f.name.trim(), description: f.description, scopes: f.scopes, allowedOrigins: origins, rateLimitPerMinute: Number(f.rate) });
    },
    onSuccess: (r) => { toast.success('Website created'); setF(blank); onCreated(r.website.name, r.apiKey); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="New website">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea maxLength={500} className="min-h-16" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Scopes</legend>
          <div className="grid grid-cols-2 gap-2">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={f.scopes.includes(s)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s] : f.scopes.filter((x) => x !== s) })} />
                <span className="font-mono text-xs">{s}</span>
              </label>
            ))}
          </div>
        </fieldset>
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
