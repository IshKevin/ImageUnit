'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, Aperture, Bell, CalendarDays, FolderKanban, Globe, HardDrive, LayoutDashboard, LibraryBig, LogOut, Menu, ScrollText, Settings, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { get, post, type User } from '@/lib/api';
import { relative } from '@/lib/format';
import { can, unauthenticated, useMe } from '@/lib/auth';
import { Badge, Loading } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Users;
  show: (u: User) => boolean;
}

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: '/console', label: 'Overview', icon: LayoutDashboard, show: () => true },
      { href: '/console/events', label: 'Events', icon: CalendarDays, show: (u) => can(u, 'events:view') },
      { href: '/console/library', label: 'Library', icon: LibraryBig, show: (u) => can(u, 'events:view') },
      { href: '/console/collections', label: 'Collections', icon: FolderKanban, show: (u) => can(u, 'collections:manage') },
    ],
  },
  {
    section: 'Administration',
    items: [
      { href: '/console/admin/users', label: 'Users', icon: Users, show: (u) => can(u, 'users:manage') },
      { href: '/console/admin/websites', label: 'Websites', icon: Globe, show: (u) => can(u, 'websites:manage') },
      { href: '/console/admin/storage', label: 'Storage', icon: HardDrive, show: (u) => u.role === 'admin' },
      { href: '/console/admin/audit', label: 'Audit log', icon: ScrollText, show: (u) => can(u, 'audit:view') },
      { href: '/console/admin/health', label: 'System health', icon: Activity, show: (u) => u.role === 'admin' },
      { href: '/console/admin/settings', label: 'Settings', icon: Settings, show: (u) => can(u, 'settings:manage') },
    ],
  },
];

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<{ items: { id: string; title: string; body: string; severity: string; readAt: string | null; createdAt: string }[]; unread: number }>('/notifications'),
    refetchInterval: 30_000,
  });
  const read = useMutation({ mutationFn: () => post('/notifications/read'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open && data?.unread) read.mutate();
        }}
        aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}
        className="relative rounded-lg p-2 hover:bg-surface-2"
      >
        <Bell className="size-5" />
        {!!data?.unread && <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-danger text-[10px] font-semibold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 max-h-96 w-80 overflow-auto rounded-xl border border-border bg-surface shadow-xl">
            {data?.items.length ? (
              data.items.map((n) => (
                <div key={n.id} className="border-b border-border px-4 py-3 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.severity !== 'info' && <Badge tone={n.severity === 'critical' ? 'danger' : 'warning'}>{n.severity}</Badge>}
                  </div>
                  {n.body && <p className="mt-0.5 text-xs text-muted">{n.body}</p>}
                  <p className="mt-1 text-xs text-muted">{relative(n.createdAt)}</p>
                </div>
              ))
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted">You're all caught up</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { data: user, error, isLoading } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);

  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (error && unauthenticated(error)) router.replace('/login');
  }, [error, router]);

  const logout = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: () => {
      qc.clear();
      router.replace('/login');
    },
  });

  if (isLoading || !user) return <Loading />;

  const nav = (
    <nav className="flex-1 space-y-6 overflow-y-auto p-3">
      {NAV.map((group, i) => {
        const items = group.items.filter((n) => n.show(user));
        if (!items.length) return null;
        return (
          <div key={i}>
            {group.section && <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-muted">{group.section}</p>}
            {items.map((n) => {
              const active = n.href === '/console' ? pathname === n.href : pathname.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={clsx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', active ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                  <n.icon className="size-4" aria-hidden />
                  {n.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5">
          <Aperture className="size-5 text-accent" aria-hidden />
          <span className="font-semibold">ImageUnit</span>
        </div>
        {nav}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface">
            <div className="flex h-14 items-center justify-between border-b border-border px-5">
              <span className="font-semibold">ImageUnit</span>
              <button onClick={() => setMenu(false)} aria-label="Close menu"><X className="size-5" /></button>
            </div>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-8">
          <button className="rounded-lg p-2 hover:bg-surface-2 lg:hidden" onClick={() => setMenu(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="ml-auto flex items-center gap-2">
            <Notifications />
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{user.name}</p>
              <p className="text-xs capitalize leading-tight text-muted">{user.role}</p>
            </div>
            <button onClick={() => logout.mutate()} aria-label="Sign out" className="rounded-lg p-2 hover:bg-surface-2">
              <LogOut className="size-5" />
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
