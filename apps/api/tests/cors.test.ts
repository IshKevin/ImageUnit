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
