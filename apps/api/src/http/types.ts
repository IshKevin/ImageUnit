import type { ApiClient, User } from '../db/schema.js';
import type { AppContext } from '../context.js';
import type { Permission } from '../lib/permissions.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user?: User;
    sessionId?: string;
    apiClient?: ApiClient;
    perms?: Set<Permission>;
  }
}
