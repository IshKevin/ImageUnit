import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDb(connectionString: string, onError: (err: Error) => void = (err) => console.error('postgres pool error', err.message)) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  // An idle connection dropped by the server (restart, failover) emits 'error' on the pool. Without a listener
  // Node treats it as fatal and the whole process dies; with one, the pool discards the client and reconnects on demand.
  pool.on('error', onError);
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export { schema };
