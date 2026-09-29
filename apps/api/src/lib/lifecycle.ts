import type { Event } from '../db/schema.js';
import { conflict } from './errors.js';

type Status = Event['status'];

/**
 * Event lifecycle. Expiry only disables public access; media is retained until an
 * administrator permanently deletes an archived event.
 */
const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['active', 'archived'],
  active: ['draft', 'expired', 'archived'],
  expired: ['active', 'archived'],
  archived: ['active', 'scheduled_for_deletion'],
  scheduled_for_deletion: ['archived', 'active'],
};

export function assertTransition(from: Status, to: Status) {
  if (!TRANSITIONS[from].includes(to)) throw conflict(`An event cannot move from "${from}" to "${to}"`);
}

export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to);
