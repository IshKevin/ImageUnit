'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote, Input, Loading, statusTone } from '../ui';
import { useDebounced } from '../media/parts';
import { del, get, post, qs, type EventItem, type EventMember, type MemberCandidate } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, label } from '@/lib/format';

interface Members { owner: { id: string; name: string; email: string; role: string }; items: EventMember[] }

export function TeamTab({ event }: { event: EventItem }) {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const eid = event.id;
  const canInvite = user?.role === 'admin' || user?.role === 'editor';
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [removing, setRemoving] = useState<EventMember | null>(null);

  const members = useQuery({ queryKey: ['members', eid], queryFn: () => get<Members>(`/events/${eid}/members`) });
  const candidates = useQuery({
    queryKey: ['member-candidates', eid, dq],
    queryFn: () => get<{ items: MemberCandidate[] }>(`/events/${eid}/member-candidates${qs({ q: dq })}`),
    enabled: canInvite,
    placeholderData: (p) => p,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members', eid] });
    void qc.invalidateQueries({ queryKey: ['member-candidates', eid] });
    void qc.invalidateQueries({ queryKey: ['event', eid] });
  };
  const invite = useMutation({
    mutationFn: (c: MemberCandidate) => post(`/events/${eid}/members`, { userId: c.id }),
    onSuccess: (_r, c) => { toast.success(`Invited ${c.name.split(' ')[0]} — they have been notified`); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (m: EventMember) => del(`/events/${eid}/members/${m.userId}`),
    onSuccess: () => { toast.success('Photographer removed'); setRemoving(null); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  const list = candidates.data?.items ?? [];
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">Invited photographers can upload photos and videos to this event and edit their own uploads.</p>

      <Card>
        <CardHeader title="Team" description={canInvite ? undefined : 'Only editors and administrators can invite photographers.'} />
        {members.isLoading ? <Loading /> : members.error ? <div className="p-4"><ErrorNote error={members.error} /></div> : (
          <ul className="divide-y divide-border">
            {members.data && (
              <li className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{members.data.owner.name}</p><p className="truncate text-xs text-muted">{members.data.owner.email}</p></div>
                <Badge tone="accent">Owner</Badge>
              </li>
            )}
            {members.data?.items.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.name}</p><p className="truncate text-xs text-muted">{m.email}</p></div>
                <Badge tone={statusTone(m.status)}>{label(m.status)}</Badge>
                <span className="text-xs text-muted">Invited {date(m.invitedAt)}</span>
                {canInvite && <Button size="sm" variant="ghost" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}><UserMinus className="size-3.5" /> Remove</Button>}
              </li>
            ))}
            {members.data && members.data.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No photographers have been invited yet.</li>}
          </ul>
        )}
      </Card>

      {canInvite && (
        <Card>
          <CardHeader title="Invite photographers" description="Search active photographers and add them to this event." />
          <div className="space-y-3 p-4">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" aria-label="Search photographers" /></div>
            {candidates.isLoading ? <Loading /> : candidates.error ? <ErrorNote error={candidates.error} /> : list.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Photographers you can invite">
                {list.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{c.name}</p><p className="truncate text-xs text-muted">{c.email}</p></div>
                    <Button size="sm" variant="primary" onClick={() => invite.mutate(c)} loading={invite.isPending && invite.variables?.id === c.id} aria-label={`Invite ${c.name}`}><UserPlus className="size-3.5" /> Invite</Button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title={dq ? 'No photographers match' : 'Everyone is already invited'} description={dq ? 'Try a different name or email.' : undefined} />}
          </div>
        </Card>
      )}

      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} loading={remove.isPending} danger title={removing ? `Remove ${removing.name}?` : 'Remove photographer?'} message="They lose access immediately; their uploads stay in the event." confirmLabel="Remove" />
    </div>
  );
}
