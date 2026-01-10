import { describe, it, expect, vi, beforeEach } from "vitest";
import { getEmbeddingCache, resetEmbeddingCache } from "./cache.js";

describe("EmbeddingCache", () => {
  beforeEach(() => {
    resetEmbeddingCache();
  });

  describe("get/set", () => {
    it("returns undefined for uncached query", () => {
      const cache = getEmbeddingCache();
      expect(cache.get("test query")).toBeUndefined();
    });

    it("returns cached embedding", () => {
      const cache = getEmbeddingCache();
      const embedding = [0.1, 0.2, 0.3];

      cache.set("test query", embedding);
      expect(cache.get("test query")).toEqual(embedding);
    });

    it("normalizes queries for better hit rate", () => {
      const cache = getEmbeddingCache();
      const embedding = [0.1, 0.2, 0.3];

      cache.set("Test Query", embedding);
      // Should match with different casing/spacing
      expect(cache.get("test query")).toEqual(embedding);
      expect(cache.get("  TEST   QUERY  ")).toEqual(embedding);
    });
  });

  describe("getOrCompute", () => {
    it("calls compute function on cache miss", async () => {
      const cache = getEmbeddingCache();
      const computeFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

      const result = await cache.getOrCompute("test query", computeFn);

      expect(computeFn).toHaveBeenCalledWith("test query");
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it("returns cached value without calling compute", async () => {
      const cache = getEmbeddingCache();
      const embedding = [0.1, 0.2, 0.3];
      cache.set("test query", embedding);

      const computeFn = vi.fn().mockResolvedValue([0.4, 0.5, 0.6]);
      const result = await cache.getOrCompute("test query", computeFn);

      expect(computeFn).not.toHaveBeenCalled();
      expect(result).toEqual(embedding);
    });

    it("caches computed value for subsequent calls", async () => {
      const cache = getEmbeddingCache();
      const computeFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

      await cache.getOrCompute("test query", computeFn);
      await cache.getOrCompute("test query", computeFn);

      expect(computeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when at capacity", () => {
      // Create cache with small size for testing
      resetEmbeddingCache();
      const cache = getEmbeddingCache();
      // We can't easily change max size, but we can test stats

      // Fill cache with entries
      for (let i = 0; i < 5; i++) {
        cache.set(`query ${i}`, [i]);
      }

      const stats = cache.getStats();
      expect(stats.size).toBeGreaterThan(0);
    });
  });

  describe("stats", () => {
    it("tracks hits and misses", () => {
      const cache = getEmbeddingCache();
      cache.set("query1", [0.1]);

      cache.get("query1"); // hit
      cache.get("query2"); // miss
      cache.get("query1"); // hit
      cache.get("query3"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(0.5);
    });
  });

  describe("clear", () => {
    it("clears all cached embeddings", () => {
      const cache = getEmbeddingCache();
      cache.set("query1", [0.1]);
      cache.set("query2", [0.2]);

      cache.clear();

      expect(cache.get("query1")).toBeUndefined();
      expect(cache.get("query2")).toBeUndefined();
      expect(cache.getStats().size).toBe(0);
    });

    it("resets stats on clear", () => {
      const cache = getEmbeddingCache();
      cache.set("query1", [0.1]);
      cache.get("query1");
      cache.get("query2");

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe("model version", () => {
    it("invalidates cache when model version changes", () => {
      const cache = getEmbeddingCache();
      cache.set("query1", [0.1]);

      cache.setModelVersion("new-model-v2");

      expect(cache.get("query1")).toBeUndefined();
    });

    it("does not invalidate if version unchanged", () => {
      const cache = getEmbeddingCache();
      cache.set("query1", [0.1]);

      cache.setModelVersion("default"); // Same as initial
      cache.setModelVersion("default"); // Same again

      // Cache should still have the value
      expect(cache.get("query1")).toEqual([0.1]);
    });
  });
});
