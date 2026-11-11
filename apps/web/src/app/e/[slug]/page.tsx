import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { Lock, TimerOff } from 'lucide-react';
import { GalleryClient, type PublicEvent } from './gallery-client';
import { UnlockForm } from './unlock-form';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

type Result =
  | { kind: 'ok'; event: PublicEvent }
  | { kind: 'password'; name: string }
  | { kind: 'gone' }
  | { kind: 'missing' };

async function load(slug: string): Promise<Result> {
  const jar = await cookies();
  const res = await fetch(`${API_URL}/api/public/events/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
    headers: { cookie: jar.toString() },
  }).catch(() => null);
  if (!res) return { kind: 'missing' };
  if (res.status === 200) return { kind: 'ok', event: (await res.json()).event };
  const body = await res.json().catch(() => null);
  if (res.status === 401 && body?.error?.code === 'password_required') return { kind: 'password', name: body.error.details?.name ?? 'Private gallery' };
  if (res.status === 410) return { kind: 'gone' };
  return { kind: 'missing' };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const r = await load((await params).slug);
  if (r.kind === 'ok') {
    return {
      title: r.event.name,
      description: r.event.description || `Photographs from ${r.event.name}`,
      openGraph: { title: r.event.name, description: r.event.description || undefined, images: r.event.coverUrl ? [r.event.coverUrl] : undefined },
      robots: { index: false }, // galleries are shared by link, not discovered by search
    };
  }
  return { title: 'Gallery', robots: { index: false } };
}

function Notice({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6 text-center">
      <div aria-hidden className="absolute left-1/2 top-1/3 -z-10 size-96 -translate-x-1/2 rounded-full bg-warning/10 blur-3xl" />
      <div className="max-w-sm animate-pop-in space-y-3">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-warning/10 text-warning ring-8 ring-warning/5">{icon}</div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm leading-relaxed text-muted">{text}</p>
      </div>
    </main>
  );
}

export default async function PublicGallery({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'missing') notFound();
  if (r.kind === 'gone') return <Notice icon={<TimerOff className="size-6" />} title="This gallery has expired" text="Public access to these photographs has ended. Contact the event organiser if you need access." />;
  if (r.kind === 'password') return <main className="relative grid min-h-screen place-items-center overflow-hidden px-4"><div aria-hidden className="absolute -left-24 -top-24 -z-10 size-96 rounded-full bg-accent/15 blur-3xl" /><div aria-hidden className="absolute -bottom-24 -right-24 -z-10 size-96 rounded-full bg-fuchsia-500/10 blur-3xl" /><UnlockForm slug={slug} name={r.name} icon={<Lock className="size-5" />} /></main>;
  return <GalleryClient slug={slug} event={r.event} />;
}
