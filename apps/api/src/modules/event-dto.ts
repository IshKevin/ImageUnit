import type { Event } from '../db/schema.js';
import { isPubliclyAvailable } from '../lib/access.js';

export function eventDto(e: Event, webUrl: string, extra: Record<string, unknown> = {}) {
  const { accessPasswordHash, ...rest } = e;
  return {
    ...rest,
    hasPassword: !!accessPasswordHash,
    isPubliclyAvailable: isPubliclyAvailable(e),
    shareUrl: `${webUrl}/e/${e.slug}`,
    ...extra,
  };
}
