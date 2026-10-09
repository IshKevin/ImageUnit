import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { apiClients, type ApiClient } from '../db/schema.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { hashApiKey, type Scope } from './api-keys.js';
import type { UsageRecorder } from './usage.js';

const memoryWindows = new Map<string, number>();

export function createWebsiteAuthenticator(ctx: AppContext, usage: UsageRecorder) {
  async function rateLimit(client: ApiClient) {
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:client:${client.id}:${window}`;
    let hits: number;
    if (ctx.redis) {
      hits = await ctx.redis.incr(key);
      if (hits === 1) await ctx.redis.expire(key, 90);
    } else {
      hits = (memoryWindows.get(key) ?? 0) + 1;
      memoryWindows.set(key, hits);
    }
    if (hits > client.rateLimitPerMinute) throw new AppError(429, 'rate_limited', 'Rate limit exceeded');
  }

  function checkOrigin(client: ApiClient, req: FastifyRequest) {
    const origin = req.headers.origin;
    if (origin && client.allowedOrigins.length > 0 && !client.allowedOrigins.includes(origin)) {
      throw forbidden('Origin not allowed for this credential');
    }
  }

  return {
    rateLimit,
    authenticate: (scope: Scope) => async (req: FastifyRequest) => {
      const header = req.headers.authorization;
      const apiKeyHeader = req.headers['x-api-key'];
      const raw = header?.startsWith('Bearer ')
        ? header.slice(7).trim()
        : typeof apiKeyHeader === 'string'
          ? apiKeyHeader
          : undefined;
      if (!raw) throw unauthorized('API key required');
      const [client] = await ctx.db.select().from(apiClients).where(eq(apiClients.keyHash, hashApiKey(raw)));
      if (!client) throw unauthorized('Invalid API key');
      if (client.status !== 'active') throw forbidden(`This credential is ${client.status}`);
      if (!client.scopes.includes(scope)) throw forbidden(`Missing scope: ${scope}`);
      checkOrigin(client, req);
      await rateLimit(client);
      req.apiClient = client;
      usage.record(client.id);
    },
  };
}
