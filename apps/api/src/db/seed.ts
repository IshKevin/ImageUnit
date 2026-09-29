import { sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { createContext } from '../bootstrap.js';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { users } from './schema.js';

/** Creates the first administrator from the environment when no admin exists yet. */
export async function ensureBootstrapAdmin(ctx: Pick<AppContext, 'db' | 'config' | 'log'>) {
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = ctx.config;
  const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(sql`role = 'admin'`);
  if (n > 0) return;
  if (!email || !password) {
    ctx.log.warn('No administrator exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to create one.');
    return;
  }
  const [admin] = await ctx.db.insert(users).values({ email: email.toLowerCase(), name: 'Administrator', role: 'admin', passwordHash: await hashPassword(password) }).returning();
  await audit(ctx.db, SYSTEM_ACTOR, { action: 'user.created', entityType: 'user', entityId: admin!.id, targetUserId: admin!.id, meta: { bootstrap: true } });
  ctx.log.info({ email }, 'bootstrap administrator created');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { ctx, pool, redis } = await createContext();
  await ensureBootstrapAdmin(ctx);
  await Promise.allSettled([pool.end(), redis.quit()]);
}
