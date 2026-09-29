import { and, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sessions, users } from '../db/schema.js';
import { makeGuards, SESSION_COOKIE, SESSION_TTL_MS } from '../http/guards.js';
import { parse } from '../http/validate.js';
import { audit, actorFromRequest } from '../lib/audit.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { userDto } from './dto.js';

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
// Verified against when the account does not exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Use upper-case, lower-case and a number');

export const authRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const guard = makeGuards(ctx);

  app.post('/auth/login', { config: { rateLimit: { max: ctx.config.LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const [user] = await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await verifyPassword(DUMMY_HASH, body.password);
      throw new AppError(429, 'account_locked', 'Too many failed attempts. Try again later.');
    }

    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !valid) {
      if (user) {
        const failed = user.failedLogins + 1;
        await ctx.db
          .update(users)
          .set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null })
          .where(eq(users.id, user.id));
        if (failed === MAX_FAILED) {
          await audit(ctx.db, { type: 'system', label: 'auth', ip: req.ip }, { action: 'auth.account_locked', entityType: 'user', entityId: user.id, targetUserId: user.id });
        }
      }
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== 'active') throw forbidden(`This account is ${user.status}. Contact an administrator.`);

    const token = randomToken(32);
    await ctx.db.transaction(async (tx) => {
      await tx.insert(sessions).values({
        userId: user.id,
        tokenHash: sha256(token),
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 300),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      });
      await tx.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.COOKIE_SECURE,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { user: userDto(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: guard.user }, async (req) => ({ user: userDto(req.user!) }));

  app.post('/auth/change-password', { preHandler: guard.user }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
    const u = req.user!;
    if (!(await verifyPassword(u.passwordHash, body.currentPassword))) throw badRequest('Current password is incorrect');
    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, u.id));
      // Sign out every other device.
      await tx.delete(sessions).where(and(eq(sessions.userId, u.id), ne(sessions.id, req.sessionId!)));
      await audit(tx, actorFromRequest(req), { action: 'user.password_changed', entityType: 'user', entityId: u.id, targetUserId: u.id });
    });
    return { ok: true };
  });
};

