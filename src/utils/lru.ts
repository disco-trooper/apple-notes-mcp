/**
 * Minimal LRU cache on top of Map insertion order.
 */
export class LRUCache<K, V> {
  private readonly cache = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error(`LRUCache maxSize must be a positive integer, got ${maxSize}`);
    }
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Re-insert to mark as most recently used
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value as K;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
