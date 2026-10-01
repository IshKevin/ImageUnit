'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Select, statusTone, Table, Td, Th } from '@/components/ui';
import { get, post, qs, type Paged, type User } from '@/lib/api';
import { date, label, relative } from '@/lib/format';
import { AdminGate, SecretDialog } from '../_shared';

export default function UsersPage() {
  return (
    <AdminGate perm="users:manage">
      <Users />
    </AdminGate>
  );
}

function Users() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery({
    queryKey: ['admin-users', debounced, role, status, page],
    queryFn: () => get<Paged<User>>(`/admin/users${qs({ q: debounced, role, status, page, pageSize: 20 })}`),
    placeholderData: (p) => p,
  });

  return (
    <div>
      <PageHeader
        title="Users"
        description="Manage administrators, editors and photographers."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden /> New user
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-border p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden />
            <Input aria-label="Search users" placeholder="Search name or email" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Filter by role" className="w-40" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            <option value="admin">Administrator</option>
            <option value="editor">Editor</option>
            <option value="photographer">Photographer</option>
          </Select>
          <Select aria-label="Filter by status" className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <div className="p-4"><ErrorNote error={list.error} /></div>
        ) : !list.data?.items.length ? (
          <EmptyState title="No users found" description="Try changing the search or filters." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>User</Th><Th>Role</Th><Th>Status</Th><Th>Last login</Th><Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((u) => (
                  <tr key={u.id} tabIndex={0} onClick={() => router.push(`/console/admin/users/${u.id}`)} onKeyDown={(e) => e.key === 'Enter' && router.push(`/console/admin/users/${u.id}`)} className="cursor-pointer hover:bg-surface-2">
                    <Td>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-muted">{u.email}</p>
                    </Td>
                    <Td><Badge tone={u.role === 'admin' ? 'accent' : u.role === 'editor' ? 'success' : 'neutral'}>{label(u.role)}</Badge></Td>
                    <Td><Badge tone={statusTone(u.status)}>{label(u.status)}</Badge></Td>
                    <Td className="text-muted">{u.lastLoginAt ? relative(u.lastLoginAt) : 'Never'}</Td>
                    <Td className="text-muted">{date(u.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onChange={setPage} />
          </>
        )}
      </Card>

      <NewUser open={creating} onClose={() => setCreating(false)} onCreated={(email, password) => { setCreating(false); if (password) setTemp({ email, password }); }} />
      <SecretDialog open={!!temp} onClose={() => setTemp(null)} title="Temporary password" secret={temp?.password ?? ''} warning={`Share this with ${temp?.email ?? 'the user'} securely. It will not be shown again.`} />
    </div>
  );
}

const ROLE_HELP: Record<string, string> = {
  photographer: 'Photographer — creates, uploads to and publishes their own events.',
  editor: 'Editor — curates events and media across all photographers: renames, tags, galleries and collections. Cannot upload, publish or delete.',
  admin: 'Administrator — full access, including users, websites, settings and deletion.',
};

function NewUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (email: string, temporaryPassword?: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', role: 'photographer', password: '' });
  const m = useMutation({
    mutationFn: () => post<{ user: User; temporaryPassword?: string }>('/admin/users', { email: form.email.trim(), name: form.name.trim(), role: form.role, ...(form.password && { password: form.password }) }),
    onSuccess: (r) => {
      toast.success('User created');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setForm({ email: '', name: '', role: 'photographer', password: '' });
      onCreated(r.user.email, r.temporaryPassword);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create user'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title="New user">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name"><Input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="photographer">Photographer</option>
            <option value="editor">Editor</option>
            <option value="admin">Administrator</option>
          </Select>
        </Field>
        <p className="-mt-2 text-xs text-muted" aria-live="polite">{ROLE_HELP[form.role]}</p>
        <Field label="Password (optional)" hint="Leave blank to generate a temporary password.">
          <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending}>Create user</Button>
        </div>
      </form>
    </Modal>
  );
}
