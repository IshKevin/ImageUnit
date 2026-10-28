'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Aperture } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorNote, Button, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';

const SSO_MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in with AFS was cancelled.',
  expired: 'Your AFS sign-in expired. Please try again.',
  not_assigned: 'Your AFS account is not assigned to ImageUnit. Contact an administrator.',
  unknown_role: 'Your ImageUnit role is not set up yet. Contact an administrator.',
  no_account: 'No ImageUnit account is linked to this AFS account. Contact an administrator.',
  unverified_email: 'Your AFS email address must be verified before it can be linked.',
  disabled: 'This ImageUnit account is not active. Contact an administrator.',
  unavailable: 'AFS sign-in is temporarily unavailable. Try again shortly.',
};

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoMessage, setSsoMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('sso_error');
    // Returning from a failed or silent sign-in, just signed out, or the password form was asked for: show the form.
    const showForm = Boolean(code) || params.has('signed_out') || params.has('password');
    if (code && code !== 'silent') setSsoMessage(SSO_MESSAGES[code] ?? 'AFS sign-in failed. Please try again.');
    fetch('/api/auth/sso/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const enabled = Boolean(data?.enabled);
        setSsoEnabled(enabled);
        // Someone who already signed in to AFS in this browser goes straight in, without a login form.
        if (enabled && !showForm) window.location.replace('/api/auth/sso/login?next=/console&silent=1');
      })
      .catch(() => setSsoEnabled(false));
  }, []);
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
        {ssoMessage && <p role="alert" className="text-sm text-danger">{ssoMessage}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
        {ssoEnabled && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <a
              href="/api/auth/sso/login?next=/console"
              className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-border bg-surface text-sm font-medium hover:bg-surface-2"
            >
              Sign in with AFS SSO
            </a>
          </>
        )}
      </form>
    </main>
  );
}
