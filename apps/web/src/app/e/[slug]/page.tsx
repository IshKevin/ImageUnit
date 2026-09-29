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
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted">{text}</p>
      </div>
    </main>
  );
}

export default async function PublicGallery({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'missing') notFound();
  if (r.kind === 'gone') return <Notice icon={<TimerOff className="size-6" />} title="This gallery has expired" text="Public access to these photographs has ended. Contact the event organiser if you need access." />;
  if (r.kind === 'password') return <main className="grid min-h-screen place-items-center px-4"><UnlockForm slug={slug} name={r.name} icon={<Lock className="size-5" />} /></main>;
  return <GalleryClient slug={slug} event={r.event} />;
}
