/**
 * Tiny TTL memo with single-flight.
 *
 * The dashboard asks for everything at once, and several of those reads are
 * genuinely expensive (the model calibration joins episodes against their price
 * paths). Without this, N browsers open at once means N identical heavy queries.
 *
 * `inflight` is what makes it single-flight: concurrent callers that arrive
 * during a miss all await the SAME promise instead of each starting their own
 * query. That is the difference between a cache and a thundering herd with a
 * cache in front of it.
 */
type Entry<T> = { value: T; at: number };

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, at: Date.now() });
      return value;
    } catch (e) {
      // Serve stale rather than failing the whole dashboard for one slow query.
      // A number a few minutes old beats an error panel.
      if (hit) return hit.value;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Drop a key so the next read recomputes - used after a write. */
export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
