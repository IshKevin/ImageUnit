'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNote, Input } from '@/components/ui';
import { post } from '@/lib/api';

export function UnlockForm({ slug, name, icon }: { slug: string; name: string; icon: ReactNode }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const unlock = useMutation({ mutationFn: () => post(`/public/events/${slug}/unlock`, { password }), onSuccess: () => router.refresh() });
  return (
    <form onSubmit={(e) => { e.preventDefault(); unlock.mutate(); }} className="w-full max-w-sm animate-pop-in space-y-5 rounded-2xl border border-border bg-surface p-8 text-center shadow-pop">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent/10 text-accent ring-8 ring-accent/5">{icon}</div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
        <p className="mt-1.5 text-sm text-muted">This gallery is password protected. Enter the password shared by the organiser.</p>
      </div>
      <Input type="password" required autoFocus placeholder="Gallery password" aria-label="Gallery password" className="h-11 text-center" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ErrorNote error={unlock.error} />
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={unlock.isPending}>View photos</Button>
    </form>
  );
}
