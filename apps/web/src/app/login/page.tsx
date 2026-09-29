'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Aperture } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorNote, Button, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => post('/auth/login', { email, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/console');
    },
  });

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface p-8"
      >
        <div className="flex items-center gap-2">
          <Aperture className="size-6 text-accent" aria-hidden />
          <span className="text-lg font-semibold">ImageUnit</span>
        </div>
        <div>
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Photographers and administrators</p>
        </div>
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote error={login.error} />
        <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
