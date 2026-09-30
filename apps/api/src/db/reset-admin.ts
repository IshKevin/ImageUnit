import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { createDb } from './client.js';
import { sessions, users } from './schema.js';

/**
 * Break-glass administrator access. Creates the administrator if missing, otherwise resets the password,
 * re-activates the account, clears lockouts and signs out every session. Run on the server:
 *   node dist/db/reset-admin.js <email> [new-password]
 * Without a password a strong random one is generated and printed once.
 */
const [emailArg, passwordArg] = process.argv.slice(2);
if (!emailArg || !/^\S+@\S+\.\S+$/.test(emailArg)) {
  console.error('usage: node dist/db/reset-admin.js <email> [new-password]');
  process.exit(2);
}
if (passwordArg && (passwordArg.length < 12 || !/[a-z]/.test(passwordArg) || !/[A-Z]/.test(passwordArg) || !/\d/.test(passwordArg))) {
  console.error('Password must be at least 12 characters with upper-case, lower-case and a number.');
  process.exit(2);
}

const email = emailArg.toLowerCase();
const password = passwordArg ?? `${randomBytes(12).toString('base64url')}aA1!`;
const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing) {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, role: 'admin', status: 'active', failedLogins: 0, lockedUntil: null }).where(eq(users.id, existing.id));
      await tx.delete(sessions).where(eq(sessions.userId, existing.id));
      await audit(tx, SYSTEM_ACTOR, { action: 'user.admin_recovered', entityType: 'user', entityId: existing.id, targetUserId: existing.id, meta: { via: 'cli', previousRole: existing.role, previousStatus: existing.status } });
    });
    console.log(`Updated administrator ${email}`);
  } else {
    await db.transaction(async (tx) => {
      const [created] = await tx.insert(users).values({ email, name: 'Administrator', role: 'admin', passwordHash }).returning();
      await audit(tx, SYSTEM_ACTOR, { action: 'user.created', entityType: 'user', entityId: created!.id, targetUserId: created!.id, meta: { via: 'cli' } });
    });
    console.log(`Created administrator ${email}`);
  }
  console.log(`\n  Email:    ${email}\n  Password: ${password}\n\nSign in, then change the password. This is shown only once.`);
} finally {
  await pool.end();
}
