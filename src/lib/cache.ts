import { createHash } from "node:crypto";
import { config } from "./config";
import { getDb } from "./db";

/**
 * Small key-value cache with expiry, kept in SQLite so it survives restarts and redeploys.
 * Only for public data (web, Wikipedia and arXiv results): entries are shared by every user,
 * so never put a user's documents or reports in here. Swapping this file for Redis would
 * leave every caller unchanged.
 */

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
    `);
    ready = true;
  }
  return d;
}

/** Hashed so long queries make short keys; the readable prefix keeps the table inspectable. */
function hashKey(namespace: string, parts: unknown[]): string {
  return `${namespace}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Same query modulo case and spacing hits the same entry. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function cacheGet<T>(namespace: string, parts: unknown[], now = Date.now()): T | undefined {
  const row = db()
    .prepare("SELECT value FROM cache_entries WHERE key = ? AND expires_at > ?")
    .get(hashKey(namespace, parts), now) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function cacheSet(namespace: string, parts: unknown[], value: unknown, ttlMs: number, now = Date.now()) {
  if (ttlMs <= 0) return;
  const d = db();
  d.prepare(
    "INSERT INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  ).run(hashKey(namespace, parts), JSON.stringify(value), now + ttlMs);
  // Keep the table small without a timer.
  if (Math.random() < 0.02) d.prepare("DELETE FROM cache_entries WHERE expires_at <= ?").run(now);
}

/**
 * Read-through cache for a search call. Empty results are not stored, so a provider that
 * returned nothing (or was down) is asked again next time. Cache failures never fail the search.
 */
export async function cachedSearch<T>(
  namespace: string,
  parts: unknown[],
  fetcher: () => Promise<T[]>,
): Promise<{ value: T[]; cached: boolean }> {
  const ttlMs = config.cache.searchTtlHours * 60 * 60 * 1000;
  if (ttlMs > 0) {
    try {
      const hit = cacheGet<T[]>(namespace, parts);
      if (hit) return { value: hit, cached: true };
    } catch (err) {
      console.warn("[cache] read failed", err);
    }
  }
  const value = await fetcher();
  if (ttlMs > 0 && value.length) {
    try {
      cacheSet(namespace, parts, value, ttlMs);
    } catch (err) {
      console.warn("[cache] write failed", err);
    }
  }
  return { value, cached: false };
}

/** Least-recently-used map held in memory, for small values that are cheap to recompute. */
export class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to mark as most recently used (Maps iterate in insertion order).
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    if (this.max <= 0) return;
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}
