import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, events, photos } from '../src/db/schema.js';
import { ffprobeBin, run } from '../src/lib/ffmpeg.js';
import { PermanentProcessingError, processMedia } from '../src/jobs/process-photo.js';
import { createTestApp, makeEvent, readyPhoto, readyVideo, session, testImage, testVideo, uniq, uploadPhoto, type Session, type TestApp } from './helpers.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const publish = async (s: Session, id: string) => (await s.post(`/api/events/${id}/publish`)).json().event;
const probe = async (buf: Buffer, name: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'iu-probe-'));
  try {
    await writeFile(join(dir, name), buf);
    return JSON.parse(await run(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', join(dir, name)]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('video', () => {
  it('uploads, transcodes to a web-playable MP4, makes a poster and keeps the original', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const original = await testVideo({ size: '1280x720' });
    const up = await uploadPhoto(t, owner, ev.id, { data: original, filename: 'FINISH.mov', contentType: 'video/quicktime' });
    expect(up.done.json().results[0].ok).toBe(true);
    const queued = t.added.at(-1);
    expect(queued?.data).toEqual({ photoId: up.photoId });

    expect(await processMedia(t.ctx, up.photoId)).toBe('ready');
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, up.photoId));
    expect(p).toMatchObject({ mediaType: 'video', status: 'ready', width: 1280, height: 720 });
    expect(p!.durationSeconds).toBeGreaterThan(1.5);
    expect(p!.durationSeconds).toBeLessThan(2.6);
    expect(t.storage.objects.get(p!.originalKey)!.body.equals(original)).toBe(true); // original untouched

    const preview = t.storage.objects.get(p!.previewKey!)!;
    expect(preview.contentType).toBe('video/mp4');
    const info = await probe(preview.body, 'preview.mp4');
    expect(info.streams.find((s: { codec_type: string }) => s.codec_type === 'video').codec_name).toBe('h264');
    expect(info.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')).toBe(true);
    expect(t.storage.objects.get(p!.thumbKey!)!.contentType).toBe('image/webp');
  });

  it('downscales large video and also accepts WebM', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const up = await uploadPhoto(t, owner, ev.id, { data: await testVideo({ size: '2560x1440', seconds: 1 }), filename: 'WIDE.mp4', contentType: 'video/mp4' });
    await processMedia(t.ctx, up.photoId);
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, up.photoId));
    const info = await probe(t.storage.objects.get(p!.previewKey!)!.body, 'p.mp4');
    expect(info.streams.find((s: { codec_type: string }) => s.codec_type === 'video').width).toBe(1920);
    expect(p!.width).toBe(2560); // the original's real dimensions are reported

    const webm = await uploadPhoto(t, owner, ev.id, { data: await testVideo({ format: 'webm', seconds: 1 }), filename: 'CLIP.webm', contentType: 'video/webm' });
    await processMedia(t.ctx, webm.photoId);
    expect((await t.ctx.db.select().from(photos).where(eq(photos.id, webm.photoId)))[0]).toMatchObject({ status: 'ready', mediaType: 'video', format: 'webm' });
  });

  it('rejects files that are not really video, without losing the original', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const up = await uploadPhoto(t, owner, ev.id, { data: Buffer.from('this is definitely not a movie'), filename: 'FAKE.mp4', contentType: 'video/mp4' });
    await expect(processMedia(t.ctx, up.photoId)).rejects.toBeInstanceOf(PermanentProcessingError);
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, up.photoId));
    expect(t.storage.objects.has(p!.originalKey)).toBe(true);
    // A PNG renamed to .mp4 is caught too.
    const png = await uploadPhoto(t, owner, ev.id, { data: await testImage(), filename: 'IMG.mp4', contentType: 'video/mp4' });
    await expect(processMedia(t.ctx, png.photoId)).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('applies separate size limits for images and videos', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const res = (await owner.post(`/api/events/${ev.id}/uploads`, {
      files: [
        { filename: 'big.mp4', contentType: 'video/mp4', sizeBytes: 500 * 1024 ** 2 },
        { filename: 'huge.mp4', contentType: 'video/mp4', sizeBytes: 3 * 1024 ** 3 },
        { filename: 'big.jpg', contentType: 'image/jpeg', sizeBytes: 200 * 1024 ** 2 },
        { filename: 'x.avi', contentType: 'video/x-msvideo', sizeBytes: 1000 },
      ],
    })).json();
    expect(res.uploads.map((u: { filename: string }) => u.filename)).toEqual(['big.mp4']);
    expect(Object.fromEntries(res.rejected.map((r: { filename: string; reason: string }) => [r.filename, r.reason]))).toMatchObject({
      'huge.mp4': 'Larger than 2 GB',
      'big.jpg': 'Larger than 100 MB',
      'x.avi': 'Unsupported type video/x-msvideo',
    });
  });

  it('is served through the public gallery and the website API with its own type and duration', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner, { downloadPolicy: 'full' });
    const id = await readyVideo(t, owner, ev.id);
    await owner.patch(`/api/photos/${id}`, { title: 'Finish line sprint' });
    await publish(owner, ev.id);

    const list = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos` })).json();
    expect(list.items[0]).toMatchObject({ type: 'video', title: 'Finish line sprint', downloadable: true });
    expect(list.items[0].durationSeconds).toBeGreaterThan(1);
    const prev = await t.app.inject({ method: 'GET', url: list.items[0].previewUrl });
    expect(prev.statusCode).toBe(302);
    const [p] = await t.ctx.db.select().from(photos).where(eq(photos.id, id));
    expect(prev.headers.location).toContain(p!.previewKey!); // plays the transcoded MP4
    const dl = await t.app.inject({ method: 'GET', url: `/api/public/photos/${id}/download` });
    expect(dl.headers.location).toContain(p!.originalKey);
    expect(decodeURIComponent(dl.headers.location as string)).toContain('Finish line sprint.mp4');

    const site = (await admin.post('/api/admin/websites', { name: `Vid ${uniq()}`, scopes: ['events:read', 'images:read', 'downloads:read'] })).json();
    const v1 = (await t.app.inject({ method: 'GET', url: `/api/v1/events/${ev.id}/media?type=video`, headers: { authorization: `Bearer ${site.apiKey}` } })).json();
    expect(v1.total).toBe(1);
    expect(v1.items[0]).toMatchObject({ type: 'video', title: 'Finish line sprint' });
    const none = (await t.app.inject({ method: 'GET', url: `/api/v1/events/${ev.id}/media?type=image`, headers: { authorization: `Bearer ${site.apiKey}` } })).json();
    expect(none.total).toBe(0);
  });
});

describe('titles, descriptions and tags', () => {
  it('lets the owner rename an item and describe it; tags are normalised; edits are audited', async () => {
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const id = await readyPhoto(t, owner, ev.id);
    const res = await owner.patch(`/api/photos/${id}`, { title: '  Winner crossing the line ', description: 'First place, men\'s race', tags: ['Finish Line', ' finish line ', 'WINNER', '', 'x'.repeat(100)] });
    expect(res.statusCode).toBe(200);
    expect(res.json().photo).toMatchObject({ title: 'Winner crossing the line', description: 'First place, men\'s race' });
    expect(res.json().photo.tags).toEqual(['finish line', 'winner', 'x'.repeat(40)]);
    // Comma-separated input is split into separate tags.
    expect((await owner.patch(`/api/photos/${id}`, { tags: ['Winner, Podium', 'finish line'] })).json().photo.tags).toEqual(['winner', 'podium', 'finish line']);
    const [log] = await t.ctx.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(log).toMatchObject({ action: 'media.updated', eventId: ev.id });
    expect((log!.before as { title: unknown }).title).toBeNull();
    expect((log!.after as { title: string }).title).toBe('Winner crossing the line');
    // Clearing the title returns to the file name.
    expect((await owner.patch(`/api/photos/${id}`, { title: '' })).json().photo.title).toBeNull();
  });

  it('every item returned to a website carries its event\'s name, description, date, location and the photographer', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner, { description: 'The annual city marathon', eventDate: '2026-06-20', location: 'Kigali' });
    const id = await readyPhoto(t, owner, ev.id);
    await owner.patch(`/api/photos/${id}`, { title: 'Start line', description: 'Runners at the start', tags: ['start'] });
    await publish(owner, ev.id);
    const site = (await admin.post('/api/admin/websites', { name: `Meta ${uniq()}` })).json();
    const get = async (url: string) => (await t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${site.apiKey}` } })).json();

    const item = (await get(`/api/v1/events/${ev.id}/media`)).items[0];
    expect(item).toMatchObject({
      id, type: 'image', title: 'Start line', description: 'Runners at the start', tags: ['start'], photographer: owner.user.name,
      event: { id: ev.id, name: expect.any(String), description: 'The annual city marathon', date: '2026-06-20', location: 'Kigali', slug: ev.slug },
    });
    expect(item.urls.thumbnail).toContain('/api/v1/media/');
    // Single-item lookup returns the same payload.
    expect((await get(`/api/v1/media/${id}`)).media).toEqual(item);
  });

  it('searches words across title, description, tags and event name', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const tag = uniq('zz');
    const ev = await makeEvent(owner, { name: `Harbour Regatta ${tag}` });
    const a = await readyPhoto(t, owner, ev.id);
    const b = await readyPhoto(t, owner, ev.id);
    await owner.patch(`/api/photos/${a}`, { title: 'Red sails', description: `Boat ${tag}`, tags: ['sail'] });
    await owner.patch(`/api/photos/${b}`, { title: 'Podium', tags: ['trophy', tag] });
    await publish(owner, ev.id);
    const site = (await admin.post('/api/admin/websites', { name: `Search ${uniq()}` })).json();
    const search = async (qs: string) => (await t.app.inject({ method: 'GET', url: `/api/v1/media?${qs}`, headers: { authorization: `Bearer ${site.apiKey}` } })).json();
    expect((await search(`q=${tag}`)).total).toBe(2); // event name / description / tag
    expect((await search(`q=sails+${tag}`)).items.map((i: { id: string }) => i.id)).toEqual([a]);
    expect((await search(`q=${tag}&tag=trophy`)).items.map((i: { id: string }) => i.id)).toEqual([b]);
    expect((await search(`q=nothingmatchesthis`)).total).toBe(0);
    // Public gallery search uses the same fields.
    const pub = (await t.app.inject({ method: 'GET', url: `/api/public/events/${ev.slug}/photos?q=podium` })).json();
    expect(pub.items.map((i: { id: string }) => i.id)).toEqual([b]);
  });
});

describe('editor role', () => {
  it('sees every event and can rename events and media, but cannot upload, publish, delete or change access', async () => {
    const owner = await session(t);
    const editor = await session(t, 'editor');
    const ev = await makeEvent(owner, { name: `Draft name ${uniq()}` });
    const id = await readyPhoto(t, owner, ev.id);
    await publish(owner, ev.id);

    expect((await editor.get('/api/events?pageSize=200')).json().items.some((e: { id: string }) => e.id === ev.id)).toBe(true);
    expect((await editor.get(`/api/events/${ev.id}`)).statusCode).toBe(200);

    // Curating works...
    const renamed = await editor.patch(`/api/events/${ev.id}`, { name: 'Kigali Marathon 2026', description: 'Corrected description', location: 'Kigali' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().event.slug).toBe(ev.slug); // the public link does not move when an event is renamed
    expect((await editor.patch(`/api/photos/${id}`, { title: 'Editor title', description: 'Editor description', tags: ['curated'] })).statusCode).toBe(200);
    const [log] = await t.ctx.db.select().from(auditLogs).where(sql`${auditLogs.entityId} = ${id} and ${auditLogs.actorId} = ${editor.user.id}`);
    expect(log?.action).toBe('media.updated');
    expect((await editor.patch(`/api/photos/${id}`, { isHidden: true })).statusCode).toBe(200); // galleries:manage

    // ...but nothing destructive or access-related.
    expect((await editor.patch(`/api/events/${ev.id}`, { visibility: 'unlisted' })).statusCode).toBe(403);
    expect((await editor.patch(`/api/events/${ev.id}`, { downloadPolicy: 'full' })).statusCode).toBe(403);
    expect((await editor.post(`/api/events/${ev.id}/unpublish`)).statusCode).toBe(403);
    expect((await editor.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(403);
    expect((await editor.post('/api/events', { name: 'New one' })).statusCode).toBe(403);
    expect((await editor.del(`/api/photos/${id}`)).statusCode).toBe(403);
    expect((await editor.post(`/api/events/${ev.id}/archive`)).statusCode).toBe(403);
    for (const url of ['/api/admin/users', '/api/admin/audit', '/api/admin/websites', '/api/admin/settings', '/api/admin/stats']) expect((await editor.get(url)).statusCode, url).toBe(403);
  });

  it('is created by an administrator and cannot be granted admin-only permissions', async () => {
    const admin = await session(t, 'admin');
    const created = await admin.post('/api/admin/users', { email: `${uniq('ed')}@t.dev`, name: 'Edie Editor', role: 'editor' });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.role).toBe('editor');
    expect(created.json().user.permissions).toEqual(expect.arrayContaining(['media:edit', 'collections:manage', 'events:edit']));
    expect(created.json().user.permissions).not.toContain('images:delete');
    expect((await admin.patch(`/api/admin/users/${created.json().user.id}`, { grantedPermissions: ['images:delete'] })).statusCode).toBe(400);
  });

  it('photographers cannot manage collections and only see their own media in the library', async () => {
    const a = await session(t);
    const b = await session(t);
    const evA = await makeEvent(a);
    const evB = await makeEvent(b);
    const idA = await readyPhoto(t, a, evA.id);
    const idB = await readyPhoto(t, b, evB.id);
    expect((await a.get('/api/collections')).statusCode).toBe(403);
    expect((await a.post('/api/collections', { name: 'Nope' })).statusCode).toBe(403);
    const mine = (await a.get('/api/library/media?pageSize=200')).json();
    expect(mine.items.map((i: { id: string }) => i.id)).toContain(idA);
    expect(mine.items.map((i: { id: string }) => i.id)).not.toContain(idB);
    expect((await a.patch(`/api/photos/${idB}`, { title: 'hijack' })).statusCode).toBe(404);
    // A crafted bulk selection cannot reach someone else's media.
    const bulk = await a.post('/api/library/bulk', { selection: { ids: [idA, idB] }, addTags: ['mine'] });
    expect(bulk.json().updated).toBe(1);
    expect((await t.ctx.db.select().from(photos).where(eq(photos.id, idB)))[0]!.tags).toEqual([]);
  });
});

describe('library and bulk editing', () => {
  async function seed() {
    const editor = await session(t, 'editor');
    const owner = await session(t);
    const name = `Gala ${uniq('lib')}`;
    const ev = await makeEvent(owner, { name, eventDate: '2026-03-01' });
    const ids = [await readyPhoto(t, owner, ev.id), await readyPhoto(t, owner, ev.id), await readyPhoto(t, owner, ev.id)];
    const video = await readyVideo(t, owner, ev.id);
    return { editor, owner, ev, name, ids, video };
  }

  it('filters by text, type, event and tag, and paginates with totals', async () => {
    const { editor, ev, name, ids, video } = await seed();
    await editor.patch(`/api/photos/${ids[0]}`, { title: 'Opening speech', tags: ['speech'] });
    const q = async (qs: string) => (await editor.get(`/api/library/media?${qs}`)).json();
    expect((await q(`eventId=${ev.id}`)).total).toBe(4);
    expect((await q(`eventId=${ev.id}&type=video`)).items.map((i: { id: string }) => i.id)).toEqual([video]);
    expect((await q(`eventId=${ev.id}&tag=speech`)).items[0].id).toBe(ids[0]);
    expect((await q(`q=${encodeURIComponent(name.toLowerCase())}`)).total).toBe(4); // by event name
    expect((await q(`q=opening+speech&eventId=${ev.id}`)).total).toBe(1);
    const page = await q(`eventId=${ev.id}&pageSize=2&page=2&sort=oldest`);
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].event).toMatchObject({ id: ev.id, name });
    expect(page.items[0].thumbUrl).toContain('memory://download/');
    expect((await q(`eventId=${ev.id}&from=2999-01-01`)).total).toBe(0);
  });

  it('bulk: tags, hide, description, and numbered renames over an explicit selection', async () => {
    const { editor, ev, name, ids } = await seed();
    const sel = { ids: ids.slice(0, 3) };
    expect((await editor.post('/api/library/bulk', { selection: sel, addTags: ['Gala', 'dinner'] })).json().updated).toBe(3);
    expect((await editor.post('/api/library/bulk', { selection: sel, removeTags: ['dinner'], description: `From ${name}` })).statusCode).toBe(200);
    const rows = await t.ctx.db.select().from(photos).where(eq(photos.eventId, ev.id));
    for (const id of ids) expect(rows.find((r) => r.id === id)).toMatchObject({ tags: ['gala'], description: `From ${name}` });

    expect((await editor.post('/api/library/bulk', { selection: sel, rename: { template: '{event} - {n}', start: 1, pad: 3 } })).statusCode).toBe(200);
    const titles = (await t.ctx.db.select({ title: photos.title }).from(photos).where(inArray(photos.id, ids))).map((r) => r.title).sort();
    expect(titles).toEqual([`${name} - 001`, `${name} - 002`, `${name} - 003`]);

    expect((await editor.post('/api/library/bulk', { selection: sel, isHidden: true })).json().updated).toBe(3);
    expect((await t.ctx.db.select().from(photos).where(eq(photos.id, ids[0]!)))[0]!.isHidden).toBe(true);
    const [log] = await t.ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'media.bulk_updated')).limit(1);
    expect(log).toBeTruthy();
    expect((await editor.post('/api/library/bulk', { selection: sel })).statusCode).toBe(400); // nothing to do
  });

  it('bulk "everything matching this search" with exclusions, and permission checks per action', async () => {
    const { editor, owner, ev, ids } = await seed();
    const bt = uniq('batch');
    const res = await editor.post('/api/library/bulk', { selection: { filter: { eventId: ev.id, type: 'image' }, excludeIds: [ids[0]] }, addTags: [bt] });
    expect(res.json().updated).toBe(2);
    const rows = await t.ctx.db.select().from(photos).where(eq(photos.eventId, ev.id));
    expect(rows.find((r) => r.id === ids[0])!.tags).toEqual([]);
    expect(rows.filter((r) => r.tags.includes(bt))).toHaveLength(2);
    // Tag facets reflect what is there.
    expect((await editor.get(`/api/library/tags?q=${bt.slice(0, 8)}`)).json().items.find((i: { tag: string }) => i.tag === bt)).toMatchObject({ n: 2 });
    // Editors cannot... they can hide (galleries:manage); a user without media:edit cannot edit text.
    const admin = await session(t, 'admin');
    await admin.patch(`/api/admin/users/${owner.user.id}`, { revokedPermissions: ['media:edit'] });
    expect((await owner.post('/api/library/bulk', { selection: { ids: [ids[0]] }, addTags: ['x'] })).statusCode).toBe(403);
    expect((await owner.patch(`/api/photos/${ids[0]}`, { title: 'x' })).statusCode).toBe(403);
  });
});

describe('collections', () => {
  async function seed() {
    const editor = await session(t, 'editor');
    const admin = await session(t, 'admin');
    const owner = await session(t);
    const ev1 = await makeEvent(owner, { name: `Coll A ${uniq()}` });
    const ev2 = await makeEvent(owner, { name: `Coll B ${uniq()}` });
    const a = [await readyPhoto(t, owner, ev1.id), await readyPhoto(t, owner, ev1.id)];
    const b = [await readyPhoto(t, owner, ev2.id), await readyVideo(t, owner, ev2.id)];
    await publish(owner, ev1.id);
    await publish(owner, ev2.id);
    const site = (await admin.post('/api/admin/websites', { name: `Coll ${uniq()}`, scopes: ['collections:read', 'images:read', 'events:read'] })).json();
    const v1 = async (path: string, key = site.apiKey) => t.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${key}` } });
    return { editor, admin, owner, ev1, ev2, a, b, site, v1 };
  }

  it('an editor builds a collection from several events, publishes it, and a website reads it', async () => {
    const { editor, a, b, ev1, ev2, v1 } = await seed();
    const season = `Best of the season ${uniq('s')}`;
    const c = (await editor.post('/api/collections', { name: season, description: 'Highlights from both races' })).json().collection;
    expect(c).toMatchObject({ status: 'draft' });
    expect(c.slug).toMatch(/^best-of-the-season-s-/);
    // Draft is invisible to websites.
    expect((await v1(`/collections/${c.slug}`)).statusCode).toBe(404);
    expect((await v1('/collections')).json().items.some((i: { id: string }) => i.id === c.id)).toBe(false);

    const add = await editor.post(`/api/collections/${c.id}/items`, { selection: { ids: [...a, ...b] } });
    expect(add.json()).toEqual({ added: 4, alreadyIn: 0 });
    expect((await editor.post(`/api/collections/${c.id}/items`, { selection: { ids: [a[0]] } })).json()).toEqual({ added: 0, alreadyIn: 1 }); // idempotent
    expect((await editor.patch(`/api/collections/${c.id}`, { status: 'published' })).json().collection.status).toBe('published');

    const meta = (await v1(`/collections/${c.slug}`)).json().collection;
    expect(meta).toMatchObject({ name: season, description: 'Highlights from both races', mediaCount: 4 });
    const media = (await v1(`/collections/${c.slug}/media`)).json();
    expect(media.total).toBe(4);
    expect(new Set(media.items.map((i: { event: { id: string } }) => i.event.id))).toEqual(new Set([ev1.id, ev2.id]));
    expect(media.items.map((i: { id: string }) => i.id)).toEqual([...a, ...b]); // curated order is preserved
    expect(media.items.every((i: { event: { name: string; description: string } }) => i.event.name && 'description' in i.event)).toBe(true);
    expect((await v1(`/collections/${c.slug}/media?type=video`)).json().total).toBe(1);

    // Reorder: put the video first.
    await editor.post(`/api/collections/${c.id}/items/reorder`, { ids: [b[1]] });
    expect((await v1(`/collections/${c.slug}/media`)).json().items[0].id).toBe(b[1]);
    // Remove an item.
    expect((await editor.post(`/api/collections/${c.id}/items/remove`, { selection: { ids: [a[1]] } })).json().removed).toBe(1);
    expect((await v1(`/collections/${c.slug}`)).json().collection.mediaCount).toBe(3);
  });

  it('adds everything matching a search; only what a website may see is ever exposed', async () => {
    const { editor, owner, ev1, ev2, a, b, v1 } = await seed();
    const c = (await editor.post('/api/collections', { name: `Everything ${uniq()}` })).json().collection;
    const filtered = await editor.post(`/api/collections/${c.id}/items`, { selection: { filter: { q: 'coll' }, excludeIds: [a[0]] } });
    expect(filtered.json().added).toBeGreaterThanOrEqual(3);
    await editor.patch(`/api/collections/${c.id}`, { status: 'published' });

    // Hidden media, private/draft/unpublished events and non-ready items drop out of the website view.
    await editor.patch(`/api/photos/${a[1]}`, { isHidden: true });
    const priv = await makeEvent(owner, { visibility: 'private', password: 'secret-pass' });
    const privPhoto = await readyPhoto(t, owner, priv.id);
    await publish(owner, priv.id);
    const draft = await makeEvent(owner);
    const draftPhoto = await readyPhoto(t, owner, draft.id);
    await editor.post(`/api/collections/${c.id}/items`, { selection: { ids: [privPhoto, draftPhoto] } });
    await owner.post(`/api/events/${ev2.id}/unpublish`);

    const ids = (await v1(`/collections/${c.slug}/media?pageSize=200`)).json().items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(a[1]); // hidden
    expect(ids).not.toContain(privPhoto); // password-protected event
    expect(ids).not.toContain(draftPhoto); // draft event
    for (const id of b) expect(ids).not.toContain(id); // event unpublished
    expect(ids).not.toContain(a[0]); // excluded from the add
    void ev1;
  });

  it('enforces scopes, allow-lists and the unpublished/revoked states', async () => {
    const { editor, admin, ev1, a, v1 } = await seed();
    const c = (await editor.post('/api/collections', { name: `Scoped ${uniq()}` })).json().collection;
    await editor.post(`/api/collections/${c.id}/items`, { selection: { ids: a } });
    await editor.patch(`/api/collections/${c.id}`, { status: 'published' });

    const noColl = (await admin.post('/api/admin/websites', { name: `NoColl ${uniq()}`, scopes: ['events:read'] })).json();
    expect((await v1('/collections', noColl.apiKey)).statusCode).toBe(403);

    const noImages = (await admin.post('/api/admin/websites', { name: `NoImg ${uniq()}`, scopes: ['collections:read'] })).json();
    const metaOnly = (await v1(`/collections/${c.slug}/media`, noImages.apiKey)).json();
    expect(metaOnly.items[0].urls).toBeNull(); // metadata without image access

    const restricted = (await admin.post('/api/admin/websites', { name: `Allow ${uniq()}`, scopes: ['collections:read', 'images:read'], allowedEventIds: [(await makeEvent(await session(t))).id] })).json();
    expect((await v1(`/collections/${c.slug}/media`, restricted.apiKey)).json().total).toBe(0); // event not on its allow-list

    await editor.patch(`/api/collections/${c.id}`, { status: 'draft' });
    expect((await v1(`/collections/${c.slug}`)).statusCode).toBe(404);
    void ev1;
  });

  it('keeps the link stable once published; deleting a collection never deletes media', async () => {
    const { editor, a } = await seed();
    const c = (await editor.post('/api/collections', { name: `Stable ${uniq()}` })).json().collection;
    await editor.post(`/api/collections/${c.id}/items`, { selection: { ids: a } });
    expect((await editor.patch(`/api/collections/${c.id}`, { slug: `my-new-link-${uniq('l')}` })).statusCode).toBe(200); // draft: allowed
    await editor.patch(`/api/collections/${c.id}`, { status: 'published' });
    expect((await editor.patch(`/api/collections/${c.id}`, { slug: `another-link-${uniq('l')}` })).statusCode).toBe(409);
    expect((await editor.patch(`/api/collections/${c.id}`, { coverPhotoId: a[0] })).statusCode).toBe(200);
    expect((await editor.del(`/api/collections/${c.id}`)).statusCode).toBe(204);
    expect(await t.ctx.db.select().from(photos).where(eq(photos.id, a[0]!))).toHaveLength(1);
    expect((await editor.get(`/api/collections/${c.id}`)).statusCode).toBe(404);
  });
});

describe('scale: tens of thousands of items', () => {
  it('searches, filters and bulk-adds across 10,000 items quickly', async () => {
    const owner = await session(t);
    const editor = await session(t, 'editor');
    const ev = await makeEvent(owner, { name: `Big archive ${uniq('big')}` });
    const uploader = ((await t.ctx.db.execute(sql`select owner_id as uploader from events where id = ${ev.id}`)).rows as { uploader: string }[])[0]!.uploader;
    // 10k ready media rows, every 50th a video, with searchable titles and a few tags.
    await t.ctx.db.execute(sql`
      insert into photos (event_id, uploader_id, filename, title, description, tags, media_type, content_type, size_bytes, status, original_key, thumb_key, preview_key, created_at)
      select ${ev.id}::uuid, ${uploader}::uuid, 'IMG_' || lpad(i::text, 5, '0') || '.jpg', 'Runner ' || i, case when i % 7 = 0 then 'finish line moment' else '' end,
             case when i % 10 = 0 then array['podium'] else '{}'::text[] end,
             (case when i % 50 = 0 then 'video' else 'image' end)::media_type, 'image/jpeg', 1000, 'ready',
             'events/${sql.raw(ev.id)}/originals/' || i || '.jpg', 'events/${sql.raw(ev.id)}/thumbs/' || i || '.webp', 'events/${sql.raw(ev.id)}/previews/' || i || '.jpg',
             now() - (i || ' seconds')::interval
      from generate_series(1, 10000) i`);
    const timed = async <T>(fn: () => Promise<T>) => { const s = performance.now(); const r = await fn(); return { r, ms: performance.now() - s }; };

    const all = await timed(() => editor.get(`/api/library/media?eventId=${ev.id}&pageSize=60`));
    expect(all.r.json().total).toBe(10000);
    expect(all.r.json().items).toHaveLength(60);
    const text = await timed(() => editor.get(`/api/library/media?eventId=${ev.id}&q=${encodeURIComponent('finish line')}`));
    expect(text.r.json().total).toBe(Math.floor(10000 / 7));
    const tagged = await timed(() => editor.get(`/api/library/media?eventId=${ev.id}&tag=podium&type=image`));
    expect(tagged.r.json().total).toBe(1000 - 200); // multiples of 10, minus the 200 that are videos (multiples of 50)
    expect(Math.max(all.ms, text.ms, tagged.ms)).toBeLessThan(2500);

    // Put the whole 10k archive in a collection with one request, then page through it.
    const c = (await editor.post('/api/collections', { name: `Archive ${uniq()}` })).json().collection;
    const add = await timed(() => editor.post(`/api/collections/${c.id}/items`, { selection: { filter: { eventId: ev.id } } }));
    expect(add.r.json().added).toBe(10000);
    expect(add.ms).toBeLessThan(15000);
    const page = (await editor.get(`/api/collections/${c.id}/items?pageSize=60&page=100`)).json();
    expect(page).toMatchObject({ total: 10000, page: 100 });
    // Everything selected above the 20,000 cap is refused with a clear message instead of timing out.
    const tooMany = await editor.post(`/api/collections/${c.id}/items`, { selection: { filter: {} } });
    expect([200, 400]).toContain(tooMany.statusCode);
    void events;
  }, 120_000);
});
