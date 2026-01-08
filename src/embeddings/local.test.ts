import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("local embeddings", () => {
  const originalEnv = process.env.EMBEDDING_MODEL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.EMBEDDING_MODEL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMBEDDING_MODEL = originalEnv;
    } else {
      delete process.env.EMBEDDING_MODEL;
    }
  });

  describe("getLocalDimensions", () => {
    it("should return 384 for default model", async () => {
      const { getLocalDimensions } = await import("./local.js");
      expect(getLocalDimensions()).toBe(384);
    });

    it("should return 1024 for bge-m3 model", async () => {
      process.env.EMBEDDING_MODEL = "Xenova/bge-m3";
      const { getLocalDimensions } = await import("./local.js");
      expect(getLocalDimensions()).toBe(1024);
    });

    it("should return default for unknown model", async () => {
      process.env.EMBEDDING_MODEL = "unknown/model";
      const { getLocalDimensions } = await import("./local.js");
      expect(getLocalDimensions()).toBe(384); // DEFAULT_LOCAL_EMBEDDING_DIMS
    });
  });

  describe("getLocalModelName", () => {
    it("should return default model when env not set", async () => {
      const { getLocalModelName } = await import("./local.js");
      expect(getLocalModelName()).toBe("Xenova/multilingual-e5-small");
    });

    it("should return env model when set", async () => {
      process.env.EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
      const { getLocalModelName } = await import("./local.js");
      expect(getLocalModelName()).toBe("Xenova/all-MiniLM-L6-v2");
    });
  });

  describe("isModelLoaded", () => {
    it("should return false before first embedding call", async () => {
      const { isModelLoaded } = await import("./local.js");
      expect(isModelLoaded()).toBe(false);
    });
  });

  describe("getLocalEmbedding", () => {
    it("should throw on empty text", async () => {
      const { getLocalEmbedding } = await import("./local.js");
      await expect(getLocalEmbedding("")).rejects.toThrow("non-empty string");
    });

    it("should throw on non-string input", async () => {
      const { getLocalEmbedding } = await import("./local.js");
      // @ts-expect-error - testing runtime validation
      await expect(getLocalEmbedding(null)).rejects.toThrow("non-empty string");
    });
  });
});
