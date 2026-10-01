import type { User } from '../db/schema.js';

export const PERMISSIONS = [
  'events:view',
  'events:create',
  'events:edit',
  'events:publish',
  'images:upload',
  'galleries:manage',
  'media:edit',
  'collections:manage',
  'stats:view',
  'images:download',
  'users:manage',
  'websites:manage',
  'api:manage',
  'images:delete',
  'events:delete',
  'settings:manage',
  'audit:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that can never be held by a non-admin, regardless of what an
 * administrator grants. This is the "critical operations stay protected" rule.
 */
export const ADMIN_ONLY: ReadonlySet<Permission> = new Set([
  'users:manage',
  'websites:manage',
  'api:manage',
  'images:delete',
  'events:delete',
  'settings:manage',
  'audit:view',
]);

export const PHOTOGRAPHER_DEFAULTS: readonly Permission[] = [
  'events:view',
  'events:create',
  'events:edit',
  'events:publish',
  'images:upload',
  'galleries:manage',
  'media:edit',
  'stats:view',
  'images:download',
];

/**
 * Editors curate: they see every event, create events and invite photographers to them, rename events and media, edit
 * descriptions and tags, organise galleries and manage collections. They cannot upload, publish, delete, or touch users,
 * websites or settings.
 */
export const EDITOR_DEFAULTS: readonly Permission[] = [
  'events:view',
  'events:create',
  'events:edit',
  'galleries:manage',
  'media:edit',
  'collections:manage',
  'stats:view',
  'images:download',
];

export const defaultsFor = (role: 'admin' | 'editor' | 'photographer'): readonly Permission[] =>
  role === 'admin' ? PERMISSIONS : role === 'editor' ? EDITOR_DEFAULTS : PHOTOGRAPHER_DEFAULTS;

/** Admins and editors work across every photographer's events; photographers only see their own. */
export const seesAllEvents = (user: Pick<User, 'role'>) => user.role === 'admin' || user.role === 'editor';

/** Grantable to a photographer on top of defaults (everything not ADMIN_ONLY). */
export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY.has(p));

type Subject = Pick<User, 'role' | 'status' | 'permissions' | 'revokedPermissions'>;

export function effectivePermissions(user: Subject): Set<Permission> {
  if (user.status !== 'active') return new Set();
  if (user.role === 'admin') return new Set(PERMISSIONS);
  const set = new Set<Permission>(defaultsFor(user.role));
  for (const p of user.permissions) if (isGrantable(p)) set.add(p);
  for (const p of user.revokedPermissions) set.delete(p as Permission);
  return set;
}

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

export function isGrantable(p: string): p is Permission {
  return isPermission(p) && !ADMIN_ONLY.has(p);
}

export function can(user: Subject, permission: Permission): boolean {
  return effectivePermissions(user).has(permission);
}
