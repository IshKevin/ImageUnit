import type { Event, Gallery, Photo } from '../db/schema.js';

type Policy = 'disabled' | 'preview' | 'full';
const RANK: Record<Policy, number> = { disabled: 0, preview: 1, full: 2 };

/** True when the public may see the event right now. Checked at read time, so it never depends on a cron job having run. */
export function isPubliclyAvailable(event: Pick<Event, 'status' | 'expiresAt'>, now = new Date()): boolean {
  return event.status === 'active' && (!event.expiresAt || event.expiresAt > now);
}

/** Galleries and photos may restrict the event policy but can never widen it. */
export function effectiveDownloadPolicy(
  event: Pick<Event, 'downloadPolicy'>,
  gallery?: Pick<Gallery, 'downloadPolicy'> | null,
  photo?: Pick<Photo, 'downloadPolicy'> | null,
): Policy {
  const layers: Policy[] = [event.downloadPolicy, gallery?.downloadPolicy ?? event.downloadPolicy, photo?.downloadPolicy ?? event.downloadPolicy];
  return layers.reduce((min, p) => (RANK[p] < RANK[min] ? p : min));
}

export const DEFAULT_ACCESS_DAYS = 30;
