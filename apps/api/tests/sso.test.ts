import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  pkcePair,
  readState,
  roleFromExternal,
  safeNextPath,
  signState,
  SSO_STATE_TTL_MS,
  type SsoSettings,
} from '../src/lib/sso.js';

const SECRET = 'test-session-secret-for-sso-state-cookies';

const settings: SsoSettings = {
  issuer: 'http://localhost:8081/realms/afs',
  internalIssuer: 'http://keycloak:8080/realms/afs',
  clientId: 'imageunit',
  clientSecret: 'unused-here',
  redirectUri: 'http://localhost:4000/api/auth/sso/callback',
  commandCenterUrl: 'http://backend:8000',
  serviceToken: 'unused-here',
  appSlug: 'imageunit',
};

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = pkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('gives a fresh verifier every time', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe('safeNextPath (open-redirect protection)', () => {
  it.each([['/console'], ['/console/events?tab=photos'], ['/']])('keeps same-site path %s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ['https://evil.example/console'],
    ['//evil.example/console'],
    ['/\\evil.example'],
    ['javascript:alert(1)'],
    ['/console\r\nSet-Cookie: x=1'],
    ['/console\u0000'],
    ['console'],
    [''],
    [undefined],
    [42],
  ])('replaces unsafe value %j with the console', (value) => {
    expect(safeNextPath(value)).toBe('/console');
  });
});

describe('signed state cookie', () => {
  const payload = { state: 's', nonce: 'n', verifier: 'v', next: '/console', issuedAt: 1_000_000 };

  it('round-trips a freshly signed payload', () => {
    const cookie = signState(payload, SECRET);
    expect(readState(cookie, SECRET, 1_000_000 + 1000)).toEqual(payload);
  });

  it('rejects a payload altered after signing', () => {
    const cookie = signState(payload, SECRET);
    const [, mac] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, next: 'https://evil.example' })).toString('base64url');
    expect(readState(`${forged}.${mac}`, SECRET, 1_000_001)).toBeNull();
  });

  it('rejects a cookie signed with another secret', () => {
    const cookie = signState(payload, 'another-secret-entirely-different-value');
    expect(readState(cookie, SECRET, 1_000_001)).toBeNull();
  });

  it('rejects an expired state cookie', () => {
    const cookie = signState(payload, SECRET);
    expect(readState(cookie, SECRET, 1_000_000 + SSO_STATE_TTL_MS + 1)).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(readState(undefined, SECRET)).toBeNull();
    expect(readState('no-dot', SECRET)).toBeNull();
    expect(readState('a.b.c', SECRET)).toBeNull();
  });
});

describe('authorization request', () => {
  it('uses the public issuer, PKCE S256 and the bound state and nonce', () => {
    const url = new URL(authorizationUrl(settings, { state: 'st', nonce: 'no', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('http://localhost:8081/realms/afs/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('imageunit');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
  });
});

describe('role mapping from Command Center', () => {
  it.each([['admin'], ['editor'], ['photographer']])('maps %s to the ImageUnit role', (role) => {
    expect(roleFromExternal(role)).toBe(role);
  });

  it.each([[null], [''], ['Admin'], ['superuser'], ['viewer']])('grants nothing for %j', (value) => {
    expect(roleFromExternal(value)).toBeNull();
  });
});
