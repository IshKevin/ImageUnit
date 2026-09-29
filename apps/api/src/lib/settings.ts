import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '../db/client.js';
import { settings } from '../db/schema.js';

export const platformSettingsSchema = z.object({
  /** Days a newly published event stays publicly accessible. */
  defaultAccessDays: z.number().int().min(1).max(3650).default(30),
  /** Months an archived event is kept before it is flagged for administrator deletion review. */
  archiveRetentionMonths: z.number().int().min(1).max(240).default(12),
  /** Days before expiry that photographers are warned. */
  expiryWarningDays: z.number().int().min(1).max(90).default(3),
  /** Percentage of total storage at which administrators are alerted. */
  storageAlertPercent: z.number().int().min(50).max(99).default(85),
  /** Percentage of a photographer quota at which they are alerted. */
  quotaAlertPercent: z.number().int().min(50).max(99).default(90),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

const KEY = 'platform';

export async function getSettings(db: Db): Promise<PlatformSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return platformSettingsSchema.parse(row?.value ?? {});
}

export async function saveSettings(db: Db | Tx, value: PlatformSettings) {
  await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}
