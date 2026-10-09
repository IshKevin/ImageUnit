import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import client from 'prom-client';
import { sql } from 'drizzle-orm';
import type { AppContext } from './context.js';
import './http/types.js';
import { AppError } from './lib/errors.js';
import { UsageRecorder } from './lib/usage.js';
import { adminRoutes } from './modules/admin.js';
import { authRoutes } from './modules/auth.js';
import { clientRoutes } from './modules/clients.js';
import { collectionRoutes } from './modules/collections.js';
import { libraryRoutes } from './modules/library.js';
import { memberRoutes } from './modules/members.js';
import { developerRoutes } from './modules/developer.js';
import { eventRoutes } from './modules/events.js';
import { galleryRoutes } from './modules/galleries.js';
import { photoRoutes } from './modules/photos.js';
import { publicRoutes } from './modules/public.js';
import { statsRoutes } from './modules/stats.js';
import { userRoutes } from './modules/users.js';
import { websiteApiRoutes } from './modules/website-api.js';

export async function buildApp(ctx: AppContext, opts: { rateLimitMax?: number } = {}) {
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: ctx.config.TRUST_PROXY,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID(),
    bodyLimit: 1024 * 1024,
  });
  app.decorate('ctx', ctx);

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
    registers: [registry],
  });
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe({ method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: reply.statusCode }, reply.elapsedTime / 1000);
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  // CORS. Default: only our own web app, which may use cookies. CORS_ORIGINS=* lets any website call the API from a
  // browser, but never with cookies (browsers forbid "*" together with credentials, and we would not want any site to
  // act as a signed-in user): the public galleries and bearer-key website API need no credentials. A list of origins
  // is treated like the default (credentials allowed) because those sites are explicitly trusted.
  const webOrigin = new URL(ctx.config.PUBLIC_WEB_URL).origin;
  const corsList = ctx.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (corsList.includes('*')) {
    await app.register(cors, { origin: '*', credentials: false, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], maxAge: 600 });
  } else {
    const trusted = [webOrigin, ...corsList.map((o) => new URL(o).origin)];
    await app.register(cors, { origin: trusted, credentials: true, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], maxAge: 600 });
  }
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 1200,
    timeWindow: '1 minute',
    ...(ctx.redis && { redis: ctx.redis }),
    // Website credentials have their own per-key limits.
    allowList: (req) => req.url.startsWith('/api/v1/') || ['/health', '/ready', '/api/health', '/api/ready'].some((p) => req.url.startsWith(p)),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Validation failed', details: err.issues, requestId: req.id } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: status === 429 ? 'rate_limited' : 'bad_request', message: (err as Error).message, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found', requestId: req.id } }));

  // Health endpoints. `/health` = liveness (process is up); `/ready` = readiness (database + storage reachable).
  // Both are also served under /api so uptime monitors can use the public web or API domain.
  const readiness = async () => {
    const [db, storage] = await Promise.all([ctx.db.execute(sql`select 1`).then(() => true, () => false), ctx.storage.ping()]);
    return { ok: db && storage, body: { status: db && storage ? 'ready' : 'unavailable', db, storage } };
  };
  for (const prefix of ['', '/api']) {
    app.get(`${prefix}/health`, async () => ({ status: 'ok' }));
    app.get(`${prefix}/ready`, async (_req, reply) => {
      const r = await readiness();
      return reply.code(r.ok ? 200 : 503).send(r.body);
    });
  }
  app.get('/metrics', async (req, reply) => {
    const token = ctx.config.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send();
    reply.type(registry.contentType);
    return registry.metrics();
  });

  const usage = new UsageRecorder(ctx.db, ctx.log);
  if (ctx.config.NODE_ENV !== 'test') usage.start();
  app.addHook('onClose', async () => usage.stop());

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(eventRoutes);
      await api.register(galleryRoutes);
      await api.register(libraryRoutes);
      await api.register(memberRoutes);
      await api.register(collectionRoutes);
      await api.register(photoRoutes);
      await api.register(publicRoutes);
      await api.register(clientRoutes, { usage });
      await api.register(developerRoutes);
      await api.register(adminRoutes);
      await api.register(statsRoutes);
      await api.register(websiteApiRoutes, { usage });
    },
    { prefix: '/api' },
  );

  return Object.assign(app, { usage });
}
