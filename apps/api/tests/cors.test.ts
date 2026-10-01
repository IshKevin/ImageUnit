import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, session, uniq, type TestApp } from './helpers.js';

const preflight = (t: TestApp, url: string, origin: string, headers = 'authorization') =>
  t.app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': headers } });

describe('CORS: default (only our web app)', () => {
  let t: TestApp;
  it('allows the web app with credentials and refuses other sites', async () => {
    t = await createTestApp();
    const ok = await preflight(t, '/api/events', 'http://localhost:4001');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4001');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const other = await preflight(t, '/api/v1/events', 'https://other-site.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
  afterAll(async () => t?.close());
});

describe('CORS_ORIGINS=* (any website)', () => {
  let t: TestApp;
  afterAll(async () => t?.close());

  it('lets any site call the API from a browser, but never with credentials', async () => {
    t = await createTestApp({ CORS_ORIGINS: '*' });
    for (const url of ['/api/v1/events', '/api/public/events/some-event', '/api/events']) {
      const res = await preflight(t, url, 'https://any-site.example', 'authorization,content-type');
      expect(res.statusCode, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe('*');
      expect(res.headers['access-control-allow-credentials'], url).toBeUndefined(); // cookies are never shared cross-site
    }
  });

  it('a real cross-site request with a bearer key works; a cookie session from another site is still refused', async () => {
    const admin = await session(t, 'admin');
    const site = (await admin.post('/api/admin/websites', { name: `Cors ${uniq()}` })).json();
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/events', headers: { origin: 'https://any-site.example', authorization: `Bearer ${site.apiKey}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeTruthy();
    // A foreign page replaying a signed-in user's cookie to change data is rejected by the same-origin check.
    const attack = await t.app.inject({ method: 'POST', url: '/api/events', payload: { name: 'evil event' }, headers: { cookie: admin.cookie, origin: 'https://any-site.example' } });
    expect(attack.statusCode).toBe(403);
  });
});

describe('CORS_ORIGINS=<list>', () => {
  let t: TestApp;
  afterAll(async () => t?.close());
  it('trusts exactly the listed sites in addition to the web app', async () => {
    t = await createTestApp({ CORS_ORIGINS: 'https://partner.example, https://shop.example/' });
    expect((await preflight(t, '/api/v1/events', 'https://partner.example')).headers['access-control-allow-origin']).toBe('https://partner.example');
    expect((await preflight(t, '/api/v1/events', 'https://shop.example')).headers['access-control-allow-origin']).toBe('https://shop.example');
    expect((await preflight(t, '/api/v1/events', 'https://stranger.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('same-origin protection for cookie sessions', () => {
  const deployed = { PUBLIC_WEB_URL: 'https://photos.example.com' }; // deliberately NOT the address people really use
  const post = (t: TestApp, cookie: string, headers: Record<string, string>) =>
    t.app.inject({ method: 'POST', url: '/api/events', payload: { name: `Origin test ${uniq()}` }, headers: { cookie, ...headers } });

  describe('host mode (default): follows the address actually used, whatever PUBLIC_WEB_URL says', () => {
    let t: TestApp;
    afterAll(async () => t?.close());
    it('accepts the real site behind a proxy and refuses other sites', async () => {
      t = await createTestApp({ ...deployed, CORS_ORIGINS: 'https://partner.example' });
      const s = await session(t, 'photographer');
      // Browser at gallery.afs-rwanda.org -> proxy -> API: the API sees the original host in x-forwarded-host.
      const behindProxy = { host: 'api:4000', 'x-forwarded-host': 'gallery.afs-rwanda.org', origin: 'https://gallery.afs-rwanda.org' };
      expect((await post(t, s.cookie, behindProxy)).statusCode).toBe(201);
      expect((await post(t, s.cookie, { ...behindProxy, 'x-forwarded-host': 'gallery.afs-rwanda.org, api:4000' })).statusCode).toBe(201); // proxy chain appends
      expect((await post(t, s.cookie, { host: 'gallery.afs-rwanda.org', origin: 'http://gallery.afs-rwanda.org' })).statusCode).toBe(201); // no proxy: Host header
      expect((await post(t, s.cookie, { origin: 'https://partner.example' })).statusCode).toBe(201); // explicitly trusted
      expect((await post(t, s.cookie, { origin: 'https://photos.example.com' })).statusCode).toBe(201); // the configured address still works

      // A different website replaying the cookie is refused, with a message that says why.
      const evil = await post(t, s.cookie, { ...behindProxy, origin: 'https://evil.example' });
      expect(evil.statusCode).toBe(403);
      expect(evil.json().error.message).toContain('https://evil.example');
      expect((await post(t, s.cookie, { ...behindProxy, origin: 'https://gallery.afs-rwanda.org.evil.example' })).statusCode).toBe(403);
      expect((await post(t, s.cookie, { ...behindProxy, origin: 'not a url' })).statusCode).toBe(403);
      // Non-browser clients send no Origin and are not affected.
      expect((await post(t, s.cookie, {})).statusCode).toBe(201);
    });
  });

  describe('strict mode: only the configured address', () => {
    let t: TestApp;
    afterAll(async () => t?.close());
    it('refuses a correct-but-unconfigured host and explains the mismatch', async () => {
      t = await createTestApp({ ...deployed, ORIGIN_CHECK: 'strict' });
      const s = await session(t, 'photographer');
      const res = await post(t, s.cookie, { 'x-forwarded-host': 'gallery.afs-rwanda.org', origin: 'https://gallery.afs-rwanda.org' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('PUBLIC_WEB_URL');
      expect((await post(t, s.cookie, { origin: 'https://photos.example.com' })).statusCode).toBe(201);
    });
  });

  describe('off: no check', () => {
    let t: TestApp;
    afterAll(async () => t?.close());
    it('accepts any origin', async () => {
      t = await createTestApp({ ...deployed, ORIGIN_CHECK: 'off' });
      const s = await session(t, 'photographer');
      expect((await post(t, s.cookie, { origin: 'https://anything.example' })).statusCode).toBe(201);
    });
  });
});
