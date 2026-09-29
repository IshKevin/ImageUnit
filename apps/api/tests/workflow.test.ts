import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, notifications, photos } from '../src/db/schema.js';
import { expireEvents, flagRetentionReviews, recoverStuckPhotos } from '../src/jobs/maintenance.js';
import { PermanentProcessingError, processPhoto } from '../src/jobs/process-photo.js';
import { createTestApp, makeEvent, readyPhoto, session, testImage, uploadPhoto, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const publish = async (owner: Awaited<ReturnType<typeof session>>, id: string) => (await owner.post(`/api/events/${id}/publish`)).json().event;

describe('upload and processing', () => {
  it('runs upload → process → ready and produces original, preview and thumbnail', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const up = await uploadPhoto(t, owner, ev.id);
    expect(up.done.json().results[0]).toMatchObject({ ok: true, status: 'uploaded' });
    expect(t.added.at(-1)?.data).toEqual({ photoId: up.photoId });

    expect(await processPhoto(t.ctx, up.photoId)).toBe('ready');
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, up.photoId));
    expect(p).toMatchObject({ status: 'ready', width: 800, height: 600, format: 'jpg' });
    expect(t.storage.objects.has(p!.originalKey)).toBe(true);
    expect(t.storage.objects.has(p!.previewKey!)).toBe(true);
    expect(t.storage.objects.has(p!.thumbKey!)).toBe(true);
    expect(p!.checksum).toMatch(/^[0-9a-f]{64}$/);

    const summary = (await owner.get(`/api/events/${ev.id}/upload-summary`)).json();
    expect(summary).toMatchObject({ ready: 1, failed: 0, total: 1 });
  });

  it('rejects unsupported types and oversize files up front, per file', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const res = await owner.post(`/api/events/${ev.id}/uploads`, {
      files: [
        { filename: 'ok.jpg', contentType: 'image/jpeg', sizeBytes: 1000 },
        { filename: 'evil.exe', contentType: 'application/x-msdownload', sizeBytes: 1000 },
        { filename: 'huge.jpg', contentType: 'image/jpeg', sizeBytes: 10 * 1024 ** 3 },
      ],
    });
    const body = res.json();
    expect(body.uploads).toHaveLength(1);
    expect(body.rejected.map((r: { filename: string }) => r.filename).sort()).toEqual(['evil.exe', 'huge.jpg']);
  });

  it('detects files that lie about their type, keeps the original, and lets the photographer retry', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const up = await uploadPhoto(t, owner, ev.id, { data: Buffer.from('MZ this is not an image') });
    await expect(processPhoto(t.ctx, up.photoId)).rejects.toBeInstanceOf(PermanentProcessingError);
    const { markFailed } = await import('../src/jobs/process-photo.js');
    await markFailed(t.ctx, up.photoId, 'File is not a supported image');

    const [failed] = await t.ctx.db.select().from(photos).where(eq(photos.id, up.photoId));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(t.storage.objects.has(failed!.originalKey)).toBe(true); // original never lost

    // Photographer replaces the file and completes again — no need to restart the batch.
    const url = (await owner.post(`/api/photos/${up.photoId}/upload-url`)).json().uploadUrl as string;
    expect(url).toContain(failed!.originalKey);
    const good = await testImage(300, 200);
    t.storage.objects.set(failed!.originalKey, { body: good, contentType: 'image/jpeg' });
    await t.ctx.db.update(photos).set({ sizeBytes: good.length }).where(eq(photos.id, up.photoId));
    const done = await owner.post(`/api/events/${ev.id}/uploads/complete`, { photoIds: [up.photoId] });
    expect(done.json().results[0].ok).toBe(true);
    expect(await processPhoto(t.ctx, up.photoId)).toBe('ready');
  });

  it('retries failed processing without re-uploading', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const id = await readyPhoto(t, owner, ev.id);
    await t.ctx.db.update(photos).set({ status: 'failed', error: 'boom' }).where(eq(photos.id, id));
    expect((await owner.post(`/api/photos/${id}/retry`)).statusCode).toBe(200);
    expect(await processPhoto(t.ctx, id)).toBe('ready');
    expect((await owner.post(`/api/photos/${id}/retry`)).statusCode).toBe(409);
  });

  it('flags a size mismatch as an incomplete upload instead of processing it', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const data = await testImage();
    const init = await owner.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: data.length + 5 }] });
    const { uploads } = init.json();
    t.storage.objects.set(decodeURIComponent(uploads[0].uploadUrl.replace('memory://upload/', '')), { body: data, contentType: 'image/jpeg' });
    const done = await owner.post(`/api/events/${ev.id}/uploads/complete`, { photoIds: [uploads[0].photoId] });
    expect(done.json().results[0]).toMatchObject({ ok: false });
  });

  it('recovers photos whose job was lost', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const { photoId } = await uploadPhoto(t, owner, ev.id);
    await t.ctx.db.execute(`update photos set updated_at = now() - interval '1 hour' where id = '${photoId}'` as never);
    const before = t.added.length;
    const r = await recoverStuckPhotos(t.ctx);
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect(t.added.length).toBeGreaterThan(before);
  });

  it('enforces the owner storage quota', async () => {
    const owner = await session(t, 'photographer', { storageQuotaBytes: 1000 });
    const ev = await makeEvent(owner);
    const res = await owner.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 5000 }] });
    expect(res.statusCode).toBe(413);
  });
});

describe('publishing and public galleries', () => {
  it('cannot publish an empty event; public link works after publishing', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    expect((await owner.post(`/api/events/${ev.id}/publish`)).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` })).statusCode).toBe(404); // drafts don't exist publicly

    await readyPhoto(t, owner, ev.id);
    const pub = await publish(owner, ev.id);
    expect(pub.status).toBe('active');
    expect(pub.expiresAt).toBeTruthy();

    const page = await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.json().event.galleries[0]).toMatchObject({ name: 'General', photoCount: 1 });
    // Regression: correlated counts must reference the outer table, not the subquery's own columns.
    expect((await owner.get(`/api/events/${ev.id}/galleries`)).json().items[0]).toMatchObject({ photoCount: 1, readyCount: 1 });
    expect((await owner.get('/api/events')).json().items.find((e: { id: string }) => e.id === ev.id)).toMatchObject({ photoCount: 1, readyCount: 1 });
    const list = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` })).json();
    expect(list.total).toBe(1);
    expect(list.items[0].downloadable).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/originals\//); // internal storage layout never leaks

    const thumb = await t.app.inject({ method: 'GET', url: list.items[0].thumbUrl });
    expect(thumb.statusCode).toBe(302);
    expect(thumb.headers.location).toContain('memory://download/');
  });

  it('hidden photos and hidden galleries are not public', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const id = await readyPhoto(t, owner, ev.id);
    await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);
    await owner.patch(`/api/photos/${id}`, { isHidden: true });
    const list = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` })).json();
    expect(list.total).toBe(1);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/thumb` })).statusCode).toBe(404);
  });

  it('private events require the password; changing it revokes earlier access', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner, { visibility: 'private', password: 'open-sesame' });
    const id = await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);

    const denied = await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('password_required');
    expect((await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/thumb` })).statusCode).toBe(401);

    expect((await t.app.inject({ method: 'POST', url: `/api/public/events/${ev.slug}/unlock`, payload: { password: 'wrong-one' } })).statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: `/api/public/events/${ev.slug}/unlock`, payload: { password: 'open-sesame' } });
    expect(ok.statusCode).toBe(200);
    const grant = ok.cookies[0]!;
    const cookie = `${grant.name}=${grant.value}`;
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos`, headers: { cookie } })).statusCode).toBe(200);

    await owner.patch(`/api/events/${ev.id}`, { password: 'a-new-password' });
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos`, headers: { cookie } })).statusCode).toBe(401);
  });

  it('download policy: disabled blocks, preview serves the preview, full serves the original; galleries can only restrict', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner, { downloadPolicy: 'preview' });
    const id = await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, id));

    const dl = () => t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/download` });
    let r = await dl();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain(p!.previewKey!);

    await owner.patch(`/api/events/${ev.id}`, { downloadPolicy: 'full' });
    r = await dl();
    expect(r.headers.location).toContain(p!.originalKey);

    const gallery = (await owner.get(`/api/events/${ev.id}/galleries`)).json().items[0];
    await owner.patch(`/api/galleries/${gallery.id}`, { downloadPolicy: 'disabled' });
    expect((await dl()).statusCode).toBe(403);

    // A gallery cannot widen an event that disables downloads.
    await owner.patch(`/api/events/${ev.id}`, { downloadPolicy: 'disabled' });
    await owner.patch(`/api/galleries/${gallery.id}`, { downloadPolicy: 'full' });
    expect((await dl()).statusCode).toBe(403);
  });

  it('expired events are closed immediately (even before the scheduler runs) and keep their photographs', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner);
    const id = await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, id));

    await t.ctx.db.update(events).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(events.id, ev.id));
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` })).statusCode).toBe(410);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/thumb` })).statusCode).toBe(410);

    await expireEvents(t.ctx);
    const [row] = await t.ctx.db.select().from(events).where(eq(events.id, ev.id));
    expect(row!.status).toBe('expired');
    expect(t.storage.objects.has(p!.originalKey)).toBe(true);
    expect(await t.ctx.db.select().from(photos).where(eq(photos.id, id))).toHaveLength(1);
    const note = await t.ctx.db.select().from(notifications).where(eq(notifications.userId, owner.user.id));
    expect(note.some((n) => n.type === 'event.expired')).toBe(true);

    // Photographers cannot self-extend; administrators can.
    expect((await owner.post(`/api/events/${ev.id}/extend`, { expiresAt: new Date(Date.now() + 864e5).toISOString() })).statusCode).toBe(403);
    const ext = await admin.post(`/api/events/${ev.id}/extend`, { expiresAt: new Date(Date.now() + 864e5).toISOString() });
    expect(ext.json().event.status).toBe('active');
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` })).statusCode).toBe(200);
  });

  it('archived events leave public view and become due for review after retention', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner);
    await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);
    await admin.post(`/api/events/${ev.id}/archive`);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` })).statusCode).toBe(404);
    await t.ctx.db.update(events).set({ retentionReviewAt: new Date(Date.now() - 1000) }).where(eq(events.id, ev.id));
    await flagRetentionReviews(t.ctx);
    const [row] = await t.ctx.db.select().from(events).where(eq(events.id, ev.id));
    expect(row!.status).toBe('scheduled_for_deletion');
    expect(row).toBeTruthy();
  });
});

describe('website integration', () => {
  async function setup() {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const pub = await makeEvent(owner, { downloadPolicy: 'full' });
    const priv = await makeEvent(owner, { visibility: 'private', password: 'secret-pass' });
    const draft = await makeEvent(owner);
    const photoId = await readyPhoto(t, owner, pub.id);
    await readyPhoto(t, owner, priv.id);
    await publish(owner, pub.id);
    await publish(owner, priv.id);
    const created = await admin.post('/api/admin/websites', { name: `Site ${Math.random()}` });
    const { apiKey, website } = created.json();
    const api = (url: string, key = apiKey) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
    return { owner, admin, pub, priv, draft, photoId, apiKey, website, api };
  }

  it('requires a valid key and exposes only public, active events', async () => {
    const s = await setup();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/events' })).statusCode).toBe(401);
    expect((await s.api('/api/v1/events', 'iu_live_bogus')).statusCode).toBe(401);

    const list = (await s.api('/api/v1/events?pageSize=200')).json();
    const ids = list.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(s.pub.id);
    expect(ids).not.toContain(s.priv.id);
    expect(ids).not.toContain(s.draft.id);
    expect((await s.api(`/api/v1/events/${s.priv.id}`)).statusCode).toBe(404);
    expect((await s.api(`/api/v1/events/${s.draft.id}`)).statusCode).toBe(404);
    expect((await s.api(`/api/v1/events/${s.pub.slug}`)).statusCode).toBe(200);
  });

  it('returns photographs with signed media URLs that work without the key', async () => {
    const s = await setup();
    const photos = (await s.api(`/api/v1/events/${s.pub.id}/photos`)).json();
    expect(photos.total).toBe(1);
    const urls = photos.items[0].urls;
    expect(urls.download).toBeNull(); // default scopes exclude downloads
    const thumb = await t.app.inject({ method: 'GET', url: new URL(urls.thumbnail).pathname + new URL(urls.thumbnail).search });
    expect(thumb.statusCode).toBe(302);
    const tampered = await t.app.inject({ method: 'GET', url: new URL(urls.thumbnail).pathname.replace(/thumbnail$/, 'preview') + new URL(urls.thumbnail).search });
    expect(tampered.statusCode).toBe(403);
  });

  it('enforces scopes, event allow-lists and disabled downloads', async () => {
    const s = await setup();
    const narrow = (await s.admin.post('/api/admin/websites', { name: `Narrow ${Math.random()}`, scopes: ['events:read'], allowedEventIds: [s.pub.id] })).json();
    expect((await s.api('/api/v1/events', narrow.apiKey)).statusCode).toBe(200);
    expect((await s.api(`/api/v1/events/${s.pub.id}/photos`, narrow.apiKey)).statusCode).toBe(403);

    const full = (await s.admin.post('/api/admin/websites', { name: `Full ${Math.random()}`, scopes: ['events:read', 'galleries:read', 'images:read', 'downloads:read'] })).json();
    const items = (await s.api(`/api/v1/events/${s.pub.id}/photos`, full.apiKey)).json().items;
    expect(items[0].urls.download).toContain('/download?');
    await s.owner.patch(`/api/events/${s.pub.id}`, { downloadPolicy: 'disabled' });
    const after = (await s.api(`/api/v1/events/${s.pub.id}/photos`, full.apiKey)).json().items;
    expect(after[0].urls.download).toBeNull();
  });

  it('revoking a website stops all further access immediately, including outstanding media links', async () => {
    const s = await setup();
    const items = (await s.api(`/api/v1/events/${s.pub.id}/photos`)).json().items;
    const link = new URL(items[0].urls.preview);
    const media = () => t.app.inject({ method: 'GET', url: link.pathname + link.search });
    expect((await media()).statusCode).toBe(302);

    const other = (await s.admin.post('/api/admin/websites', { name: `Other ${Math.random()}` })).json();

    expect((await s.admin.post(`/api/admin/websites/${s.website.id}/revoke`)).statusCode).toBe(200);
    expect((await s.api('/api/v1/events')).statusCode).toBe(403);
    expect((await media()).statusCode).toBe(403);
    // Other websites are unaffected.
    expect((await s.api('/api/v1/events', other.apiKey)).statusCode).toBe(200);
    // Revoked access cannot be resurrected.
    expect((await s.admin.patch(`/api/admin/websites/${s.website.id}`, { status: 'active' })).statusCode).toBe(409);
    expect((await s.api('/api/v1/events')).statusCode).toBe(403);
  });

  it('only administrators manage websites, keys are hashed at rest, and rotation invalidates the old key', async () => {
    const s = await setup();
    expect((await s.owner.get('/api/admin/websites')).statusCode).toBe(403);
    const list = (await s.admin.get('/api/admin/websites')).json();
    expect(JSON.stringify(list)).not.toContain(s.apiKey);
    const rotated = (await s.admin.post(`/api/admin/websites/${s.website.id}/rotate-key`)).json();
    expect((await s.api('/api/v1/events')).statusCode).toBe(401);
    expect((await s.api('/api/v1/events', rotated.apiKey)).statusCode).toBe(200);
  });

  it('rate limits per credential', async () => {
    const s = await setup();
    const c = (await s.admin.post('/api/admin/websites', { name: `Limited ${Math.random()}`, rateLimitPerMinute: 10 })).json();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await s.api('/api/v1/events', c.apiKey)).statusCode);
    expect(codes.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe('sharing and stats', () => {
  it('generates a QR code that points at the public link', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const svg = await owner.get(`/api/events/${ev.id}/qr`);
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    const png = await owner.get(`/api/events/${ev.id}/qr?format=png`);
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('records views and downloads for event statistics', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner, { downloadPolicy: 'full' });
    const id = await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);
    await t.app.inject({ method: 'POST', url: `/api/public/events/${ev.slug}/view` });
    await t.app.inject({ method: 'POST', url: `/api/public/photos/${id}/view` });
    await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/download` });
    const stats = (await owner.get(`/api/events/${ev.id}/stats`)).json();
    expect(stats).toMatchObject({ views: 1, photoViews: 1, downloads: 1, uniqueVisitors: 1, readyPhotos: 1 });
    expect(stats.storageBytes).toBeGreaterThan(0);
    const me = (await owner.get('/api/stats/me')).json();
    expect(me).toMatchObject({ events: 1, photos: 1, downloads: 1 });
  });
});

describe('admin developer tools', () => {
  async function setup() {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner, { downloadPolicy: 'full' });
    await readyPhoto(t, owner, ev.id);
    await readyPhoto(t, owner, ev.id);
    const site = (await admin.post('/api/admin/websites', { name: `Dev ${Math.random()}`, scopes: ['events:read', 'galleries:read', 'images:read'] })).json();
    return { owner, admin, ev, site };
  }

  it('is administrator-only, even for the event owner', async () => {
    const { owner, ev, site } = await setup();
    expect((await owner.get(`/api/admin/events/${ev.id}/developer`)).statusCode).toBe(403);
    expect((await owner.get(`/api/admin/events/${ev.id}/developer/preview?clientId=${site.website.id}&resource=event`)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/admin/events/${ev.id}/developer` })).statusCode).toBe(401);
  });

  it('explains whether and why an event is exposed, and which websites can reach it', async () => {
    const { owner, admin, ev, site } = await setup();
    let dev = (await admin.get(`/api/admin/events/${ev.id}/developer`)).json();
    expect(dev.exposure.exposed).toBe(false); // draft
    expect(dev.exposure.reason).toMatch(/draft/);
    expect(dev.endpoints.map((e: { key: string }) => e.key)).toEqual(['event', 'galleries', 'photos', 'media']);
    expect(dev.endpoints[0].url).toContain(`/api/v1/events/${ev.id}`);

    await publish(owner, ev.id);
    dev = (await admin.get(`/api/admin/events/${ev.id}/developer`)).json();
    expect(dev.exposure.exposed).toBe(true);
    const mine = dev.websites.find((w: { id: string }) => w.id === site.website.id);
    expect(mine.canAccess).toBe(true);
    expect(JSON.stringify(dev)).not.toContain(site.apiKey); // secrets are never returned

    await admin.patch(`/api/admin/websites/${site.website.id}`, { allowedEventIds: [(await makeEvent(owner)).id] });
    dev = (await admin.get(`/api/admin/events/${ev.id}/developer`)).json();
    expect(dev.websites.find((w: { id: string }) => w.id === site.website.id).canAccess).toBe(false);
  });

  it('preview returns exactly what the website receives from the real API', async () => {
    const { owner, admin, ev, site } = await setup();
    await publish(owner, ev.id);
    const real = async (path: string) => (await t.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${site.apiKey}` } })).json();
    const preview = async (resource: string) => (await admin.get(`/api/admin/events/${ev.id}/developer/preview?clientId=${site.website.id}&resource=${resource}`)).json();

    const p = await preview('photos');
    expect(p.status).toBe(200);
    const r = await real(`/events/${ev.id}/photos?pageSize=25`);
    expect(p.body.items.map((i: { id: string }) => i.id)).toEqual(r.items.map((i: { id: string }) => i.id));
    expect(p.body.total).toBe(r.total);
    expect((await preview('event')).body.event.id).toBe(ev.id);
    expect((await preview('galleries')).body.items[0].name).toBe('General');
  });

  it('preview reports what the API would do: missing scope, hidden event, and refuses dead credentials', async () => {
    const { owner, admin, ev, site } = await setup();
    const narrow = (await admin.post('/api/admin/websites', { name: `Narrow ${Math.random()}`, scopes: ['events:read'] })).json();
    await publish(owner, ev.id);
    const url = (id: string, resource: string) => `/api/admin/events/${ev.id}/developer/preview?clientId=${id}&resource=${resource}`;
    const denied = (await admin.get(url(narrow.website.id, 'photos'))).json();
    expect(denied).toMatchObject({ status: 403 });

    const priv = await makeEvent(owner, { visibility: 'private', password: 'secret-pass' });
    await readyPhoto(t, owner, priv.id);
    await publish(owner, priv.id);
    const hidden = (await admin.get(`/api/admin/events/${priv.id}/developer/preview?clientId=${site.website.id}&resource=event`)).json();
    expect(hidden).toMatchObject({ status: 404 });

    await admin.post(`/api/admin/websites/${site.website.id}/revoke`);
    expect((await admin.get(url(site.website.id, 'event'))).statusCode).toBe(409);
  });
});
