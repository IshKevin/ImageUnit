import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://imageunit:imageunit@localhost:5440/imageunit_test';

export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_DB_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const name = new URL(TEST_DB_URL).pathname.slice(1);
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!rowCount) await admin.query(`create database "${name}"`);
  await admin.end();
  await runMigrations(TEST_DB_URL);
}
