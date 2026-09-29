import { buildApp } from './app.js';
import { createContext } from './bootstrap.js';
import { ensureBootstrapAdmin } from './db/seed.js';
import { runMigrations } from './db/migrate.js';

const { ctx, pool, redis } = await createContext();
await runMigrations(ctx.config.DATABASE_URL);
await ensureBootstrapAdmin(ctx);

const app = await buildApp(ctx);
await app.listen({ port: ctx.config.PORT, host: '0.0.0.0' });

const shutdown = async (signal: string) => {
  ctx.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
