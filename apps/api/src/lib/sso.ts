/**
 * AFS single sign-on helpers: OpenID Connect authorization code flow with PKCE, verified against Keycloak.
 *
 * The flow's transient values (state, nonce, PKCE verifier) live in a short-lived signed cookie, so no server-side
 * state is needed. The tokens never reach the browser; only ImageUnit's own session cookie is set.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { User } from '../db/schema.js';
import type { Config } from '../config.js';

type UserRole = User['role'];

/** SSO settings, or null when single sign-on is disabled. Config validation guarantees the required values. */
export function ssoSettings(config: Config): SsoSettings | null {
  if (!config.AFS_SSO_ENABLED) return null;
  return {
    issuer: config.AFS_OIDC_ISSUER!,
    internalIssuer: config.AFS_OIDC_INTERNAL_ISSUER ?? config.AFS_OIDC_ISSUER!,
    clientId: config.AFS_OIDC_CLIENT_ID!,
    clientSecret: config.AFS_OIDC_CLIENT_SECRET!,
    redirectUri: config.AFS_OIDC_REDIRECT_URI ?? `${config.API_PUBLIC_URL}/api/auth/sso/callback`,
    commandCenterUrl: config.AFS_COMMAND_CENTER_URL!,
    serviceToken: config.AFS_SERVICE_TOKEN!,
    appSlug: config.AFS_APP_SLUG,
  };
}

export const SSO_STATE_COOKIE = 'iu_sso';
export const SSO_STATE_TTL_MS = 10 * 60 * 1000;
/** Lifetime of an SSO session. It is not renewed, so access revoked in AFS ends within this period. */
export const SSO_SESSION_TTL_MS = 8 * 3600 * 1000;

export interface SsoSettings {
  issuer: string;
  internalIssuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  commandCenterUrl: string;
  serviceToken: string;
  appSlug: string;
}

export interface SsoState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  issuedAt: number;
}

const base64url = (buf: Buffer) => buf.toString('base64url');

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export const randomValue = () => base64url(randomBytes(24));

/**
 * Only same-site paths are accepted after sign-in, so the login flow cannot be used to redirect users to another
 * site (open redirect). Anything else falls back to the console.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/console';
  if (/[\r\n\t\0]/.test(value)) return '/console';
  return value;
}

/** Sign a payload with HMAC-SHA256 so the cookie cannot be altered by the browser. */
export function signState(payload: SsoState, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = base64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function readState(value: string | undefined, secret: string, now = Date.now()): SsoState | null {
  if (!value) return null;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: SsoState;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SsoState;
  } catch {
    return null;
  }
  if (typeof parsed.issuedAt !== 'number' || now - parsed.issuedAt > SSO_STATE_TTL_MS) return null;
  return parsed;
}

/** Build the Keycloak authorization URL that starts the flow. */
export function authorizationUrl(settings: SsoSettings, params: { state: string; nonce: string; challenge: string; silent?: boolean }) {
  const url = new URL(`${settings.issuer}/protocol/openid-connect/auth`);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    // Silent sign-in: completes only if the employee already signed in to AFS in this browser. Otherwise Keycloak
    // returns login_required without showing a form.
    ...(params.silent ? { prompt: 'none' } : {}),
  }).toString();
  return url.toString();
}

/** Exchange the authorization code for tokens. Runs server to server, so the client secret never leaves the API. */
export async function exchangeCode(settings: SsoSettings, code: string, verifier: string): Promise<{ id_token: string; access_token: string }> {
  const res = await fetch(`${settings.internalIssuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  return (await res.json()) as { id_token: string; access_token: string };
}

/**
 * Verify an ID token: RS256 signature from the realm keys, issuer, audience, expiry and the nonce bound to this login.
 * The issuer is the public one that Keycloak writes into tokens; the keys are fetched over the internal network.
 */
export async function verifyIdToken(settings: SsoSettings, idToken: string, nonce: string): Promise<JWTPayload & { sub: string }> {
  const jwks = createRemoteJWKSet(new URL(`${settings.internalIssuer}/protocol/openid-connect/certs`));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: settings.issuer,
    audience: settings.clientId,
    algorithms: ['RS256'],
  });
  if (typeof payload.sub !== 'string' || payload.nonce !== nonce) throw new Error('invalid id token');
  return payload as JWTPayload & { sub: string };
}

export interface AccessDecision {
  allowed: boolean;
  external_role: string | null;
  reason: string;
}

/** Ask AFS Command Center whether this identity may use ImageUnit, and with which role. */
export async function checkAccess(settings: SsoSettings, subject: string): Promise<AccessDecision> {
  const url = new URL('/api/internal/access', settings.commandCenterUrl);
  url.search = new URLSearchParams({ application: settings.appSlug, subject }).toString();
  const res = await fetch(url, { headers: { 'X-Service-Token': settings.serviceToken }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`access check failed: HTTP ${res.status}`);
  return (await res.json()) as AccessDecision;
}

/** Map the role recorded in AFS Command Center onto ImageUnit's own role. Unknown values grant nothing. */
export function roleFromExternal(value: string | null): UserRole | null {
  return value === 'admin' || value === 'editor' || value === 'photographer' ? value : null;
}
