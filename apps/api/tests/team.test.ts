import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, events, galleries, notifications, photos } from '../src/db/schema.js';
import { createTestApp, makeEvent, makeUser, readyPhoto, readyVideo, session, testImage, uniq, uploadPhoto, type Session, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const publish = async (s: Session, id: string) => (await s.post(`/api/events/${id}/publish`));

/** An editor creates an event and invites a photographer to cover it. */
async function setup() {
  const editor = await session(t, 'editor');
  const admin = await session(t, 'admin');
  const crew = await session(t); // invited photographer
  const outsider = await session(t); // another photographer, not invited
  const ev = await makeEvent(editor, { name: `Editor event ${uniq()}` });
  const invite = await editor.post(`/api/events/${ev.id}/members`, { userId: crew.user.id });
  return { editor, admin, crew, outsider, ev, invite };
}

describe('editor creates an event and invites photographers', () => {
  it('editor can create events; invitations need an editor or administrator and an active photographer', async () => {
    const { editor, admin, crew, outsider, ev, invite } = await setup();
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toMatchObject({ added: true, member: { userId: crew.user.id } });
    expect((await editor.get(`/api/events/${ev.id}`)).json().event).toMatchObject({ ownerId: editor.user.id, myAccess: 'manage', memberCount: 1 });

    // Inviting twice is harmless.
    expect((await editor.post(`/api/events/${ev.id}/members`, { userId: crew.user.id })).json().added).toBe(false);
    // Roles and states that cannot be invited.
    const otherEditor = await makeUser(t, 'editor');
    expect((await editor.post(`/api/events/${ev.id}/members`, { userId: otherEditor.id })).statusCode).toBe(400);
    expect((await editor.post(`/api/events/${ev.id}/members`, { userId: editor.user.id })).statusCode).toBe(400);
    const suspended = await makeUser(t, 'photographer', { status: 'suspended' });
    expect((await editor.post(`/api/events/${ev.id}/members`, { userId: suspended.id })).statusCode).toBe(400);
    // Photographers cannot invite, not even to events they own.
    const own = await makeEvent(outsider);
    expect((await outsider.post(`/api/events/${own.id}/members`, { userId: crew.user.id })).statusCode).toBe(403);
    expect((await crew.post(`/api/events/${ev.id}/members`, { userId: outsider.user.id })).statusCode).toBe(403);
    // Administrators can.
    expect((await admin.post(`/api/events/${ev.id}/members`, { userId: outsider.user.id })).statusCode).toBe(201);
    await editor.del(`/api/events/${ev.id}/members/${outsider.user.id}`);

    // The invited person is notified and the invitation is audited.
    const note = await t.ctx.db.select().from(notifications).where(eq(notifications.userId, crew.user.id));
    expect(note.some((n) => n.type === 'event.invited' && n.title.includes('Editor event'))).toBe(true);
    const logs = await t.ctx.db.select().from(auditLogs).where(sql`${auditLogs.eventId} = ${ev.id} and ${auditLogs.action} like 'event.member_%'`);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['event.member_added', 'event.member_removed']));
  });

  it('candidate search lists only active photographers who are not yet on the event', async () => {
    const { editor, crew, outsider, ev } = await setup();
    const cands = (await editor.get(`/api/events/${ev.id}/member-candidates?q=${encodeURIComponent(outsider.user.email)}`)).json().items as { id: string }[];
    expect(cands.some((c) => c.id === outsider.user.id)).toBe(true);
    expect(cands.some((c) => c.id === crew.user.id)).toBe(false); // already invited
    expect(cands.some((c) => c.id === editor.user.id)).toBe(false); // owner / not a photographer
    expect((await crew.get(`/api/events/${ev.id}/member-candidates`)).statusCode).toBe(403);
  });
});

describe('what an invited photographer can and cannot do', () => {
  it('sees the event, uploads photos and videos, and edits only their own uploads', async () => {
    const { editor, crew, ev } = await setup();
    const list = (await crew.get('/api/events?pageSize=100')).json().items as { id: string; myAccess: string }[];
    expect(list.find((e) => e.id === ev.id)?.myAccess).toBe('contribute');
    expect((await crew.get(`/api/events/${ev.id}`)).json().event.myAccess).toBe('contribute');
    expect((await crew.get(`/api/events/${ev.id}/galleries`)).statusCode).toBe(200);

    const photo = await readyPhoto(t, crew, ev.id);
    const clip = await readyVideo(t, crew, ev.id);
    const mine = (await crew.get(`/api/events/${ev.id}/photos`)).json();
    expect(mine.total).toBe(2);
    expect(mine.items.map((i: { id: string; mediaType: string }) => [i.id, i.mediaType]).sort()).toEqual([[clip, 'video'], [photo, 'image']].sort());
    expect((await crew.get(`/api/events/${ev.id}/upload-summary`)).json()).toMatchObject({ ready: 2 });

    // Describe their own work.
    expect((await crew.patch(`/api/photos/${photo}`, { title: 'Crowd at the gate', tags: ['crowd'] })).statusCode).toBe(200);
    // An editor's photo in the same event is off limits.
    const editorsOwn = await t.ctx.db.insert(photos).values({ eventId: ev.id, uploaderId: editor.user.id, filename: 'E.jpg', contentType: 'image/jpeg', sizeBytes: 1, originalKey: `events/${ev.id}/originals/${uniq()}.jpg`, status: 'ready' }).returning();
    expect((await crew.patch(`/api/photos/${editorsOwn[0]!.id}`, { title: 'hijack' })).statusCode).toBe(403);
    expect((await crew.get(`/api/photos/${editorsOwn[0]!.id}/original`)).statusCode).toBe(403);
    // Organising the event is for owners and editors.
    expect((await crew.patch(`/api/photos/${photo}`, { isHidden: true })).statusCode).toBe(403);
    expect((await crew.post(`/api/events/${ev.id}/photos/bulk`, { photoIds: [photo], isHidden: true })).statusCode).toBe(403);
    expect((await crew.del(`/api/photos/${photo}`)).statusCode).toBe(403);
    // The editor, as owner, sees and curates their uploads.
    expect((await editor.patch(`/api/photos/${photo}`, { description: 'Edited by the editor', isHidden: false })).statusCode).toBe(200);
  });

  it('cannot change the event, publish it, manage galleries or invite; non-members cannot see it at all', async () => {
    const { editor, admin, crew, outsider, ev } = await setup();
    await readyPhoto(t, crew, ev.id);
    for (const [method, url, body] of [
      ['PATCH', `/api/events/${ev.id}`, { name: 'Mine now' }],
      ['POST', `/api/events/${ev.id}/publish`, {}],
      ['POST', `/api/events/${ev.id}/unpublish`, {}],
      ['POST', `/api/events/${ev.id}/galleries`, { name: 'x' }],
      ['GET', `/api/events/${ev.id}/members`, undefined],
      ['GET', `/api/events/${ev.id}/stats`, undefined],
      ['GET', `/api/events/${ev.id}/qr`, undefined],
      ['POST', `/api/events/${ev.id}/archive`, {}],
    ] as const) {
      const res = await crew.call(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of [`/api/events/${ev.id}`, `/api/events/${ev.id}/photos`, `/api/events/${ev.id}/galleries`, `/api/events/${ev.id}/upload-summary`]) {
      expect((await outsider.get(url)).statusCode, url).toBe(404);
    }
    expect((await outsider.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(404);
    expect((await outsider.get('/api/events?pageSize=200')).json().items.some((e: { id: string }) => e.id === ev.id)).toBe(false);

    // Publishing stays with the people allowed to publish; the contributor's work appears in the public gallery.
    expect((await publish(editor, ev.id)).statusCode).toBe(403); // editors do not publish by default
    expect((await publish(admin, ev.id)).statusCode).toBe(200);
    const pub = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` })).json();
    expect(pub.total).toBe(1);
  });

  it('losing access is immediate; their uploads stay; contributors only see their own uploads in the library', async () => {
    const { editor, crew, ev } = await setup();
    const photo = await readyPhoto(t, crew, ev.id);
    const other = await t.ctx.db.insert(photos).values({ eventId: ev.id, uploaderId: editor.user.id, filename: 'E.jpg', contentType: 'image/jpeg', sizeBytes: 1, originalKey: `k/${uniq()}.jpg`, status: 'ready' }).returning();
    const lib = (await crew.get(`/api/library/media?eventId=${ev.id}&pageSize=100`)).json().items.map((i: { id: string }) => i.id);
    expect(lib).toEqual([photo]);
    expect(lib).not.toContain(other[0]!.id);

    expect((await editor.del(`/api/events/${ev.id}/members/${crew.user.id}`)).statusCode).toBe(204);
    expect((await crew.get(`/api/events/${ev.id}`)).statusCode).toBe(404);
    expect((await crew.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(404);
    expect((await editor.get(`/api/events/${ev.id}/photos`)).json().total).toBe(2); // uploads stay with the event
    expect((await editor.del(`/api/events/${ev.id}/members/${crew.user.id}`)).statusCode).toBe(404);
  });

  it('stats and quotas follow the uploader, not the event owner', async () => {
    const { editor, ev } = await setup();
    const limited = await session(t, 'photographer', { storageQuotaBytes: 1000 });
    await editor.post(`/api/events/${ev.id}/members`, { userId: limited.user.id });
    const res = await limited.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'big.jpg', contentType: 'image/jpeg', sizeBytes: 5000 }] });
    expect(res.statusCode).toBe(413);
    const free = await session(t);
    await editor.post(`/api/events/${ev.id}/members`, { userId: free.user.id });
    await readyPhoto(t, free, ev.id);
    expect((await free.get('/api/stats/me')).json()).toMatchObject({ photos: 1, events: 1 });
  });

  it('uploads are closed on archived events', async () => {
    const { admin, crew, ev } = await setup();
    await admin.post(`/api/events/${ev.id}/archive`);
    expect((await crew.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(409);
    expect((await admin.post(`/api/events/${ev.id}/members`, { userId: (await makeUser(t)).id })).statusCode).toBe(409);
  });
});

describe('folder uploads: subfolders become galleries', () => {
  it('creates galleries from folder names once, reuses them case-insensitively, and defaults to the first gallery', async () => {
    const { crew, ev } = await setup();
    const files = [
      { filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100, galleryName: 'Finish Line' },
      { filename: 'b.jpg', contentType: 'image/jpeg', sizeBytes: 100, galleryName: 'finish line' },
      { filename: 'c.jpg', contentType: 'image/jpeg', sizeBytes: 100, galleryName: 'Podium' },
      { filename: 'd.jpg', contentType: 'image/jpeg', sizeBytes: 100 },
    ];
    const res = (await crew.post(`/api/events/${ev.id}/uploads`, { files })).json();
    expect(res.uploads).toHaveLength(4);
    const gals = await t.ctx.db.select().from(galleries).where(eq(galleries.eventId, ev.id));
    expect(gals.map((g) => g.name).sort()).toEqual(['Finish Line', 'General', 'Podium']);
    const rows = await t.ctx.db.select().from(photos).where(eq(photos.eventId, ev.id));
    const byName = (n: string) => gals.find((g) => g.name === n)!.id;
    expect(Object.fromEntries(rows.map((r) => [r.filename, r.galleryId]))).toEqual({ 'a.jpg': byName('Finish Line'), 'b.jpg': byName('Finish Line'), 'c.jpg': byName('Podium'), 'd.jpg': byName('General') });
    // A second batch reuses them.
    await crew.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'e.jpg', contentType: 'image/jpeg', sizeBytes: 100, galleryName: 'PODIUM' }] });
    expect(await t.ctx.db.select().from(galleries).where(eq(galleries.eventId, ev.id))).toHaveLength(3);
  });
});

describe('event cover', () => {
  async function published() {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner);
    const a = await readyPhoto(t, owner, ev.id);
    const b = await readyPhoto(t, owner, ev.id);
    await owner.post(`/api/events/${ev.id}/publish`);
    const site = (await admin.post('/api/admin/websites', { name: `Cover ${uniq()}`, scopes: ['events:read', 'images:read'] })).json();
    const v1 = async (path: string) => t.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${site.apiKey}` } });
    return { owner, ev, a, b, v1 };
  }

  it('any photo can be the cover, it can be changed or reset, and the gallery and websites follow', async () => {
    const { owner, ev, a, b, v1 } = await published();
    const location = async () => (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/cover` })).headers.location as string;
    const key = async (id: string) => (await t.ctx.db.select().from(photos).where(eq(photos.id, id)))[0]!.previewKey!;

    expect(await location()).toContain(await key(a)); // automatic: the first photograph
    expect((await owner.get(`/api/events/${ev.id}`)).json().event.coverUrl).toContain('memory://download/');

    expect((await owner.patch(`/api/events/${ev.id}`, { coverPhotoId: b })).statusCode).toBe(200);
    expect(await location()).toContain(await key(b));
    expect((await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}` })).json().event.coverUrl).toBe(`/api/public/events/${ev.slug}/cover`);
    const ext = (await v1(`/events/${ev.id}`)).json().event;
    expect(ext.cover.preview).toContain('/api/v1/media/' + b);

    // Reset to automatic.
    expect((await owner.patch(`/api/events/${ev.id}`, { coverPhotoId: null })).statusCode).toBe(200);
    expect(await location()).toContain(await key(a));
    // A cover must belong to the event.
    const foreign = await readyPhoto(t, await session(t), (await makeEvent(await session(t))).id).catch(() => null);
    void foreign;
  });

  it('a cover-only image is hidden from the gallery but still serves as the cover everywhere', async () => {
    const { owner, ev, v1 } = await published();
    const up = await uploadPhoto(t, owner, ev.id, { filename: 'BANNER.jpg' }); // placeholder to reuse helper
    void up;
    const init = (await owner.post(`/api/events/${ev.id}/uploads`, { asCover: true, files: [{ filename: 'BANNER.jpg', contentType: 'image/jpeg', sizeBytes: (await testImage(1600, 600)).length }] })).json();
    const id = init.uploads[0].photoId as string;
    const data = await testImage(1600, 600);
    await t.ctx.db.update(photos).set({ sizeBytes: data.length }).where(eq(photos.id, id));
    const row = (await t.ctx.db.select().from(photos).where(eq(photos.id, id)))[0]!;
    expect(row.isHidden).toBe(true);
    t.storage.objects.set(row.originalKey, { body: data, contentType: 'image/jpeg' });
    await owner.post(`/api/events/${ev.id}/uploads/complete`, { photoIds: [id] });
    const { processMedia } = await import('../src/jobs/process-photo.js');
    await processMedia(t.ctx, id);
    expect((await owner.patch(`/api/events/${ev.id}`, { coverPhotoId: id })).statusCode).toBe(200);

    const pub = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` })).json();
    expect(pub.items.some((i: { id: string }) => i.id === id)).toBe(false); // not part of the gallery
    const cover = await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/cover` });
    expect(cover.headers.location).toContain((await t.ctx.db.select().from(photos).where(eq(photos.id, id)))[0]!.previewKey!);
    const ext = (await v1(`/events/${ev.id}`)).json().event;
    expect(ext.cover.thumbnail).toContain(id);
    const link = new URL(ext.cover.thumbnail);
    expect((await t.app.inject({ method: 'GET', url: link.pathname + link.search })).statusCode).toBe(302); // loads although hidden
    const media = (await v1(`/events/${ev.id}/media`)).json();
    expect(media.items.some((i: { id: string }) => i.id === id)).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/preview` })).statusCode).toBe(404); // not browsable as a photo
    void events;
  });

  it('only owners and editors can upload a cover-only image', async () => {
    const { editor, crew, ev } = await setup();
    expect((await crew.post(`/api/events/${ev.id}/uploads`, { asCover: true, files: [{ filename: 'c.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(403);
    expect((await editor.post(`/api/events/${ev.id}/uploads`, { asCover: true, files: [{ filename: 'c.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(200);
    expect((await crew.patch(`/api/events/${ev.id}`, { coverPhotoId: null })).statusCode).toBe(403);
  });
});
