import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pipe = vi.hoisted(() =>
  vi.fn(async (input: string | string[]) => {
    const inputs = Array.isArray(input) ? input : [input];
    return { tolist: () => inputs.map(() => [0.1, 0.2]) };
  })
);

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => pipe),
}));

import { getLocalDimensions, getLocalEmbedding, getLocalEmbeddingBatch } from "./local.js";

describe("local embeddings", () => {
  const originalEnv = process.env.EMBEDDING_MODEL;

  beforeEach(() => {
    pipe.mockClear();
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
    it("should return 384 for default model", () => {
      expect(getLocalDimensions()).toBe(384);
    });

    it("should return 1024 for bge-m3 model", () => {
      process.env.EMBEDDING_MODEL = "Xenova/bge-m3";
      expect(getLocalDimensions()).toBe(1024);
    });

    it("should return default for unknown model", () => {
      process.env.EMBEDDING_MODEL = "unknown/model";
      expect(getLocalDimensions()).toBe(384); // DEFAULT_LOCAL_EMBEDDING_DIMS
    });
  });

  describe("e5 role prefixes", () => {
    it("uses the query prefix only for query embeddings", async () => {
      await getLocalEmbedding("find me", "query");
      await getLocalEmbedding("note body");

      expect(pipe.mock.calls[0][0]).toBe("query: find me");
      expect(pipe.mock.calls[1][0]).toBe("passage: note body");
    });

    it("uses the passage prefix for batch embeddings", async () => {
      await getLocalEmbeddingBatch(["a", "b"]);

      expect(pipe.mock.calls[0][0]).toEqual(["passage: a", "passage: b"]);
    });

    it("adds no prefix for non-e5 models", async () => {
      process.env.EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

      await getLocalEmbedding("find me", "query");

      expect(pipe.mock.calls[0][0]).toBe("find me");
    });
  });

  describe("getLocalEmbedding", () => {
    it("should throw on empty text", async () => {
      await expect(getLocalEmbedding("")).rejects.toThrow("non-empty string");
    });
  });
});
