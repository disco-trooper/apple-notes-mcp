import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as LocalModule from "./local.js";
import type * as OpenRouterModule from "./openrouter.js";

// Keep real model/dimension config; stub only the calls that embed.
vi.mock("./local.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LocalModule>()),
  getLocalEmbedding: vi.fn(async () => [0.1]),
  getLocalEmbeddingBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1])),
}));
vi.mock("./openrouter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenRouterModule>()),
  getOpenRouterEmbedding: vi.fn(async () => [0.2]),
  getOpenRouterEmbeddingBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.2])),
}));

import { getLocalEmbedding } from "./local.js";
import { getOpenRouterEmbedding } from "./openrouter.js";
import { getEmbedding, getEmbeddingDimensions, getProviderDescription, getQueryEmbedding } from "./index.js";

const ENV_KEYS = ["OPENROUTER_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIMS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe("embeddings index", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.mocked(getLocalEmbedding).mockClear();
    vi.mocked(getOpenRouterEmbedding).mockClear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("embeds documents with the passage role and queries with the query role", async () => {
    await getEmbedding("note body");
    await getQueryEmbedding("unique role query");

    expect(getLocalEmbedding).toHaveBeenNthCalledWith(1, "note body", "passage");
    expect(getLocalEmbedding).toHaveBeenNthCalledWith(2, "unique role query", "query");
  });

  it("caches query embeddings across whitespace variants", async () => {
    await getQueryEmbedding("cached   query ");
    await getQueryEmbedding("cached query");

    expect(getLocalEmbedding).toHaveBeenCalledTimes(1);
    expect(getLocalEmbedding).toHaveBeenCalledWith("cached query", "query");
  });

  it("does not reuse cached query embeddings across models", async () => {
    await getQueryEmbedding("model switch query");
    process.env.EMBEDDING_MODEL = "Xenova/bge-m3";
    await getQueryEmbedding("model switch query");

    expect(getLocalEmbedding).toHaveBeenCalledTimes(2);
  });

  it("selects the provider at call time", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await getQueryEmbedding("provider query");

    expect(getOpenRouterEmbedding).toHaveBeenCalledWith("provider query");
    expect(getLocalEmbedding).not.toHaveBeenCalled();
  });

  it("uses the local provider when OPENROUTER_API_KEY is blank", async () => {
    process.env.OPENROUTER_API_KEY = "  \t ";

    await getEmbedding("blank key doc");

    expect(getLocalEmbedding).toHaveBeenCalledWith("blank key doc", "passage");
    expect(getOpenRouterEmbedding).not.toHaveBeenCalled();
    expect(getProviderDescription()).toMatch(/^Local /);
  });

  it("describes the active provider, model and dimensions", () => {
    expect(getProviderDescription()).toBe("Local (Xenova/multilingual-e5-small, 384 dims)");
    expect(getEmbeddingDimensions()).toBe(384);

    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.EMBEDDING_MODEL = "custom/model";
    process.env.EMBEDDING_DIMS = "1536";
    expect(getProviderDescription()).toBe("OpenRouter (custom/model, 1536 dims)");
    expect(getEmbeddingDimensions()).toBe(1536);
  });
});
