/**
 * Module-level stale-while-revalidate cache for session detail data.
 * Allows instant render on repeated visits to the same session.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionDetailData = any;

interface CacheEntry {
  data: SessionDetailData;
  ts: number;
}

const MAX_CACHED = 25;
const cache = new Map<string, CacheEntry>();

export function getCachedSession(id: string): SessionDetailData | null {
  return cache.get(id)?.data ?? null;
}

export function setCachedSession(id: string, data: SessionDetailData): void {
  // Evict oldest entry if at capacity
  if (cache.size >= MAX_CACHED && !cache.has(id)) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(id, { data, ts: Date.now() });
}
