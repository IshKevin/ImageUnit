import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  await pool.end();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  console.log('migrations applied');
}
