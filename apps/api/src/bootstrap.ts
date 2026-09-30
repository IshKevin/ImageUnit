import { pino } from 'pino';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db/client.js';
import { createQueues, createRedis } from './lib/queue.js';
import { retry } from './lib/retry.js';
import { createS3Storage } from './lib/storage.js';

/** Human-readable logs only for an interactive dev terminal where the (dev-only) pino-pretty package is installed. */
function canPrettyPrint(config: Config) {
  if (config.NODE_ENV !== 'development' || !process.stdout.isTTY) return false;
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(canPrettyPrint(config) && { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
  });
}

export async function createContext() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    // A short, readable message in the container logs instead of a stack trace.
    console.error(`\nImageUnit cannot start: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const log = createLogger(config);
  const { db, pool } = createDb(config.DATABASE_URL, (err) => log.error({ err }, 'postgres pool error'));
  const redis = createRedis(config.REDIS_URL);
  redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));
  const storage = createS3Storage(config);
  await retry('object storage', () => storage.ensureReady(), { log: (m) => log.warn(m) });
  const ctx: AppContext = { config, db, storage, redis, queues: createQueues(redis), log };
  return { ctx, pool, redis };
}
