import type { ApiClient, User } from '../db/schema.js';
import { effectivePermissions } from '../lib/permissions.js';

export const userDto = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  permissions: [...effectivePermissions({ ...u, status: 'active' })],
  grantedPermissions: u.permissions,
  revokedPermissions: u.revokedPermissions,
  storageQuotaBytes: u.storageQuotaBytes,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

export const clientDto = (c: ApiClient) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  keyPrefix: c.keyPrefix,
  scopes: c.scopes,
  allowedEventIds: c.allowedEventIds,
  allowedOrigins: c.allowedOrigins,
  rateLimitPerMinute: c.rateLimitPerMinute,
  status: c.status,
  lastUsedAt: c.lastUsedAt,
  revokedAt: c.revokedAt,
  createdAt: c.createdAt,
});
