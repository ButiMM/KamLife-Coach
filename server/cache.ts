/**
 * In-process TTL cache — eliminates repeated DB queries for hot data.
 * Single Railway instance: in-memory is sufficient and zero-latency.
 * Upgrade path: swap internals for ioredis when multi-instance scaling needed.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  size(): number {
    return this.store.size;
  }
}

// 1-hour cache for buildPatternSummary() — invalidated on new log entries
export const patternCache = new TTLCache<string>();
export const PATTERN_CACHE_TTL_MS = 60 * 60 * 1000;

// Cleanup stale entries every 15 minutes
setInterval(() => {
  patternCache.cleanup();
}, 15 * 60 * 1000).unref();

export function invalidatePatternCache(userId: string): void {
  patternCache.delete(`pattern:${userId}`);
}
