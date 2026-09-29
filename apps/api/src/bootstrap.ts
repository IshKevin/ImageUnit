import { pino } from 'pino';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db/client.js';
import { createQueues, createRedis } from './lib/queue.js';
import { createS3Storage } from './lib/storage.js';

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
  });
}

export async function createContext() {
  const config = loadConfig();
  const log = createLogger(config);
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const storage = createS3Storage(config);
  await storage.ensureReady();
  const ctx: AppContext = { config, db, storage, redis, queues: createQueues(redis), log };
  return { ctx, pool, redis };
}
