'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, ConfirmDialog, ErrorNote, Field, Input, Select, Textarea } from '../ui';
import { del, patch, post, type DownloadPolicy, type EventItem } from '@/lib/api';
import { date, toLocalInput } from '@/lib/format';
import { useMe } from '@/lib/auth';
import { useRouter } from 'next/navigation';

export function SettingsTab({ event }: { event: EventItem }) {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const isAdmin = user?.role === 'admin';
  const readOnly = ['archived', 'scheduled_for_deletion'].includes(event.status) && !isAdmin;
  const expiryLocked = !isAdmin && event.status !== 'draft';
  const [f, setF] = useState({
    name: event.name, description: event.description, eventDate: event.eventDate ?? '', location: event.location ?? '',
    visibility: event.visibility, downloadPolicy: event.downloadPolicy as DownloadPolicy, password: '', expiresAt: toLocalInput(event.expiresAt),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<null | 'archive' | 'delete' | 'extend' | 'reactivate'>(null);
  const [confirmText, setConfirmText] = useState('');
  const [extendTo, setExtendTo] = useState(toLocalInput(new Date(Date.now() + 30 * 864e5).toISOString()));

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['event', event.id] }); void qc.invalidateQueries({ queryKey: ['events'] }); };
  const save = useMutation({
    mutationFn: () => patch(`/events/${event.id}`, {
      name: f.name, description: f.description, eventDate: f.eventDate || null, location: f.location || null,
      visibility: f.visibility, downloadPolicy: f.downloadPolicy,
      ...(f.password && { password: f.password }),
      ...(!expiryLocked && { expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null }),
    }),
    onSuccess: () => { toast.success('Settings saved'); set('password', ''); refresh(); },
  });
  const action = useMutation({
    mutationFn: (a: 'publish' | 'unpublish' | 'archive' | 'extend' | 'reactivate') =>
      post(`/events/${event.id}/${a}`, a === 'extend' || a === 'reactivate' ? { expiresAt: new Date(extendTo).toISOString() } : {}),
    onSuccess: (_d, a) => { toast.success(`Event ${a === 'publish' ? 'published' : a === 'unpublish' ? 'moved to draft' : a + 'd'}`.replace('extendd', 'extended')); setDialog(null); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const destroy = useMutation({
    mutationFn: () => del(`/events/${event.id}?confirm=${encodeURIComponent(confirmText)}`),
    onSuccess: () => { toast.success('Event permanently deleted'); router.replace('/console/events'); },
    onError: (e) => toast.error(e.message),
  });

  const copy = async () => { await navigator.clipboard.writeText(event.shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const canPublish = user?.permissions.includes('events:publish');

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Event details" />
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4 p-5">
            <fieldset disabled={readOnly} className="space-y-4">
              <Field label="Name"><Input required minLength={2} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Date"><Input type="date" value={f.eventDate} onChange={(e) => set('eventDate', e.target.value)} /></Field>
                <Field label="Location"><Input value={f.location} onChange={(e) => set('location', e.target.value)} /></Field>
              </div>
              <Field label="Description"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Who can view">
                  <Select value={f.visibility} onChange={(e) => set('visibility', e.target.value as EventItem['visibility'])}>
                    <option value="public">Public</option><option value="unlisted">Unlisted (link only)</option><option value="private">Password protected</option>
                  </Select>
                </Field>
                <Field label="Downloads">
                  <Select value={f.downloadPolicy} onChange={(e) => set('downloadPolicy', e.target.value as DownloadPolicy)}>
                    <option value="disabled">Disabled</option><option value="preview">Preview quality</option><option value="full">Full resolution</option>
                  </Select>
                </Field>
              </div>
              {f.visibility === 'private' && <Field label={event.hasPassword ? 'Change password' : 'Password'} hint={event.hasPassword ? 'Leave blank to keep the current password. Changing it signs out existing visitors.' : 'Required for private events.'}><Input minLength={6} value={f.password} onChange={(e) => set('password', e.target.value)} /></Field>}
              <Field label="Public access ends" hint={expiryLocked ? 'Only an administrator can change access after publishing.' : 'Expiring hides the gallery; photographs are retained.'}>
                <Input type="datetime-local" disabled={expiryLocked} value={f.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
              </Field>
            </fieldset>
            <ErrorNote error={save.error} />
            {!readOnly && <Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button>}
          </form>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader title="Administration" description="Administrator-only lifecycle controls. All actions are recorded in the audit log." />
            <div className="flex flex-wrap gap-2 p-5">
              {['active', 'expired'].includes(event.status) && <Button onClick={() => setDialog('extend')}>Extend access</Button>}
              {['expired', 'archived', 'scheduled_for_deletion'].includes(event.status) && <Button onClick={() => setDialog('reactivate')}>Reactivate</Button>}
              {!['archived', 'scheduled_for_deletion'].includes(event.status) && <Button onClick={() => setDialog('archive')}>Archive</Button>}
              {['archived', 'scheduled_for_deletion'].includes(event.status) && <Button variant="danger" onClick={() => { setConfirmText(''); setDialog('delete'); }}>Delete permanently…</Button>}
            </div>
            {event.retentionReviewAt && <p className="px-5 pb-5 text-sm text-muted">Retention review due {date(event.retentionReviewAt)}</p>}
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader title="Publishing" />
          <div className="space-y-3 p-5 text-sm">
            <p>Status: <strong className="capitalize">{event.status.replace(/_/g, ' ')}</strong></p>
            {event.expiresAt && <p className="text-muted">Public until {date(event.expiresAt, true)}</p>}
            {canPublish && event.status === 'draft' && <Button variant="primary" className="w-full" loading={action.isPending} onClick={() => action.mutate('publish')}>Publish event</Button>}
            {canPublish && event.status === 'active' && <Button className="w-full" loading={action.isPending} onClick={() => action.mutate('unpublish')}>Unpublish (back to draft)</Button>}
            {action.error && <ErrorNote error={action.error} />}
          </div>
        </Card>

        <Card>
          <CardHeader title="Share" />
          <div className="space-y-4 p-5">
            <div className="flex gap-2">
              <Input readOnly value={event.shareUrl} aria-label="Public link" onFocus={(e) => e.target.select()} />
              <Button onClick={copy} aria-label="Copy link">{copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}</Button>
            </div>
            {event.status !== 'active' && <p className="text-xs text-warning">This link works only while the event is active.</p>}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/events/${event.id}/qr?format=svg`} alt={`QR code linking to ${event.name}`} className="mx-auto w-48 rounded-lg bg-white p-2" />
            <div className="flex gap-2">
              <a className="flex-1" href={`/api/events/${event.id}/qr?format=png&size=1024&download=true`}><Button className="w-full"><Download className="size-4" /> QR PNG</Button></a>
              <a className="flex-1" href={`/api/events/${event.id}/qr?format=svg&download=true`}><Button className="w-full"><Download className="size-4" /> SVG</Button></a>
            </div>
            <a href={event.shareUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">Open public page <ExternalLink className="size-3.5" /></a>
          </div>
        </Card>
      </div>

      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(null)} onConfirm={() => action.mutate('archive')} loading={action.isPending} title="Archive event?" message="The public link stops working immediately. Photographs are kept until the retention period ends and an administrator reviews them." confirmLabel="Archive" />
      <ConfirmDialog open={dialog === 'extend' || dialog === 'reactivate'} onClose={() => setDialog(null)} onConfirm={() => action.mutate(dialog === 'extend' ? 'extend' : 'reactivate')} loading={action.isPending} title={dialog === 'extend' ? 'Extend access' : 'Reactivate event'} message="Choose when public access should end." confirmLabel={dialog === 'extend' ? 'Extend' : 'Reactivate'}>
        <Input type="datetime-local" value={extendTo} onChange={(e) => setExtendTo(e.target.value)} aria-label="New expiry" />
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'delete'} onClose={() => setDialog(null)} onConfirm={() => destroy.mutate()} loading={destroy.isPending} danger title="Permanently delete event?" message={`This deletes the event, its galleries and every photograph from storage. It cannot be undone. Type "${event.slug}" to confirm.`} confirmLabel="Delete forever">
        <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={event.slug} aria-label="Confirm event link" />
      </ConfirmDialog>
    </div>
  );
}
