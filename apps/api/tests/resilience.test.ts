import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { TEST_DB_URL } from './global-setup.js';

describe('resilience', () => {
  it('survives an idle database connection being dropped instead of crashing the process', async () => {
    const seen: string[] = [];
    const { db, pool } = createDb(TEST_DB_URL, (e) => seen.push(e.message));
    await pool.query('select 1');
    // Simulates the server terminating an idle client (e.g. Postgres restart).
    const client = await pool.connect();
    client.release();
    pool.emit('error', new Error('terminating connection due to administrator command'));
    expect(seen).toEqual(['terminating connection due to administrator command']);
    // The pool remains usable.
    expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1);
    void db;
    await pool.end();
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', S3_BUCKET: 'b', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 's', SESSION_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;

  it('treats empty optional variables (as injected by compose/Coolify) as unset', async () => {
    const { loadConfig } = await import('../src/config.js');
    const c = loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: '', BOOTSTRAP_ADMIN_PASSWORD: '', METRICS_TOKEN: '', S3_ENDPOINT: '' });
    expect(c.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(c.METRICS_TOKEN).toBeUndefined();
  });

  it('refuses insecure production settings', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', SESSION_SECRET: 'change-me-to-64-random-hex-chars-change-me-to-64' })).toThrow(/placeholder/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' }).NODE_ENV).toBe('production');
  });
});
