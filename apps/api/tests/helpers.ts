import sharp from 'sharp';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import { createLogger } from '../src/bootstrap.js';
import { createMemoryStorage } from '../src/lib/storage.js';
import { TEST_DB_URL } from './global-setup.js';

export const PASSWORD = 'Sup3rSecret!pass';
let counter = 0;
export const uniq = (p = 'x') => `${p}-${Date.now().toString(36)}-${counter++}`;

export async function createTestApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    REDIS_URL: 'redis://unused',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    LOG_LEVEL: 'silent',
    LOGIN_RATE_LIMIT: '100000',
  } as NodeJS.ProcessEnv);
  const { db, pool } = createDb(config.DATABASE_URL);
  const storage = createMemoryStorage();
  const added: { name: string; data: unknown }[] = [];
  const ctx: AppContext = {
    config,
    db,
    storage,
    redis: null,
    log: createLogger(config),
    queues: {
      photos: { add: vi.fn(async (name: string, data: unknown) => void added.push({ name, data })) as never, getJobCounts: (async () => ({})) as never },
      maintenance: { add: vi.fn() as never, getJobCounts: (async () => ({})) as never, upsertJobScheduler: vi.fn() as never },
    },
  };
  const app = await buildApp(ctx, { rateLimitMax: 100000 });
  await app.ready();
  return { app, ctx, storage, added, close: async () => { await app.close(); await pool.end(); } };
}
export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export async function makeUser(t: TestApp, role: 'admin' | 'photographer' = 'photographer', extra: Partial<typeof users.$inferInsert> = {}) {
  const email = `${uniq(role)}@test.dev`;
  const [u] = await t.ctx.db.insert(users).values({ email, name: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD), ...extra }).returning();
  return { ...u!, password: PASSWORD };
}

export async function login(t: TestApp, email: string, password = PASSWORD) {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === 'iu_session');
  return { res, cookie: cookie ? `iu_session=${cookie.value}` : '' };
}

export async function session(t: TestApp, role: 'admin' | 'photographer' = 'photographer', extra: Partial<typeof users.$inferInsert> = {}) {
  const user = await makeUser(t, role, extra);
  const { cookie } = await login(t, user.email);
  const call = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as never, url, payload: payload as never, headers: { cookie } });
  return { user, cookie, call, get: (u: string) => call('GET', u), post: (u: string, p?: unknown) => call('POST', u, p ?? {}), patch: (u: string, p: unknown) => call('PATCH', u, p), del: (u: string) => call('DELETE', u) };
}
export type Session = Awaited<ReturnType<typeof session>>;

export const testImage = (w = 800, h = 600) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg().toBuffer();

/** Runs the full upload pipeline for one image and returns the ready photo id. */
export async function uploadPhoto(t: TestApp, s: Session, eventId: string, opts: { data?: Buffer; filename?: string; contentType?: string } = {}) {
  const data = opts.data ?? (await testImage());
  const contentType = opts.contentType ?? 'image/jpeg';
  const init = await s.post(`/api/events/${eventId}/uploads`, { files: [{ filename: opts.filename ?? 'IMG_0001.jpg', contentType, sizeBytes: data.length }] });
  const { uploads } = init.json();
  const { photoId } = uploads[0];
  const key = decodeURIComponent(uploads[0].uploadUrl.replace('memory://upload/', ''));
  t.storage.objects.set(key, { body: data, contentType });
  const done = await s.post(`/api/events/${eventId}/uploads/complete`, { photoIds: [photoId] });
  return { photoId, key, init, done };
}

export async function readyPhoto(t: TestApp, s: Session, eventId: string) {
  const { processPhoto } = await import('../src/jobs/process-photo.js');
  const up = await uploadPhoto(t, s, eventId);
  await processPhoto(t.ctx, up.photoId);
  return up.photoId;
}

export async function makeEvent(s: Session, body: Record<string, unknown> = {}) {
  const res = await s.post('/api/events', { name: `Event ${uniq()}`, ...body });
  return res.json().event as { id: string; slug: string; status: string };
}
