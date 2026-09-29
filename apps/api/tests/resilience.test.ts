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
