'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Play } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CopyButton } from '@/app/console/admin/_shared';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Loading, Select, Table, Td, Th, statusTone } from '../ui';
import { get } from '@/lib/api';
import { label } from '@/lib/format';

interface Website { id: string; name: string; status: string; scopes: string[]; keyPrefix: string; allowedEventIds: string[] | null; canAccess: boolean }
interface DevInfo {
  apiBaseUrl: string;
  event: { id: string; slug: string; name: string; status: string; visibility: string };
  exposure: { exposed: boolean; reason: string };
  endpoints: { key: string; method: string; url: string; scope: string; note?: string }[];
  websites: Website[];
}
interface Preview { request: string; status: number; body: unknown }
interface PreviewPhoto { id: string; filename: string; urls: { thumbnail: string } }

type Lang = 'curl' | 'javascript' | 'python';

function snippet(lang: Lang, base: string, id: string): string {
  if (lang === 'curl')
    return `# Server-side only: never put the key in browser code.
curl -H "Authorization: Bearer $IU_KEY" \\
  "${base}/events/${id}/photos?pageSize=25"`;
  if (lang === 'javascript')
    return `// Run on your server (Node 18+, Next.js route handler, etc.)
const res = await fetch("${base}/events/${id}/photos?pageSize=25", {
  headers: { Authorization: \`Bearer \${process.env.IU_KEY}\` },
});
if (!res.ok) throw new Error(\`ImageUnit API \${res.status}\`);
const { items, total } = await res.json();

// items[i].urls.thumbnail / .preview are signed, expire after 1 hour and
// can be used directly in <img src="..."> in the visitor's browser.`;
  return `import os, requests

res = requests.get(
    "${base}/events/${id}/photos",
    params={"pageSize": 25},
    headers={"Authorization": f"Bearer {os.environ['IU_KEY']}"},
    timeout=10,
)
res.raise_for_status()
photos = res.json()["items"]  # each has urls.thumbnail / urls.preview`;
}

export function DeveloperTab({ eventId }: { eventId: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['developer', eventId], queryFn: () => get<DevInfo>(`/admin/events/${eventId}/developer`) });
  const [lang, setLang] = useState<Lang>('curl');
  const [clientId, setClientId] = useState('');
  const [resource, setResource] = useState<'event' | 'galleries' | 'photos'>('photos');

  const run = useMutation({ mutationFn: () => get<Preview>(`/admin/events/${eventId}/developer/preview?clientId=${clientId}&resource=${resource}&pageSize=12`) });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorNote error={error ?? new Error('Could not load developer information')} />;

  const usable = data.websites.filter((w) => w.status === 'active');
  const code = snippet(lang, data.apiBaseUrl, data.event.id);
  const json = run.data ? JSON.stringify(run.data.body, null, 2) : '';
  const photos = run.data && resource === 'photos' && run.data.status === 200 ? ((run.data.body as { items: PreviewPhoto[] }).items ?? []) : [];

  return (
    <div className="space-y-6">
      <Card className={clsx('p-5', data.exposure.exposed ? 'border-success/40' : 'border-warning/40')}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={data.exposure.exposed ? 'success' : 'warning'}>{data.exposure.exposed ? 'Available to websites' : 'Hidden from websites'}</Badge>
          <p className="text-sm text-muted">{data.exposure.reason}</p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Endpoints" description="Authenticate with a website key: Authorization: Bearer iu_live_…" />
        <ul className="divide-y divide-border">
          {data.endpoints.map((e) => (
            <li key={e.key} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Badge tone="accent">{e.method}</Badge>
              <code className="min-w-0 flex-1 break-all text-sm">{e.url}</code>
              <span className="text-xs text-muted">{e.scope}</span>
              {e.key !== 'media' && <CopyButton value={e.url} label="Copy" />}
              {e.note && <p className="w-full text-xs text-muted">{e.note}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Example"
          action={
            <div role="tablist" className="flex gap-1">
              {(['curl', 'javascript', 'python'] as Lang[]).map((l) => (
                <button key={l} role="tab" aria-selected={lang === l} onClick={() => setLang(l)} className={clsx('rounded-md px-3 py-1 text-xs font-medium', lang === l ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2')}>
                  {l === 'javascript' ? 'JavaScript' : l === 'curl' ? 'cURL' : 'Python'}
                </button>
              ))}
            </div>
          }
        />
        <div className="relative p-5">
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-4 text-xs leading-relaxed" aria-label="Code example"><code>{code}</code></pre>
          <div className="mt-3 flex justify-end"><CopyButton value={code} label="Copy code" /></div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Try it" description="Shows the exact response a website would receive for this event, including its scopes and allow-list. No key needed." />
        {usable.length === 0 ? (
          <EmptyState title="No active websites" description="Register a website to preview what it can see." action={<Link href="/console/admin/websites" className="text-accent hover:underline">Go to Websites</Link>} />
        ) : (
          <div className="space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <Field label="Website"><Select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Choose a website…</option>{usable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
              <Field label="Resource"><Select value={resource} onChange={(e) => setResource(e.target.value as typeof resource)}><option value="event">Event</option><option value="galleries">Galleries</option><option value="photos">Photos</option></Select></Field>
              <Button variant="primary" disabled={!clientId} loading={run.isPending} onClick={() => run.mutate()}><Play className="size-4" /> Run request</Button>
            </div>
            <ErrorNote error={run.error} />
            {run.data && (
              <div className="space-y-3" aria-live="polite">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={run.data.status === 200 ? 'success' : 'danger'}>{run.data.status}</Badge>
                  <code className="min-w-0 flex-1 break-all text-xs text-muted">{run.data.request}</code>
                  <CopyButton value={json} label="Copy JSON" />
                </div>
                {photos.length > 0 && (
                  <ul className="flex gap-2 overflow-x-auto pb-1">
                    {photos.map((p) => (
                      <li key={p.id} className="shrink-0"><img src={p.urls.thumbnail} alt={p.filename} className="h-20 w-28 rounded-md bg-surface-2 object-cover" loading="lazy" /></li>
                    ))}
                  </ul>
                )}
                <pre className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-4 text-xs leading-relaxed" aria-label="Response body"><code>{json}</code></pre>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Websites" description="Which credentials can currently reach this event" action={<Link href="/console/admin/websites" className="text-sm text-accent hover:underline">Manage</Link>} />
        {data.websites.length ? (
          <Table>
            <thead><tr><Th>Website</Th><Th>Key</Th><Th>Scopes</Th><Th>Status</Th><Th>Can access this event</Th></tr></thead>
            <tbody>
              {data.websites.map((w) => (
                <tr key={w.id}>
                  <Td className="font-medium">{w.name}</Td>
                  <Td><code className="text-xs">{w.keyPrefix}…</code></Td>
                  <Td className="text-xs text-muted">{w.scopes.join(', ')}</Td>
                  <Td><Badge tone={statusTone(w.status)}>{label(w.status)}</Badge></Td>
                  <Td>{w.canAccess ? <span className="inline-flex items-center gap-1 text-success"><Check className="size-4" /> Yes</span> : <span className="text-muted">{w.status !== 'active' ? 'Credential inactive' : w.allowedEventIds?.length && !w.allowedEventIds.includes(data.event.id) ? 'Not on its allow-list' : 'Event hidden'}</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No websites registered" />}
      </Card>
    </div>
  );
}
