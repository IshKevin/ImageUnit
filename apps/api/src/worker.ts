import { UnrecoverableError, Worker } from 'bullmq';
import { createServer } from 'node:http';
import { sql } from 'drizzle-orm';
import { createContext } from './bootstrap.js';
import { QUEUES } from './context.js';
import { runMaintenance } from './jobs/maintenance.js';
import { markFailed, PermanentProcessingError, processPhoto } from './jobs/process-photo.js';
import { eq } from 'drizzle-orm';
import { photos } from './db/schema.js';
import type { ProcessPhotoJob } from './lib/jobs.js';

const { ctx, pool, redis } = await createContext();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);

const photoWorker = new Worker<ProcessPhotoJob>(
  QUEUES.photos,
  async (job) => {
    try {
      await processPhoto(ctx, job.data.photoId);
    } catch (err) {
      if (err instanceof PermanentProcessingError) {
        // Nothing to retry: record the reason. The original stays in storage.
        await markFailed(ctx, job.data.photoId, err.message);
        throw new UnrecoverableError(err.message);
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) await markFailed(ctx, job.data.photoId, `Processing failed: ${(err as Error).message}`);
      else await ctx.db.update(photos).set({ status: 'uploaded' }).where(eq(photos.id, job.data.photoId));
      throw err;
    }
  },
  { connection: redis, concurrency },
);
photoWorker.on('failed', (job, err) => ctx.log.warn({ photoId: job?.data.photoId, err: err.message, attempt: job?.attemptsMade }, 'photo job failed'));
photoWorker.on('completed', (job) => ctx.log.debug({ photoId: job.data.photoId }, 'photo processed'));

const maintenanceWorker = new Worker(QUEUES.maintenance, async () => runMaintenance(ctx), { connection: redis, concurrency: 1 });
await ctx.queues.maintenance.upsertJobScheduler('tick', { every: 60_000 }, { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 50 } });

// Health endpoint for container orchestrators: 200 only while Redis and Postgres are reachable.
const healthServer = createServer(async (req, res) => {
  if (req.url !== '/health') return void res.writeHead(404).end();
  const [redisOk, dbOk] = await Promise.all([redis.ping().then(() => true, () => false), ctx.db.execute(sql`select 1`).then(() => true, () => false)]);
  res.writeHead(redisOk && dbOk ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: redisOk && dbOk ? 'ok' : 'unavailable', redis: redisOk, db: dbOk }));
});
healthServer.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4002), '0.0.0.0');

ctx.log.info({ concurrency }, 'worker started');

const shutdown = async (signal: string) => {
  ctx.log.info({ signal }, 'worker shutting down');
  healthServer.close();
  await Promise.allSettled([photoWorker.close(), maintenanceWorker.close()]);
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
