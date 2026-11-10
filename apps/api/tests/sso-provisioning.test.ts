import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogs, users } from '../src/db/schema.js';
import { createTestApp, makeUser, uniq, type TestApp } from './helpers.js';

// Keycloak and Command Center are stubbed; the callback route, database and session handling are real.
vi.mock('../src/lib/sso.js', async (original) => ({
  ...(await original<typeof import('../src/lib/sso.js')>()),
  exchangeCode: vi.fn(async () => ({ id_token: 'id', access_token: 'access' })),
  verifyIdToken: vi.fn(),
  checkAccess: vi.fn(),
}));
const sso = await import('../src/lib/sso.js');
const verifyIdToken = vi.mocked(sso.verifyIdToken);
const checkAccess = vi.mocked(sso.checkAccess);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    AFS_SSO_ENABLED: 'true',
    AFS_OIDC_ISSUER: 'http://localhost:8081/realms/afs',
    AFS_OIDC_CLIENT_ID: 'imageunit',
    AFS_OIDC_CLIENT_SECRET: 'secret',
    AFS_COMMAND_CENTER_URL: 'http://backend:8000',
    AFS_SERVICE_TOKEN: 'x'.repeat(32),
  });
});
afterAll(async () => t.close());
beforeEach(() => {
  checkAccess.mockResolvedValue({ allowed: true, external_role: 'editor', reason: 'assigned' });
});

/** Run the browser's round trip: start sign-in (state cookie), then return to the callback with a code. */
async function signIn(identity: { sub: string; email: string; email_verified?: boolean; name?: string }) {
  verifyIdToken.mockImplementation(async (_s, _token, nonce) => ({ email_verified: true, nonce, ...identity }));
  const start = await t.app.inject({ method: 'GET', url: '/api/auth/sso/login?next=/console' });
  const state = new URL(start.headers.location as string).searchParams.get('state');
  const stateCookie = start.cookies.find((c) => c.name === 'iu_sso')!;
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/auth/sso/callback?code=abc&state=${state}`,
    headers: { cookie: `iu_sso=${stateCookie.value}` },
  });
  return { location: res.headers.location as string, session: res.cookies.find((c) => c.name === 'iu_session') };
}

const byEmail = (email: string) => t.ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);

describe('SSO account provisioning', () => {
  it('creates an account for an assigned AFS identity with no ImageUnit account', async () => {
    const email = `${uniq('new')}@afs.test`;
    const sub = uniq('sub');
    const { location, session } = await signIn({ sub, email, name: 'Kevin Ishimwe' });
    expect(location).toBe('http://localhost:4001/console');
    expect(session?.value).toBeTruthy();
    const [user] = await byEmail(email);
    expect(user).toMatchObject({ oidcSub: sub, role: 'editor', status: 'active', name: 'Kevin Ishimwe', passwordHash: null });
    const logged = await t.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, 'user.sso_provisioned'), eq(auditLogs.entityId, user!.id)));
    expect(logged).toHaveLength(1);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `iu_session=${session!.value}` } });
    expect(me.json().user.email).toBe(email);
  });

  it('reuses the account on later sign-ins and keeps the role in sync', async () => {
    const email = `${uniq('again')}@afs.test`;
    const sub = uniq('sub');
    await signIn({ sub, email });
    checkAccess.mockResolvedValue({ allowed: true, external_role: 'admin', reason: 'assigned' });
    const { location } = await signIn({ sub, email });
    expect(location).toBe('http://localhost:4001/console');
    const rows = await byEmail(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('links an existing unlinked account with the same email instead of creating one', async () => {
    const existing = await makeUser(t, 'photographer');
    const sub = uniq('sub');
    await signIn({ sub, email: existing.email.toUpperCase() });
    const rows = await byEmail(existing.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing.id, oidcSub: sub, role: 'editor' });
    expect(rows[0]!.passwordHash).toBe(existing.passwordHash);
  });

  it('refuses when the email belongs to an account linked to a different AFS identity', async () => {
    const other = await makeUser(t, 'photographer', { oidcSub: uniq('other-sub') });
    const { location, session } = await signIn({ sub: uniq('sub'), email: other.email });
    expect(location).toContain('sso_error=no_account');
    expect(session).toBeUndefined();
    expect(await byEmail(other.email)).toHaveLength(1);
  });

  it('creates nothing for an identity Command Center has not assigned', async () => {
    checkAccess.mockResolvedValue({ allowed: false, external_role: null, reason: 'no assignment' });
    const email = `${uniq('unassigned')}@afs.test`;
    const { location } = await signIn({ sub: uniq('sub'), email });
    expect(location).toContain('sso_error=not_assigned');
    expect(await byEmail(email)).toHaveLength(0);
  });

  it('creates nothing for an unverified email', async () => {
    const email = `${uniq('unverified')}@afs.test`;
    const { location } = await signIn({ sub: uniq('sub'), email, email_verified: false });
    expect(location).toContain('sso_error=unverified_email');
    expect(await byEmail(email)).toHaveLength(0);
  });
});
