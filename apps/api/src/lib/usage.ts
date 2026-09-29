import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiClients, apiUsageDaily } from '../db/schema.js';

/** Buffers per-client counters in memory and writes them in bulk, keeping the request path free of writes. */
export class UsageRecorder {
  private buf = new Map<string, { requests: number; errors: number; bytes: number }>();
  private timer?: NodeJS.Timeout;

  constructor(private db: Db, private log: { error: (o: unknown, m: string) => void }) {}

  start(intervalMs = 10_000) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  record(clientId: string, o: { error?: boolean; bytes?: number } = {}) {
    const cur = this.buf.get(clientId) ?? { requests: 0, errors: 0, bytes: 0 };
    cur.requests += 1;
    if (o.error) cur.errors += 1;
    cur.bytes += o.bytes ?? 0;
    this.buf.set(clientId, cur);
  }

  /** Counts an error against a request that was already recorded. */
  recordError(clientId: string) {
    const cur = this.buf.get(clientId) ?? { requests: 0, errors: 0, bytes: 0 };
    cur.errors += 1;
    this.buf.set(clientId, cur);
  }

  async flush() {
    if (this.buf.size === 0) return;
    const batch = this.buf;
    this.buf = new Map();
    const day = new Date().toISOString().slice(0, 10);
    for (const [clientId, v] of batch) {
      try {
        await this.db
          .insert(apiUsageDaily)
          .values({ clientId, day, requests: v.requests, errors: v.errors, bytesServed: v.bytes })
          .onConflictDoUpdate({
            target: [apiUsageDaily.clientId, apiUsageDaily.day],
            set: {
              requests: sql`${apiUsageDaily.requests} + ${v.requests}`,
              errors: sql`${apiUsageDaily.errors} + ${v.errors}`,
              bytesServed: sql`${apiUsageDaily.bytesServed} + ${v.bytes}`,
            },
          });
        await this.db.update(apiClients).set({ lastUsedAt: new Date() }).where(sql`${apiClients.id} = ${clientId}`);
      } catch (err) {
        this.log.error({ err }, 'usage flush failed');
      }
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
