import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { checkStorage } from '../src/jobs/maintenance.js';
import { notifications, photos } from '../src/db/schema.js';
import { publicStorageProblem } from '../src/lib/storage-config.js';
import { createTestApp, makeEvent, session, uniq, type TestApp } from './helpers.js';

const prod = { NODE_ENV: 'production', COOKIE_SECURE: 'true', PUBLIC_WEB_URL: 'https://gallery.afs-rwanda.org' };
const apps: TestApp[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

describe('publicStorageProblem', () => {
  const cfg = (o: Record<string, string | undefined>) => ({ NODE_ENV: 'production' as const, PUBLIC_WEB_URL: 'https://gallery.afs-rwanda.org', S3_ENDPOINT: 'http://s3:8333', S3_PUBLIC_ENDPOINT: undefined as string | undefined, ...o }) as Parameters<typeof publicStorageProblem>[0];

  it('accepts a real https domain and ignores development', () => {
    expect(publicStorageProblem(cfg({ S3_PUBLIC_ENDPOINT: 'https://media.afs-rwanda.org' }))).toBeNull();
    expect(publicStorageProblem(cfg({ NODE_ENV: 'development' as never, S3_PUBLIC_ENDPOINT: 'http://localhost:8333' }))).toBeNull();
  });
  it('rejects local/internal addresses and mixed content in production', () => {
    for (const bad of ['http://localhost:8333', 'http://127.0.0.1:8333', 'http://s3:8333', 'http://0.0.0.0:8333']) {
      expect(publicStorageProblem(cfg({ S3_PUBLIC_ENDPOINT: bad })), bad).toContain('only works on the server itself');
    }
    expect(publicStorageProblem(cfg({ S3_PUBLIC_ENDPOINT: 'http://media.afs-rwanda.org' }))).toContain('https');
    expect(publicStorageProblem(cfg({ S3_PUBLIC_ENDPOINT: undefined }))).toContain('only works on the server itself'); // falls back to the internal address
  });
});

describe('uploads with an unusable storage address', () => {
  it('are refused up front with a clear message, and create nothing', async () => {
    const t = await createTestApp({ ...prod, S3_PUBLIC_ENDPOINT: 'http://localhost:8333' });
    apps.push(t);
    const owner = await session(t);
    const ev = await makeEvent(owner);
    const res = await owner.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 1000 }] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('storage_not_configured');
    expect(res.json().error.message).toContain('administrator');
    expect(await t.ctx.db.select().from(photos).where(eq(photos.eventId, ev.id))).toHaveLength(0); // no orphan records

    // Administrators are told once a day, in the console.
    await checkStorage(t.ctx);
    await checkStorage(t.ctx);
    const notes = await t.ctx.db.select().from(notifications).where(sql`${notifications.type} = 'storage.misconfigured' and ${notifications.userId} is null`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: 'critical' });
  });

  it('work normally once a public address is set', async () => {
    const t = await createTestApp({ ...prod, S3_PUBLIC_ENDPOINT: 'https://media.afs-rwanda.org' });
    apps.push(t);
    const owner = await session(t);
    const ev = await makeEvent(owner, { name: `Storage ok ${uniq()}` });
    const res = await owner.post(`/api/events/${ev.id}/uploads`, { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 1000 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().uploads).toHaveLength(1);
  });
});
