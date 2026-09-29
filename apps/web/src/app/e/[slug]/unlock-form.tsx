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
    <form onSubmit={(e) => { e.preventDefault(); unlock.mutate(); }} className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-surface p-8 text-center">
      <div className="mx-auto grid size-11 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>
      <div>
        <h1 className="text-lg font-semibold">{name}</h1>
        <p className="mt-1 text-sm text-muted">This gallery is password protected.</p>
      </div>
      <Input type="password" required autoFocus placeholder="Password" aria-label="Gallery password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ErrorNote error={unlock.error} />
      <Button type="submit" variant="primary" className="w-full" loading={unlock.isPending}>View photos</Button>
    </form>
  );
}
