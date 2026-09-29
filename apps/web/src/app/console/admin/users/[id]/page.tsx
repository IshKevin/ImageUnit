'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Select, Stat, statusTone, Table, Td, Th } from '@/components/ui';
import { get, patch, post, type EventItem, type User } from '@/lib/api';
import { bytes, date, label, num, relative } from '@/lib/format';
import { AdminGate, SecretDialog } from '../../_shared';

const GRANTABLE = ['events:view', 'events:create', 'events:edit', 'events:publish', 'images:upload', 'galleries:manage', 'stats:view', 'images:download'];
const ADMIN_ONLY = ['users:manage', 'websites:manage', 'api:manage', 'images:delete', 'events:delete', 'settings:manage', 'audit:view'];
const DEFAULTS = ['events:view', 'events:create', 'events:edit', 'events:publish', 'images:upload', 'galleries:manage', 'stats:view', 'images:download'];
const GB = 1024 ** 3;

interface Detail {
  user: User;
  stats: { events: number; photos: number; storageBytes: number };
}
interface Activity {
  id: string;
  action: string;
  actorLabel: string | null;
  createdAt: string;
  entityType: string | null;
}

export default function UserDetailPage() {
  return (
    <AdminGate perm="users:manage">
      <UserDetail />
    </AdminGate>
  );
}

function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['admin-user', id], queryFn: () => get<Detail>(`/admin/users/${id}`) });
  const events = useQuery({ queryKey: ['admin-user-events', id], queryFn: () => get<{ items: EventItem[] }>(`/admin/users/${id}/events`) });
  const activity = useQuery({ queryKey: ['admin-user-activity', id], queryFn: () => get<{ items: Activity[] }>(`/admin/users/${id}/activity`) });

  const [perms, setPerms] = useState<string[]>([]);
  const [quota, setQuota] = useState('');
  const [role, setRole] = useState('photographer');
  const [confirm, setConfirm] = useState<'suspended' | 'inactive' | 'active' | 'reset' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const u = detail.data?.user;
  useEffect(() => {
    if (!u) return;
    setPerms(GRANTABLE.filter((p) => u.permissions.includes(p)));
    setQuota(u.storageQuotaBytes ? String(+(u.storageQuotaBytes / GB).toFixed(2)) : '');
    setRole(u.role);
  }, [u]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-user', id] });
    qc.invalidateQueries({ queryKey: ['admin-user-activity', id] });
    qc.invalidateQueries({ queryKey: ['admin-users'] });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Request failed');

  const status = useMutation({
    mutationFn: (s: string) => post(`/admin/users/${id}/status`, { status: s }),
    onSuccess: () => { toast.success('Status updated'); setConfirm(null); refresh(); },
    onError: (e) => { setConfirm(null); fail(e); },
  });
  const reset = useMutation({
    mutationFn: () => post<{ temporaryPassword?: string }>(`/admin/users/${id}/reset-password`, {}),
    onSuccess: (r) => { setConfirm(null); refresh(); if (r.temporaryPassword) setSecret(r.temporaryPassword); else toast.success('Password reset'); },
    onError: (e) => { setConfirm(null); fail(e); },
  });
  const savePerms = useMutation({
    mutationFn: () => patch(`/admin/users/${id}`, { grantedPermissions: perms.filter((p) => !DEFAULTS.includes(p)), revokedPermissions: DEFAULTS.filter((p) => !perms.includes(p)) }),
    onSuccess: () => { toast.success('Permissions saved'); refresh(); },
    onError: fail,
  });
  const saveRole = useMutation({
    mutationFn: () => patch(`/admin/users/${id}`, { role }),
    onSuccess: () => { toast.success('Role updated'); refresh(); },
    onError: fail,
  });
  const saveQuota = useMutation({
    mutationFn: () => {
      const n = Number(quota);
      if (quota.trim() !== '' && (!Number.isFinite(n) || n <= 0)) throw new Error('Quota must be a positive number of GB, or blank for unlimited');
      return patch(`/admin/users/${id}`, { storageQuotaBytes: quota.trim() === '' ? null : Math.round(n * GB) });
    },
    onSuccess: () => { toast.success('Quota saved'); refresh(); },
    onError: fail,
  });

  if (detail.isLoading) return <Loading />;
  if (detail.error || !u || !detail.data) return <ErrorNote error={detail.error ?? new Error('User not found')} />;
  const { stats } = detail.data;
  const isAdmin = u.role === 'admin';
  const confirmText = {
    suspended: ['Suspend user', 'The user is signed out immediately and cannot sign in until reactivated.', 'Suspend'],
    inactive: ['Deactivate user', 'The user is signed out and their account is disabled.', 'Deactivate'],
    active: ['Activate user', 'The user will be able to sign in again.', 'Activate'],
    reset: ['Reset password', 'A new temporary password is generated and all sessions are ended.', 'Reset password'],
  } as const;
  const c = confirm ? confirmText[confirm] : null;

  return (
    <div className="space-y-6">
      <Link href="/console/admin/users" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Users
      </Link>
      <PageHeader
        title={u.name}
        description={u.email}
        actions={
          <>
            {u.status !== 'active' && <Button variant="primary" onClick={() => setConfirm('active')}>Activate</Button>}
            {u.status === 'active' && <Button onClick={() => setConfirm('suspended')}>Suspend</Button>}
            {u.status !== 'inactive' && <Button onClick={() => setConfirm('inactive')}>Deactivate</Button>}
            <Button onClick={() => setConfirm('reset')}><KeyRound className="size-4" aria-hidden /> Reset password</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Status" value={<Badge tone={statusTone(u.status)}>{label(u.status)}</Badge>} sub={`Last login ${u.lastLoginAt ? relative(u.lastLoginAt) : 'never'}`} />
        <Stat label="Events" value={num(stats.events)} />
        <Stat label="Photos" value={num(stats.photos)} />
        <Stat label="Storage" value={bytes(stats.storageBytes)} sub={u.storageQuotaBytes ? `of ${bytes(u.storageQuotaBytes)}` : 'No quota'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <dl className="grid grid-cols-[8rem_1fr] gap-y-3 p-5 text-sm">
            <dt className="text-muted">Name</dt><dd>{u.name}</dd>
            <dt className="text-muted">Email</dt><dd className="break-all">{u.email}</dd>
            <dt className="text-muted">Created</dt><dd>{date(u.createdAt, true)}</dd>
            <dt className="text-muted">Role</dt><dd><Badge tone={isAdmin ? 'accent' : 'neutral'}>{label(u.role)}</Badge></dd>
          </dl>
          <form className="flex items-end gap-2 border-t border-border p-5" onSubmit={(e) => { e.preventDefault(); saveRole.mutate(); }}>
            <div className="flex-1">
              <Field label="Change role">
                <Select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="photographer">Photographer</option>
                  <option value="admin">Administrator</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={role === u.role} loading={saveRole.isPending}>Save role</Button>
          </form>
        </Card>

        <Card>
          <CardHeader title="Storage quota" description="Maximum storage this user may consume." />
          <form className="flex items-end gap-2 p-5" onSubmit={(e) => { e.preventDefault(); saveQuota.mutate(); }}>
            <div className="flex-1">
              <Field label="Quota (GB)" hint="Leave blank for unlimited.">
                <Input type="number" min="0.01" step="any" inputMode="decimal" placeholder="Unlimited" value={quota} onChange={(e) => setQuota(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={saveQuota.isPending}>Save quota</Button>
          </form>
        </Card>
      </div>

      <Card>
        <CardHeader title="Permissions" description={isAdmin ? 'Administrators hold every permission.' : 'Adjust what this photographer can do. Defaults are pre-selected.'} />
        {isAdmin ? (
          <p className="p-5 text-sm text-muted">Permissions cannot be edited for administrators.</p>
        ) : (
          <div className="space-y-5 p-5">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Grantable</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {GRANTABLE.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />
                    <span className="font-mono text-xs">{p}</span>
                    {DEFAULTS.includes(p) && <span className="text-xs text-muted">(default)</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Reserved</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {ADMIN_ONLY.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm text-muted">
                    <input type="checkbox" disabled checked={false} className="size-4" />
                    <span className="font-mono text-xs">{p}</span>
                    <span className="inline-flex items-center gap-1 text-xs"><Lock className="size-3" aria-hidden /> Administrator only</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Button variant="primary" onClick={() => savePerms.mutate()} loading={savePerms.isPending}>Save permissions</Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Events" />
        {events.isLoading ? <Loading /> : !events.data?.items.length ? <EmptyState title="No events" description="This user has not created any events." /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Event date</Th><Th>Created</Th></tr></thead>
            <tbody>
              {events.data.items.map((e) => (
                <tr key={e.id}>
                  <Td><Link href={`/console/events/${e.id}`} className="font-medium hover:underline">{e.name}</Link></Td>
                  <Td><Badge tone={statusTone(e.status)}>{label(e.status)}</Badge></Td>
                  <Td className="text-muted">{date(e.eventDate)}</Td>
                  <Td className="text-muted">{date(e.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Activity" description="Most recent 100 actions by or affecting this user." />
        {activity.isLoading ? <Loading /> : !activity.data?.items.length ? <EmptyState title="No activity" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Action</Th><Th>Actor</Th></tr></thead>
            <tbody>
              {activity.data.items.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-muted">{date(a.createdAt, true)}</Td>
                  <Td>{label(a.action)}</Td>
                  <Td className="text-muted">{a.actorLabel ?? 'System'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={c?.[0] ?? ''}
        message={c?.[1] ?? ''}
        confirmLabel={c?.[2]}
        danger={confirm === 'suspended' || confirm === 'inactive'}
        loading={status.isPending || reset.isPending}
        onConfirm={() => (confirm === 'reset' ? reset.mutate() : confirm && status.mutate(confirm))}
      />
      <SecretDialog open={!!secret} onClose={() => setSecret(null)} title="Temporary password" secret={secret ?? ''} warning="Share this securely with the user. It will not be shown again." />
    </div>
  );
}
