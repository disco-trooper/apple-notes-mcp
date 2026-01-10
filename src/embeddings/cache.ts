/**
 * LRU Cache for query embeddings.
 * Dramatically speeds up hybrid search by caching repeated queries.
 */

import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("EMBED_CACHE");

/**
 * Simple LRU Cache implementation for embeddings.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Normalize query for better cache hit rate.
 * - Lowercase
 * - Trim whitespace
 * - Collapse multiple spaces
 */
function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

/**
 * Embedding cache with LRU eviction.
 */
class EmbeddingCache {
  private cache: LRUCache<string, number[]>;
  private modelVersion: string;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 1000, modelVersion = "default") {
    this.cache = new LRUCache(maxSize);
    this.modelVersion = modelVersion;
    debug(`Embedding cache initialized (max: ${maxSize})`);
  }

  /**
   * Create cache key from query and model version.
   */
  private makeKey(query: string): string {
    const normalized = normalizeQuery(query);
    return `${this.modelVersion}:${normalized}`;
  }

  /**
   * Get cached embedding for query.
   * Returns undefined if not cached.
   */
  get(query: string): number[] | undefined {
    const key = this.makeKey(query);
    const cached = this.cache.get(key);

    if (cached) {
      this.hits++;
      debug(`Cache HIT for "${query.slice(0, 30)}..." (hits: ${this.hits})`);
      return cached;
    }

    this.misses++;
    return undefined;
  }

  /**
   * Store embedding in cache.
   */
  set(query: string, embedding: number[]): void {
    const key = this.makeKey(query);
    this.cache.set(key, embedding);
    debug(`Cached embedding for "${query.slice(0, 30)}..." (size: ${this.cache.size})`);
  }

  /**
   * Get or compute embedding using provided function.
   * This is the main API for cached embedding retrieval.
   */
  async getOrCompute(
    query: string,
    computeFn: (q: string) => Promise<number[]>
  ): Promise<number[]> {
    const cached = this.get(query);
    if (cached) {
      return cached;
    }

    const embedding = await computeFn(query);
    this.set(query, embedding);
    return embedding;
  }

  /**
   * Invalidate cache (e.g., when model changes).
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    debug("Cache cleared");
  }

  /**
   * Update model version and clear cache.
   */
  setModelVersion(version: string): void {
    if (version !== this.modelVersion) {
      debug(`Model version changed: ${this.modelVersion} -> ${version}`);
      this.modelVersion = version;
      this.clear();
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

// Singleton instance
let cacheInstance: EmbeddingCache | null = null;

/**
 * Get the embedding cache singleton.
 */
export function getEmbeddingCache(): EmbeddingCache {
  if (!cacheInstance) {
    // Max 1000 queries * ~1.5KB per embedding = ~1.5MB
    cacheInstance = new EmbeddingCache(1000);
  }
  return cacheInstance;
}

/**
 * Reset the cache (useful for testing).
 */
export function resetEmbeddingCache(): void {
  if (cacheInstance) {
    cacheInstance.clear();
  }
  cacheInstance = null;
}
