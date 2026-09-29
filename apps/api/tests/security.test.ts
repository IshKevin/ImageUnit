import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, photos } from '../src/db/schema.js';
import { createTestApp, login, makeEvent, makeUser, PASSWORD, readyPhoto, session, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

describe('authentication', () => {
  it('logs in, rejects wrong passwords, and never reveals which emails exist', async () => {
    const u = await makeUser(t);
    expect((await login(t, u.email)).res.statusCode).toBe(200);
    const wrong = await login(t, u.email, 'nope-nope-nope');
    const unknown = await login(t, 'ghost@test.dev', 'nope-nope-nope');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.json().error.message).toBe(unknown.res.json().error.message);
  });

  it('locks an account after repeated failures', async () => {
    const u = await makeUser(t);
    for (let i = 0; i < 5; i++) await login(t, u.email, 'bad-password-x');
    const res = await login(t, u.email, PASSWORD);
    expect(res.res.statusCode).toBe(429);
  });

  it('a suspended user cannot log in and live sessions stop working immediately', async () => {
    const admin = await session(t, 'admin');
    const victim = await session(t, 'photographer');
    expect((await victim.get('/api/events')).statusCode).toBe(200);

    const res = await admin.post(`/api/admin/users/${victim.user.id}/status`, { status: 'suspended' });
    expect(res.statusCode).toBe(200);

    expect((await victim.get('/api/events')).statusCode).toBe(401);
    expect((await login(t, victim.user.email)).res.statusCode).toBe(403);

    await admin.post(`/api/admin/users/${victim.user.id}/status`, { status: 'active' });
    expect((await login(t, victim.user.email)).res.statusCode).toBe(200);
  });

  it('rejects unauthenticated access and cross-origin state changes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
    const p = await session(t);
    const res = await t.app.inject({ method: 'POST', url: '/api/events', payload: { name: 'x y' }, headers: { cookie: p.cookie, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('authorisation', () => {
  it('photographers cannot reach admin functions', async () => {
    const p = await session(t);
    for (const url of ['/api/admin/users', '/api/admin/stats', '/api/admin/audit', '/api/admin/websites', '/api/admin/storage', '/api/admin/settings']) {
      expect((await p.get(url)).statusCode, url).toBe(403);
    }
    expect((await p.post('/api/admin/users', { email: 'a@b.co', name: 'A', role: 'admin' })).statusCode).toBe(403);
  });

  it('a photographer cannot see or modify another photographer\'s event', async () => {
    const a = await session(t);
    const b = await session(t);
    const ev = await makeEvent(a);
    expect((await b.get(`/api/events/${ev.id}`)).statusCode).toBe(404);
    expect((await b.patch(`/api/events/${ev.id}`, { name: 'hijacked' })).statusCode).toBe(404);
    expect((await b.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] })).statusCode).toBe(404);
    const list = (await b.get('/api/events')).json();
    expect(list.items.find((e: { id: string }) => e.id === ev.id)).toBeUndefined();
  });

  it('critical permissions can never be granted to a photographer', async () => {
    const admin = await session(t, 'admin');
    const p = await makeUser(t);
    const res = await admin.patch(`/api/admin/users/${p.id}`, { grantedPermissions: ['images:delete'] });
    expect(res.statusCode).toBe(400);
    const ok = await admin.patch(`/api/admin/users/${p.id}`, { revokedPermissions: ['events:create'] });
    expect(ok.statusCode).toBe(200);
    const s = await login(t, p.email);
    const create = await t.app.inject({ method: 'POST', url: '/api/events', payload: { name: 'blocked' }, headers: { cookie: s.cookie } });
    expect(create.statusCode).toBe(403);
  });

  it('protects the last administrator', async () => {
    await t.ctx.db.execute(sql`update users set status = 'inactive' where role = 'admin'`);
    const admin = await session(t, 'admin');
    expect((await admin.post(`/api/admin/users/${admin.user.id}/status`, { status: 'suspended' })).statusCode).toBe(400);
    const other = await makeUser(t, 'admin');
    expect((await admin.post(`/api/admin/users/${other.id}/status`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await admin.patch(`/api/admin/users/${admin.user.id}`, { role: 'photographer' })).statusCode).toBe(400);
  });
});

describe('deletion rules and audit', () => {
  it('photographers cannot permanently delete photographs; administrators can, and it is audited', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner);
    const photoId = await readyPhoto(t, owner, ev.id);

    expect((await owner.del(`/api/photos/${photoId}`)).statusCode).toBe(403);
    expect((await owner.post(`/api/events/${ev.id}/photos/delete`, { photoIds: [photoId] })).statusCode).toBe(403);
    expect(await t.ctx.db.select().from(photos).where(eq(photos.id, photoId))).toHaveLength(1);

    const [row] = await t.ctx.db.select().from(photos).where(eq(photos.id, photoId));
    expect(t.storage.objects.has(row!.originalKey)).toBe(true);

    expect((await admin.del(`/api/photos/${photoId}`)).statusCode).toBe(204);
    expect(await t.ctx.db.select().from(photos).where(eq(photos.id, photoId))).toHaveLength(0);
    expect(t.storage.objects.has(row!.originalKey)).toBe(false);

    const [log] = await t.ctx.db.select().from(auditLogs).where(eq(auditLogs.entityId, photoId));
    expect(log).toMatchObject({ action: 'photo.deleted', actorId: admin.user.id, eventId: ev.id });
  });

  it('events must be archived before deletion, and only admins may delete', async () => {
    const owner = await session(t);
    const admin = await session(t, 'admin');
    const ev = await makeEvent(owner);
    expect((await owner.del(`/api/events/${ev.id}?confirm=${ev.slug}`)).statusCode).toBe(403);
    expect((await owner.post(`/api/events/${ev.id}/archive`)).statusCode).toBe(403);
    expect((await admin.del(`/api/events/${ev.id}?confirm=${ev.slug}`)).statusCode).toBe(409);
    expect((await admin.post(`/api/events/${ev.id}/archive`)).statusCode).toBe(200);
    expect((await admin.del(`/api/events/${ev.id}?confirm=wrong`)).statusCode).toBe(400);
    expect((await admin.del(`/api/events/${ev.id}?confirm=${ev.slug}`)).statusCode).toBe(204);
  });

  it('audit records are append-only, even for the database owner', async () => {
    const [row] = await t.ctx.db.select().from(auditLogs).limit(1);
    await expect(t.ctx.db.update(auditLogs).set({ action: 'tampered' }).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
    await expect(t.ctx.db.delete(auditLogs).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
  });

  it('sensitive administrative actions are logged, with before/after and no secrets', async () => {
    const admin = await session(t, 'admin');
    const created = await admin.post('/api/admin/users', { email: `${Date.now()}@log.dev`, name: 'Logged' });
    const { user } = created.json();
    await admin.patch(`/api/admin/users/${user.id}`, { grantedPermissions: [] , revokedPermissions: ['stats:view'] });
    await admin.post(`/api/admin/users/${user.id}/status`, { status: 'suspended' });
    const logs = await t.ctx.db.select().from(auditLogs).where(eq(auditLogs.targetUserId, user.id));
    expect(logs.map((l) => l.action).sort()).toEqual(['user.created', 'user.permissions_changed', 'user.suspended']);
    expect(JSON.stringify(logs)).not.toMatch(/argon2|passwordHash/);
  });
});
