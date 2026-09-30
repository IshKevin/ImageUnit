import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';

/**
 * Validates an env file (KEY=value lines, e.g. your Coolify variables) with exactly the rules the API applies at startup.
 *   npm run check-env -- path/to/env-file
 */
const file = process.argv[2];
if (!file) {
  console.error('usage: npm run check-env -- <env-file>');
  process.exit(2);
}

const parsed: Record<string, string> = {};
for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) {
    console.warn(`  ignoring line without KEY=value: ${line.slice(0, 40)}`);
    continue;
  }
  let value = line.slice(i + 1).trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  parsed[line.slice(0, i).trim()] = value;
}

// What compose.yaml supplies itself, so it need not be in your file.
const env = {
  DATABASE_URL: 'postgres://imageunit:x@postgres:5432/imageunit',
  REDIS_URL: 'redis://:x@redis:6379',
  S3_ENDPOINT: 'http://s3:8333',
  S3_BUCKET: 'imageunit-media',
  S3_ACCESS_KEY: 'imageunit',
  S3_SECRET_KEY: 'imageunit-secret',
  S3_FORCE_PATH_STYLE: 'true',
  ...parsed,
} as NodeJS.ProcessEnv;

try {
  const c = loadConfig(env);
  console.log(`OK — the API would start. mode=${c.NODE_ENV} web=${c.PUBLIC_WEB_URL} secureCookies=${c.COOKIE_SECURE} trustProxy=${c.TRUST_PROXY}`);
  if (c.NODE_ENV !== 'production') console.log('  note: NODE_ENV is not "production"');
  if (!parsed.POSTGRES_PASSWORD || !parsed.REDIS_PASSWORD) console.log('  note: POSTGRES_PASSWORD / REDIS_PASSWORD not set: the insecure default "imageunit" would be used');
  if (!parsed.SESSION_SECRET) console.log('  PROBLEM: SESSION_SECRET is not set (compose refuses to start without it)');
} catch (err) {
  console.error(`\nProblem — the API would refuse to start:\n${(err as Error).message}\n`);
  process.exit(1);
}
