import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { sessions, users, type User } from '../db/schema.js';
import { SESSION_COOKIE } from '../http/guards.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import {
  authorizationUrl,
  checkAccess,
  exchangeCode,
  pkcePair,
  randomValue,
  readState,
  roleFromExternal,
  safeNextPath,
  signState,
  ssoSettings,
  SSO_SESSION_TTL_MS,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_MS,
  verifyIdToken,
} from '../lib/sso.js';

const STATE_PATH = '/api/auth/sso';

type SsoOutcome = { error: string } | { token: string; next: string };

/**
 * AFS single sign-on, using OpenID Connect with PKCE through Keycloak.
 *
 * Access rules, in order:
 *  1. The ID token is verified (signature, issuer, audience, expiry, nonce).
 *  2. AFS Command Center must report an active assignment to ImageUnit with a role. Access is never granted by sign-in alone.
 *  3. The Keycloak identity is linked to an existing ImageUnit account. Linking needs a verified email that matches
 *     an account not yet linked. Accounts are not created here; an administrator creates them first.
 *  4. The account must be active.
 * On success ImageUnit's own session cookie is issued. The Keycloak tokens are discarded.
 */
export const ssoRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const settings = ssoSettings(ctx.config);

  app.get('/auth/sso/config', async () => ({ enabled: settings !== null }));

  app.get('/auth/sso/login', async (req, reply) => {
    if (!settings) throw new AppError(404, 'sso_disabled', 'Single sign-on is not enabled');
    const { verifier, challenge } = pkcePair();
    const state = randomValue();
    const nonce = randomValue();
    const query = req.query as { next?: unknown; silent?: unknown };
    const next = safeNextPath(query.next);
    reply.setCookie(
      SSO_STATE_COOKIE,
      signState({ state, nonce, verifier, next, issuedAt: Date.now() }, ctx.config.SESSION_SECRET),
      stateCookieOptions(ctx.config.COOKIE_SECURE),
    );
    return reply.redirect(authorizationUrl(settings, { state, nonce, challenge, silent: query.silent === '1' }));
  });

  app.get('/auth/sso/callback', async (req, reply) => {
    // Every failure ends at the login page with a short code. Details go to the server log only.
    const fail = (code: string) => {
      reply.clearCookie(SSO_STATE_COOKIE, { path: STATE_PATH });
      return reply.redirect(`${ctx.config.PUBLIC_WEB_URL}/login?sso_error=${code}`);
    };
    if (!settings) return fail('disabled');

    const query = req.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      // No AFS session for a silent sign-in: not an error, so the login page shows its own form instead.
      if (query.error === 'login_required' || query.error === 'interaction_required') return fail('silent');
      return fail('cancelled');
    }
    const saved = readState(req.cookies[SSO_STATE_COOKIE], ctx.config.SESSION_SECRET);
    if (!saved || !query.code || query.state !== saved.state) return fail('expired');

    let tokens;
    try {
      tokens = await exchangeCode(settings, query.code, saved.verifier);
    } catch (err) {
      req.log.warn({ err: String(err) }, 'sso token exchange failed');
      return fail('token');
    }

    let claims;
    try {
      claims = await verifyIdToken(settings, tokens.id_token, saved.nonce);
    } catch (err) {
      req.log.warn({ err: String(err) }, 'sso id token rejected');
      return fail('invalid_token');
    }

    let decision;
    try {
      decision = await checkAccess(settings, claims.sub);
    } catch (err) {
      req.log.error({ err: String(err) }, 'sso access check unavailable');
      return fail('unavailable');
    }
    if (!decision.allowed) return fail('not_assigned');
    const role = roleFromExternal(decision.external_role);
    if (!role) return fail('unknown_role');

    const outcome = await ctx.db.transaction(async (tx): Promise<SsoOutcome> => {
      const system = { type: 'system' as const, label: 'sso', ip: req.ip };
      let user: User | undefined = (await tx.select().from(users).where(eq(users.oidcSub, claims.sub)))[0];
      if (!user) {
        if (claims.email_verified !== true || typeof claims.email !== 'string') return { error: 'unverified_email' };
        const email = claims.email.toLowerCase();
        const candidate = (
          await tx
            .select()
            .from(users)
            .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.oidcSub)))
        )[0];
        if (!candidate) return { error: 'no_account' };
        const [linked] = await tx.update(users).set({ oidcSub: claims.sub }).where(eq(users.id, candidate.id)).returning();
        if (!linked) return { error: 'no_account' };
        user = linked;
        await audit(tx, system, { action: 'auth.sso_link', entityType: 'user', entityId: linked.id, targetUserId: linked.id });
      }

      const account = user;
      if (account.status !== 'active') {
        await audit(tx, system, {
          action: 'auth.sso_login',
          entityType: 'user',
          entityId: account.id,
          targetUserId: account.id,
          meta: { outcome: 'refused', reason: 'account not active' },
        });
        return { error: 'disabled' };
      }

      if (account.role !== role) {
        await audit(tx, system, {
          action: 'user.role_synced',
          entityType: 'user',
          entityId: account.id,
          targetUserId: account.id,
          before: { role: account.role },
          after: { role },
        });
      }
      await tx
        .update(users)
        .set({ role, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, account.id));

      const token = randomToken(32);
      await tx.insert(sessions).values({
        userId: account.id,
        tokenHash: sha256(token),
        sso: true,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 300),
        expiresAt: new Date(Date.now() + SSO_SESSION_TTL_MS),
      });
      await audit(tx, system, { action: 'auth.sso_login', entityType: 'user', entityId: account.id, targetUserId: account.id });
      return { token, next: saved.next };
    });

    if ('error' in outcome) return fail(outcome.error);

    reply.clearCookie(SSO_STATE_COOKIE, { path: STATE_PATH });
    reply.setCookie(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.COOKIE_SECURE,
      path: '/',
      maxAge: SSO_SESSION_TTL_MS / 1000,
    });
    return reply.redirect(`${ctx.config.PUBLIC_WEB_URL}${outcome.next}`);
  });
};

function stateCookieOptions(secure: boolean): Parameters<FastifyReply['setCookie']>[2] {
  return { httpOnly: true, sameSite: 'lax', secure, path: STATE_PATH, maxAge: SSO_STATE_TTL_MS / 1000 };
}
