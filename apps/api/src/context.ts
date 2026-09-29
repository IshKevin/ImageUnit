import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Storage } from './lib/storage.js';

export const QUEUES = { photos: 'process-photo', maintenance: 'maintenance' } as const;

export interface JobQueues {
  photos: Pick<Queue, 'add' | 'getJobCounts'>;
  maintenance: Pick<Queue, 'add' | 'getJobCounts' | 'upsertJobScheduler'>;
}

export interface AppContext {
  config: Config;
  db: Db;
  storage: Storage;
  redis: Redis | null;
  queues: JobQueues;
  log: Logger;
}
