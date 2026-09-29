/** Retries a startup dependency (database, storage) so boot order and brief outages don't crash the process. */
export async function retry<T>(name: string, fn: () => Promise<T>, opts: { attempts?: number; delayMs?: number; log?: (msg: string) => void } = {}): Promise<T> {
  const { attempts = 30, delayMs = 2000, log = console.warn } = opts;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log(`${name} not ready (attempt ${i}/${attempts}): ${(err as Error).message || (err as Error).name}. Retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
