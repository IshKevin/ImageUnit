'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, Aperture, Bell, CalendarDays, FolderKanban, Globe, HardDrive, LayoutDashboard, LibraryBig, LogOut, Menu, Monitor, Moon, ScrollText, Settings, Sun, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { get, post, type User } from '@/lib/api';
import { relative } from '@/lib/format';
import { can, unauthenticated, useMe } from '@/lib/auth';
import { useTheme, type ThemePref } from '@/lib/theme';
import { Avatar, Badge, Loading } from './ui';

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
        className="relative grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Bell className="size-[18px]" />
        {!!data?.unread && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-surface">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] animate-pop-in overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              {!!data?.items.length && <span className="text-xs text-muted">{data.items.length} recent</span>}
            </div>
            <div className="max-h-96 overflow-y-auto">
            {data?.items.length ? (
              data.items.map((n) => (
                <div key={n.id} className="border-b border-border px-4 py-3 transition-colors last:border-0 hover:bg-surface-2/60">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.severity !== 'info' && <Badge tone={n.severity === 'critical' ? 'danger' : 'warning'}>{n.severity}</Badge>}
                  </div>
                  {n.body && <p className="mt-0.5 text-xs text-muted">{n.body}</p>}
                  <p className="mt-1 text-xs text-muted">{relative(n.createdAt)}</p>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <span className="grid size-10 place-items-center rounded-full bg-success/10 text-success"><Bell className="size-4" /></span>
                <p className="text-sm font-medium">You're all caught up</p>
                <p className="text-xs text-muted">New alerts will show up here.</p>
              </div>
            )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const THEMES: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

function ThemeSwitch() {
  const { pref, set } = useTheme();
  return (
    <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {THEMES.map((t) => (
        <button
          key={t.id}
          role="radio"
          aria-checked={pref === t.id}
          title={t.label}
          onClick={() => set(t.id)}
          className={clsx('flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-all', pref === t.id ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
        >
          <t.icon className="size-3.5" aria-hidden />
          <span className="sr-only">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <Link href="/console" className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-fuchsia-500 text-white shadow-sm shadow-accent/30">
        <Aperture className="size-[18px]" aria-hidden />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">ImageUnit</span>
    </Link>
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
      // signed_out stops the login page from signing the person straight back in through AFS.
      router.replace('/login?signed_out=1');
    },
  });

  if (isLoading || !user) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading />
      </div>
    );
  }

  const nav = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Main">
      {NAV.map((group, i) => {
        const items = group.items.filter((n) => n.show(user));
        if (!items.length) return null;
        return (
          <div key={i} className="space-y-0.5">
            {group.section && <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{group.section}</p>}
            {items.map((n) => {
              const active = n.href === '/console' ? pathname === n.href : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={clsx(
                    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {active && <span className="absolute inset-y-1.5 -left-3 w-1 rounded-r-full bg-accent" aria-hidden />}
                  <n.icon className={clsx('size-[18px] transition-colors', active ? 'text-accent' : 'text-muted group-hover:text-fg')} aria-hidden />
                  {n.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  const account = (
    <div className="space-y-3 border-t border-border p-3">
      <ThemeSwitch />
      <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
        <Avatar name={user.name} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{user.name}</p>
          <p className="truncate text-xs capitalize leading-tight text-muted">{user.role}</p>
        </div>
        <button onClick={() => logout.mutate()} aria-label="Sign out" title="Sign out" className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger">
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Brand />
        </div>
        {nav}
        {account}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-sm" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-pop-in flex-col bg-surface shadow-pop">
            <div className="flex h-16 items-center justify-between px-5">
              <Brand />
              <button onClick={() => setMenu(false)} aria-label="Close menu" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"><X className="size-5" /></button>
            </div>
            {nav}
            {account}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-xl lg:px-8">
          <button className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden" onClick={() => setMenu(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="lg:hidden"><Brand /></div>
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <div className="ml-1 lg:hidden"><Avatar name={user.name} /></div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 animate-fade-in px-4 py-6 sm:py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
