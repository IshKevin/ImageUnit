'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Aperture, ArrowRight, Images, KeyRound, ShieldCheck, Share2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorNote, Button, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';

const SSO_MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in with AFS was cancelled.',
  expired: 'Your AFS sign-in expired. Please try again.',
  not_assigned: 'Your AFS account is not assigned to ImageUnit. Contact an administrator.',
  unknown_role: 'Your ImageUnit role is not set up yet. Contact an administrator.',
  no_account: 'This AFS account cannot be linked: its email is already used by another ImageUnit account. Contact an administrator.',
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

  const sso = ssoEnabled && (
    <>
      <a
        href="/api/auth/sso/login?next=/console"
        className="group inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface text-sm font-medium shadow-card transition-all hover:border-border-strong hover:bg-surface-2 active:scale-[0.99]"
      >
        <KeyRound className="size-4 text-accent" aria-hidden />
        Continue with AFS SSO
        <ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
      </a>
      <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        or sign in with email
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel (large screens). */}
      <section aria-hidden className="relative hidden overflow-hidden bg-[#0f0d24] p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -left-32 -top-32 size-[28rem] rounded-full bg-accent/50 blur-[120px]" />
        <div className="absolute -bottom-40 right-0 size-[30rem] rounded-full bg-fuchsia-500/30 blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.04)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
        <div className="relative flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur"><Aperture className="size-5" /></span>
          <span className="text-lg font-semibold tracking-tight">ImageUnit</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight text-balance">Every event, beautifully delivered.</h2>
          <p className="mt-4 text-base leading-relaxed text-white/70">Upload, organise and share event photography with galleries your audience will love.</p>
          <ul className="mt-10 space-y-4 text-sm text-white/80">
            {[
              { icon: Images, text: 'Fast uploads with automatic previews' },
              { icon: Share2, text: 'Public, unlisted or password-protected galleries' },
              { icon: ShieldCheck, text: 'Role-based access for your whole team' },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-lg bg-white/10 ring-1 ring-white/15"><Icon className="size-4" /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-white/40">© {new Date().getFullYear()} ImageUnit</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
          className="w-full max-w-sm animate-pop-in space-y-5"
        >
          <div className="flex items-center gap-2.5 lg:hidden">
            <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-accent to-fuchsia-500 text-white shadow-sm shadow-accent/30"><Aperture className="size-5" aria-hidden /></span>
            <span className="text-lg font-semibold tracking-tight">ImageUnit</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Welcome back</h1>
            <p className="mt-1.5 text-sm text-muted">Sign in to manage your events and galleries.</p>
          </div>
          {ssoMessage && <p role="alert" className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5 text-sm text-danger">{ssoMessage}</p>}
          {sso}
          <Field label="Email">
            <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.org" className="h-11" autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-11" />
          </Field>
          <ErrorNote error={login.error} />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending}>
            Sign in
          </Button>
          <p className="text-center text-xs text-muted">For photographers and administrators. Need access? Contact your administrator.</p>
        </form>
      </section>
    </main>
  );
}
