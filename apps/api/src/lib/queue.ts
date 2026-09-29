import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, type JobQueues } from '../context.js';

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createQueues(connection: Redis): JobQueues {
  return {
    photos: new Queue(QUEUES.photos, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    maintenance: new Queue(QUEUES.maintenance, { connection }),
  };
}

export const photoJobId = (photoId: string, run: number) => `${photoId}-${run}`;
