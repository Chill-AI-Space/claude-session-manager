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

const MAX_CACHED = 10;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, CacheEntry>();

export function getCachedSession(id: string): SessionDetailData | null {
  const entry = cache.get(id);
  if (!entry) return null;
  // Expire stale entries
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(id);
    return null;
  }
  return entry.data;
}

export function setCachedSession(id: string, data: SessionDetailData): void {
  // Evict expired entries first
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > TTL_MS) cache.delete(k);
  }
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
  cache.set(id, { data, ts: now });
}
